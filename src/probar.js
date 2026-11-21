// Probar IA (como el de Zapp): conversaciones de prueba guardadas en una base aparte (pruebas.db), con panel de
// análisis, etiquetas reales aplicadas en el sandbox, simulación de teléfono y fecha, «IA inicia» y forzar
// seguimientos. Nada sale hacia GHL, AimHarder ni ningún lead.
import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { knowledge } from './knowledge.js';
import { openDb, repo as crearRepo } from './db.js';
import { Setter } from './setter.js';
import { Etiquetador } from './etiquetas.js';
import { buscarSocioPorTelefono } from './aimharder/index.js';
import { reglaDe, textoPrevisto } from './followups.js';
import * as reglasSeg from './reglas.js';
import * as reportes from './reportes.js';
import * as documentos from './documentos.js';
import { leerAjustes } from './ajustes.js';
import fs from 'node:fs';
import { carpetaMedios, procesarSubida } from './medios.js';

const json = (t, d) => { try { return t ? JSON.parse(t) : d; } catch { return d; } };

/** GHL de mentira: apunta lo que se habría hecho en GHL. */
export class GhlCaptura {
  constructor() { this.salida = []; }
  async sendMessage({ texto }) { this.salida.push(texto); return { messageId: null }; }
  async sendTemplate({ variables }) { this.salida.push(`[plantilla] ${variables[0]}`); return {}; }
  async enviarAdjunto({ url }) { this.salida.push(`[GHL] adjunto: ${url}`); return { messageId: null }; }
  async enviarPorPlantilla({ texto }) { this.salida.push(`[plantilla de WhatsApp] ${texto}`); return { messageId: null }; }
  async addTags(_, t) { this.salida.push(`[GHL] etiquetas: ${t.join(', ')}`); }
  async removeTags(_, t) { this.salida.push(`[GHL] quita etiquetas: ${t.join(', ')}`); }
  async assign() {}
  async addNote() {}
  async getContact() { return { contact: {} }; }
}

export const rutaPruebas = () => process.env.PRUEBAS_DB_PATH || (config.dbPath === ':memory:' ? ':memory:' : path.join(path.dirname(config.dbPath), 'pruebas.db'));

/**
 * Router de Probar IA. Se monta en /admin/probar.
 * - repo: el repo real (para leer el catálogo de etiquetas y el índice de socios)
 * - pruebas: repo de la base de pruebas (se abre al primer uso si no se pasa)
 * - complete: sustituto del modelo (tests)
 */
export function routerProbar({ repo, pruebas: pruebasInicial, complete, ...opciones }) {
  const r = express.Router();
  let pruebasRepo = pruebasInicial;
  // Lo que gasta Sofía en las pruebas también se apunta en la base real, para que Consumo cuadre con la factura
  const pruebas = () => (pruebasRepo ??= crearRepo(openDb(rutaPruebas()), { espejo: { db: repo.db, campos: {} } }));
  const enCurso = new Set();

  const ahoraDe = (conv) => {
    const s = json(conv?.simulacion, {});
    return () => new Date(Date.now() + (Number(s.offset_ms) || 0));
  };

  /** Setter de sandbox para una conversación, con salida capturada. */
  function sandbox(conv) {
    const ghl = new GhlCaptura();
    const now = ahoraDe(conv);
    const avisar = async (t) => { ghl.salida.push(`[aviso equipo] ${t}`); };
    const etiquetas = new Etiquetador({ repo: pruebas(), catalogo: repo.db, ghl, avisar, now });
    const setter = new Setter({
      repo: pruebas(), ghl, avisar, complete, live: true, sleep: async () => {}, now, etiquetas, catalogo: repo.db, borradores: json(conv?.simulacion, {}).borradores || null, ...(opciones.medios?.setter ? { medios: opciones.medios.setter } : {}),
      aimharder: {
        buscarSocioPorTelefono: async (tel) => buscarSocioPorTelefono(repo, tel), // índice real, solo lectura
        prepararAlta: async () => ({ estado: 'simulada', detalle: 'chat de pruebas: no se guarda en AimHarder' }),
        fichaEnSede: async () => null,
      },
    });
    return { setter, ghl, etiquetas };
  }

  const resumen = (c) => {
    const db = pruebas().db;
    const n = db.prepare("SELECT count(*) n FROM messages WHERE conversation_id = ? AND autor IN ('lead', 'ia')").get(c.id).n;
    const ultimo = db.prepare('SELECT texto, autor, created_at FROM messages WHERE conversation_id = ? AND autor != ? ORDER BY id DESC LIMIT 1').get(c.id, 'sistema');
    return { id: c.id, nombre: c.nombre, canal: c.channel, fase: c.fase, sede: c.sede, tipo: c.tipo, mensajes: n, ultimo, created_at: c.created_at, updated_at: c.updated_at, simulacion: json(c.simulacion, {}) };
  };

  const detalle = (id) => {
    const db = pruebas().db;
    const c = pruebas().getConv(id);
    if (!c) return null;
    const ajustes = leerAjustes(repo);
    return {
      conv: { ...resumen(c), analisis: c.analisis, siguiente_paso: c.siguiente_paso, ultimo_turno: json(c.ultimo_turno, null), ai_paused: c.ai_paused, derivado: c.derivado, pause_reason: c.pause_reason, alta_estado: c.alta_estado, prueba_reservada: c.prueba_reservada, telefono: c.telefono },
      mensajes: db.prepare('SELECT id, autor, texto, tipo, adjunto, media_ruta IS NOT NULL tiene_medio, transcripcion, media_error, created_at FROM messages WHERE conversation_id = ? ORDER BY id').all(id),
      etiquetas: db.prepare('SELECT etiqueta_id id, origen, created_at puesta FROM conv_etiquetas WHERE conversation_id = ? ORDER BY created_at').all(id)
        .map((e) => ({ ...e, ...colorDe(e.id) })).filter((e) => e.nombre),
      altas: db.prepare('SELECT * FROM altas WHERE conversation_id = ? ORDER BY id DESC').all(id).map((a) => ({ ...a, datos: json(a.datos, {}) })),
      // Reglas que aplican a esta prueba: las de silencio, las de largo plazo (si lo ha aplazado), las de las
      // etiquetas que lleva y el recordatorio si ha pedido clase de prueba
      seguimientos: reglasSeg.listar(repo.db).filter((x) => x.canales.includes(c.channel)
        && (x.tipo === 'silencio' || (x.tipo === 'largo-plazo' && c.retomar) || (['cita', 'tras-cita'].includes(x.tipo) && c.prueba_fecha)
          || (x.tipo === 'etiqueta' && db.prepare('SELECT 1 FROM conv_etiquetas WHERE conversation_id = ? AND etiqueta_id = ?').get(id, x.etiquetaId))))
        .map((x) => ({ id: x.id, nombre: x.nombre, minutos: x.minutos, tipo: x.tipo, dias: x.dias, despuesDe: x.despuesDe, activo: x.activo, modo: x.modo })),
      prueba_fecha: c.prueba_fecha,
      instrucciones: Object.fromEntries(Object.keys(documentos.DOCS).map((doc) => {
        const b = json(c.simulacion, {}).borradores?.[doc]; const v = b ? documentos.obtener(repo.db, b) : documentos.enProduccion(repo.db, doc);
        return [doc, v ? { id: v.id, version: v.version, estado: v.estado } : null];
      })),
      retomar: json(c.retomar, null),
      ahora: ahoraDe(c)().toISOString(),
    };
  };
  // Nombre y color reales del catálogo (la base de pruebas no tiene etiquetas propias)
  const colorDe = (id) => { const e = repo.db.prepare('SELECT nombre, color FROM etiquetas WHERE id = ?').get(id); return e || {}; };

  const sistema = (id, textos) => {
    for (const t of textos) pruebas().addMessage({ conversation_id: id, autor: 'sistema', texto: t, created_at: new Date().toISOString() });
  };

  const sinModelo = (res) => (!config.ai.apiKey && !complete ? res.status(503).json({ error: 'Falta configurar la clave de Anthropic en el VPS.' }) : null);

  /** Ejecuta una acción del modelo sobre un chat de prueba, sin solapes y guardando los efectos. */
  async function turno(req, res, accion) {
    const c = pruebas().getConv(req.params.id);
    if (!c) return res.status(404).json({ error: 'Esa prueba ya no existe.' });
    if (sinModelo(res)) return;
    if (enCurso.has(c.id)) return res.status(409).json({ error: 'Sofía todavía está respondiendo.' });
    enCurso.add(c.id);
    const sb = sandbox(c);
    try {
      const out = await accion(c, sb);
      const ia = new Set(out?.mensajes || []);
      sistema(c.id, sb.ghl.salida.filter((x) => !ia.has(x)));
      if (out?.nota) sistema(c.id, [out.nota]);
      res.json(detalle(c.id));
    } catch (e) {
      console.error('Probar IA:', e.status || e.name, e.message);
      sistema(c.id, ['Error: el modelo de Sofía no ha podido responder.']);
      res.status(502).json({ error: 'El modelo de Sofía no ha podido responder.', ...detalle(c.id) });
    } finally {
      enCurso.delete(c.id);
    }
  }

  r.get('/conversaciones', (_req, res) => {
    res.json(pruebas().db.prepare('SELECT * FROM conversations ORDER BY datetime(updated_at) DESC').all().map(resumen));
  });

  r.post('/conversaciones', (req, res) => {
    const { canal = 'whatsapp', nombre = '', telefono = '', fecha = '' } = req.body || {};
    if (!['whatsapp', 'instagram'].includes(canal)) return res.status(400).json({ error: 'Canal no válido.' });
    const id = `prueba-${crypto.randomUUID().slice(0, 8)}`;
    const n = pruebas().db.prepare('SELECT count(*) n FROM conversations').get().n + 1;
    pruebas().upsertConv({ id, contact_id: id, channel: canal, nombre: String(nombre).trim().slice(0, 60) || `Prueba ${n}`, telefono: String(telefono).trim() || null });
    const simulacion = simular({ telefono, fecha });
    pruebas().updateConv(id, { simulacion: JSON.stringify(simulacion) });
    res.status(201).json(detalle(id));
  });

  r.get('/conversaciones/:id', (req, res) => {
    const d = detalle(req.params.id);
    return d ? res.json(d) : res.status(404).json({ error: 'Esa prueba ya no existe.' });
  });

  // Cambia nombre, teléfono simulado o fecha simulada
  r.patch('/conversaciones/:id', (req, res) => {
    const c = pruebas().getConv(req.params.id);
    if (!c) return res.status(404).json({ error: 'Esa prueba ya no existe.' });
    const b = req.body || {};
    const patch = {};
    if (typeof b.nombre === 'string' && b.nombre.trim()) patch.nombre = b.nombre.trim().slice(0, 60);
    if ('telefono' in b || 'fecha' in b) {
      const s = json(c.simulacion, {});
      const nueva = simular({ telefono: 'telefono' in b ? b.telefono : s.telefono, fecha: 'fecha' in b ? b.fecha : s.fecha });
      patch.simulacion = JSON.stringify(nueva);
      patch.telefono = nueva.telefono || null;
      patch.tipo = null; // vuelve a comprobar si es socio con el teléfono nuevo
    }
    if (b.borradores && typeof b.borradores === 'object') {
      const s0 = json(pruebas().getConv(c.id).simulacion, {});
      const bor = {};
      for (const doc of Object.keys(documentos.DOCS)) { const id = Number(b.borradores[doc]); if (id && documentos.obtener(repo.db, id)?.doc === doc) bor[doc] = id; }
      patch.simulacion = JSON.stringify({ ...(patch.simulacion ? JSON.parse(patch.simulacion) : s0), borradores: bor });
    }
    if (Object.keys(patch).length) pruebas().updateConv(c.id, patch);
    res.json(detalle(c.id));
  });

  r.post('/conversaciones/:id/mensaje', (req, res) => {
    const texto = typeof req.body?.texto === 'string' ? req.body.texto.trim() : '';
    if (!texto) return res.status(400).json({ error: 'Escribe un mensaje.' });
    return turno(req, res, async (c, { setter }) => {
      const r1 = await setter.onInbound({ conversationId: c.id, contactId: c.id, canal: c.channel, texto, nombre: c.nombre, telefono: c.telefono, messageId: crypto.randomUUID() });
      if (r1?.socio) return { nota: 'Detectado como socio (teléfono en AimHarder): Sofía no contesta y avisa al equipo.' };
      const conv = pruebas().getConv(c.id);
      if (conv.ai_paused || conv.derivado) return { nota: `Sofía no contesta: ${conv.pause_reason || 'IA pausada en este chat'}.` };
      if (r1?.ignorado) return { nota: `Sin respuesta: ${r1.ignorado}.` };
      pruebas().updateConv(c.id, { respond_at: null });
      return setter.responder(c.id);
    });
  });

  // Audio o imagen como si lo mandara el lead. Body: { datos (base64), mime, nombre, texto? }
  r.post('/conversaciones/:id/adjunto', async (req, res) => {
    let subida;
    try { subida = await procesarSubida(req.body || {}, opciones.medios); } catch (e) { return res.status(400).json({ error: e.message }); }
    const texto = typeof req.body?.texto === 'string' ? req.body.texto.trim() : '';
    return turno(req, res, async (c, { setter }) => {
      const r1 = await setter.onInbound({ conversationId: c.id, contactId: c.id, canal: c.channel, texto, nombre: c.nombre, telefono: c.telefono, messageId: crypto.randomUUID(), adjuntos: [], subida });
      if (subida.adjunto === 'audio') sistema(c.id, [subida.transcripcion ? `Transcripción: «${subida.transcripcion}»` : `No se ha podido transcribir el audio${subida.media_error ? ` (${subida.media_error})` : ''}.`]);
      if (r1?.socio) return { nota: 'Detectado como socio (teléfono en AimHarder): Sofía no contesta y avisa al equipo.' };
      const conv = pruebas().getConv(c.id);
      if (conv.ai_paused || conv.derivado) return { nota: `Sofía no contesta: ${conv.pause_reason || 'IA pausada en este chat'}.` };
      pruebas().updateConv(c.id, { respond_at: null });
      return setter.responder(c.id);
    });
  });

  r.get('/conversaciones/:id/media/:msg', (req, res) => {
    const m = pruebas().db.prepare('SELECT media_ruta, media_mime FROM messages WHERE id = ? AND conversation_id = ?').get(Number(req.params.msg), req.params.id);
    return enviarMedio(res, m, opciones.medios?.base);
  });

  // «IA inicia (outbound)»: Sofía escribe primero
  r.post('/conversaciones/:id/iniciar', (req, res) => turno(req, res, async (c, { setter }) => {
    if (!c.tipo) pruebas().updateConv(c.id, { tipo: 'captacion' });
    return setter.responder(c.id, { extraContexto: '# Tarea\nEl lead todavía no ha escrito: abre tú la conversación con un primer mensaje (flujo outbound).', motivo: 'outbound' });
  }));

  // Seguimiento de prueba como si hubiera vencido: fila simulada con la fecha prevista y, si es de largo plazo,
  // la fecha y el motivo que dio el lead. El texto se prepara una vez por estado del chat.
  const previas = new Map();
  const seguimientoSimulado = (c, regla) => {
    const ahora = ahoraDe(c)();
    const ret = json(c.retomar, null);
    const clase = c.prueba_fecha ? new Date(c.prueba_fecha) : null;
    if (['cita', 'tras-cita'].includes(regla.tipo) && clase) {
      return { id: null, conversation_id: c.id, regla_id: regla.id, tipo: 'cita', due_at: new Date(clase.getTime() + (regla.tipo === 'tras-cita' ? 1 : -1) * regla.minutos * 60000).toISOString(),
        contexto: JSON.stringify({ prueba: clase.toLocaleString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) }) };
    }
    const due = regla.tipo === 'largo-plazo'
      ? new Date(Math.max(ahora.getTime() + 3 * 864e5, ret?.fecha ? Date.parse(`${ret.fecha}T10:00:00Z`) : ahora.getTime() + (regla.dias || 21) * 864e5) + (regla.despuesDe ? (regla.dias || 30) * 864e5 : 0))
      : new Date(ahora.getTime() + regla.minutos * 60000);
    return { id: null, conversation_id: c.id, regla_id: regla.id, tipo: regla.tipo, due_at: due.toISOString(), contexto: regla.tipo === 'largo-plazo' ? JSON.stringify({ fecha: ret?.fecha || due.toISOString().slice(0, 10), motivo: ret?.motivo || '' }) : null };
  };
  const clavePrevia = (c, regla) => `${c.id}|${regla.id}|${pruebas().ultimoMensajeId(c.id)}`;

  r.post('/conversaciones/:id/seguimiento/:regla/previa', async (req, res) => {
    const c = pruebas().getConv(req.params.id);
    const regla = reglaDe(repo.db, req.params.regla);
    if (!c || !regla) return res.status(404).json({ error: 'No existe.' });
    if (sinModelo(res)) return;
    const k = clavePrevia(c, regla);
    if (!previas.has(k)) {
      if (previas.size > 300) for (const vieja of [...previas.keys()].slice(0, 150)) previas.delete(vieja); // no crece sin límite
      const sim = seguimientoSimulado(c, regla);
      const { setter } = sandbox(c);
      previas.set(k, (async () => ({ ...(await textoPrevisto(setter, sim)), due_at: sim.due_at }))().catch((e) => { previas.delete(k); throw e; }));
    }
    try { res.json(await previas.get(k)); } catch (e) { console.error('Probar previa:', e.message); res.status(502).json({ error: 'Sofía no ha podido preparar el texto.' }); }
  });

  // «Forzar» un seguimiento: envía ya el texto preparado (o lo prepara si no lo había)
  r.post('/conversaciones/:id/seguimiento', (req, res) => {
    const regla = reglaDe(repo.db, req.body?.regla);
    if (!regla) return res.status(400).json({ error: 'Seguimiento desconocido.' });
    return turno(req, res, async (c, { setter }) => {
      const k = clavePrevia(c, regla);
      const sim = seguimientoSimulado(c, regla);
      const previa = previas.has(k) ? await previas.get(k).catch(() => null) : null;
      const { texto, plantilla } = previa || (await textoPrevisto(setter, sim));
      previas.delete(k);
      if (!texto) return { nota: `Seguimiento «${regla.nombre}»: Sofía decide no enviarlo (no se cumple la condición).` };
      const burbujas = texto.split('\n').map((x) => x.trim()).filter(Boolean);
      await setter.enviar(pruebas().getConv(c.id), plantilla ? burbujas.slice(0, 1) : burbujas, plantilla ? regla.plantillaWhatsapp || {} : null);
      return { mensajes: plantilla ? [] : burbujas, nota: `Seguimiento «${regla.nombre}» enviado${plantilla ? ' por plantilla de WhatsApp' : ''}.` };
    });
  });

  r.post('/conversaciones/:id/etiquetas', async (req, res) => {
    const c = pruebas().getConv(req.params.id);
    if (!c) return res.status(404).json({ error: 'Esa prueba ya no existe.' });
    const sb = sandbox(c);
    const out = await sb.etiquetas.poner(c.id, Number(req.body?.etiqueta), 'manual');
    sistema(c.id, sb.ghl.salida);
    if (!out.puesta && out.motivo !== 'ya la lleva') return res.status(400).json({ error: `No se ha puesto: ${out.motivo}.` });
    res.json(detalle(c.id));
  });

  r.delete('/conversaciones/:id/etiquetas/:etq', async (req, res) => {
    const c = pruebas().getConv(req.params.id);
    if (!c) return res.status(404).json({ error: 'Esa prueba ya no existe.' });
    await sandbox(c).etiquetas.quitar(c.id, Number(req.params.etq));
    res.json(detalle(c.id));
  });

  // Reanudar a Sofía en la prueba (si una etiqueta o una derivación la pausó)
  r.post('/conversaciones/:id/reanudar', (req, res) => {
    if (!pruebas().getConv(req.params.id)) return res.status(404).json({ error: 'Esa prueba ya no existe.' });
    pruebas().updateConv(req.params.id, { ai_paused: 0, derivado: 0, pause_reason: null });
    res.json(detalle(req.params.id));
  });

  const borrar = (ids) => pruebas().db.transaction(() => {
    for (const id of ids) {
      // Los audios e imágenes de la prueba también se borran del disco
      const base = opciones.medios?.base || carpetaMedios();
      for (const m of pruebas().db.prepare('SELECT media_ruta FROM messages WHERE conversation_id = ? AND media_ruta IS NOT NULL').all(id)) {
        const abs = path.resolve(base, m.media_ruta);
        if (abs.startsWith(path.resolve(base) + path.sep)) for (const f of [abs, abs.replace(/\.[^.]+$/, '') + '.modelo.jpg']) fs.rmSync(f, { force: true });
      }
      for (const t of ['messages', 'scheduled', 'ai_runs', 'altas', 'conv_etiquetas']) pruebas().db.prepare(`DELETE FROM ${t} WHERE conversation_id = ?`).run(id);
      pruebas().db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    }
  })();

  r.delete('/conversaciones/:id', (req, res) => {
    if (enCurso.has(req.params.id)) return res.status(409).json({ error: 'Espera a que Sofía termine de responder.' });
    borrar([req.params.id]);
    res.json({ ok: true });
  });

  r.delete('/conversaciones', (_req, res) => {
    borrar(pruebas().db.prepare('SELECT id FROM conversations').all().map((c) => c.id).filter((id) => !enCurso.has(id)));
    res.json({ ok: true });
  });

  // Reportar una respuesta de Sofía en una prueba. Body: { message_id, que_fallo, que_esperaba?, texto_exacto? }
  r.post('/conversaciones/:id/reportar', (req, res) => {
    if (sinModelo(res)) return;
    const b = req.body || {};
    const msg = pruebas().db.prepare("SELECT id, texto FROM messages WHERE id = ? AND conversation_id = ? AND autor = 'ia'").get(Number(b.message_id), req.params.id);
    if (!msg) return res.status(404).json({ error: 'Ese mensaje no existe.' });
    try {
      const snap = reportes.instantanea(pruebas().db, req.params.id, msg.id);
      const id = reportes.crear(repo.db, { ...b, origen: 'prueba', conversation_id: req.params.id, message_id: msg.id, respuesta_ia: msg.texto, contexto: snap.mensajes, meta: snap.meta });
      opciones.analizarReporte?.(id);
      res.status(201).json({ id });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  r.get('/conversaciones/:id/exportar', (req, res) => {
    const d = detalle(req.params.id);
    if (!d) return res.status(404).json({ error: 'Esa prueba ya no existe.' });
    const conAnalisis = req.query.analisis !== '0';
    res.type('text/plain; charset=utf-8').set('Content-Disposition', `attachment; filename="prueba_sofia_${d.conv.canal}_${d.conv.id}.txt"`).send(exportar(d, conAnalisis));
  });

  return r;
}

/** Teléfono y fecha simulados. La fecha se guarda como desfase respecto a la hora real. */
export function simular({ telefono = '', fecha = '' } = {}) {
  const out = {};
  const tel = String(telefono || '').trim();
  if (tel) out.telefono = tel.slice(0, 20);
  if (fecha) {
    const f = new Date(fecha);
    if (!Number.isNaN(f.getTime())) { out.fecha = f.toISOString(); out.offset_ms = f.getTime() - Date.now(); }
  }
  return out;
}

const AUTOR = { lead: 'Lead', ia: 'Sofía', humano: 'Equipo', sistema: 'Sistema' };

/** Texto plano del test, para compartir o guardar. */
export function exportar(d, conAnalisis = true) {
  const c = d.conv;
  const linea = '='.repeat(60);
  const out = [
    `PRUEBA DE SOFÍA · ${c.canal.toUpperCase()}`, linea,
    `Nombre: ${c.nombre}`,
    `Fase: ${c.fase || '—'} · Sede: ${c.sede || '—'}`,
    `Etiquetas: ${d.etiquetas.map((e) => e.nombre).join(', ') || 'ninguna'}`,
  ];
  if (c.simulacion?.telefono) out.push(`Teléfono simulado: ${c.simulacion.telefono}`);
  if (c.simulacion?.fecha) out.push(`Fecha simulada: ${c.simulacion.fecha}`);
  if (conAnalisis) {
    if (c.analisis) out.push(`Análisis: ${c.analisis}`);
    if (c.siguiente_paso) out.push(`Siguiente paso: ${c.siguiente_paso}`);
  }
  out.push(linea, '');
  for (const m of d.mensajes) {
    if (m.autor === 'sistema' && !conAnalisis) continue;
    const h = new Date(m.created_at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });
    out.push(`[${h}] ${AUTOR[m.autor] || m.autor}: ${m.texto}`);
  }
  return out.join('\n') + '\n';
}

/** Envía un audio o imagen guardado (solo dentro de la carpeta de medios). */
export function enviarMedio(res, m, base = carpetaMedios()) {
  if (!m?.media_ruta) return res.status(404).json({ error: 'Sin archivo.' });
  const abs = path.resolve(base, m.media_ruta);
  if (!abs.startsWith(path.resolve(base) + path.sep) || !fs.existsSync(abs)) return res.status(404).json({ error: 'El archivo ya no está.' });
  res.set('Cache-Control', 'private, max-age=3600');
  if (m.media_mime) res.type(m.media_mime);
  return res.sendFile(abs);
}
