import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
import { config } from './config.js';
import { parseWebhook } from './ghl.js';
import { Setter } from './setter.js';
import path from 'node:path';
import { leerAjustes, guardarAjustes } from './ajustes.js';
import * as panel from './panel.js';
import { embudo, mesActual } from './embudo.js';
import { textoPrevisto, programarManual, cancelarCita, destinatarios, validarLanzamiento, cancelarLanzamiento } from './followups.js';
import * as reglasSeg from './reglas.js';
import * as reportes from './reportes.js';
import * as documentos from './documentos.js';
import * as recursosMod from './recursos.js';
import * as alertas from './alertas.js';
import * as meta from './meta.js';
import * as actividad from './actividad.js';
import { resumenInstrucciones } from './resumen.js';
import { carpetaMedios } from './medios.js';
import { openDb, repo as crearRepo } from './db.js';
import { routerProbar, GhlCaptura, enviarMedio } from './probar.js';
import * as etq from './etiquetas.js';

const panelPath = path.join(config.root, 'panel', 'index.html');
const metroPanel = readFileSync(panelPath, 'utf8').replace('<!-- metrotools-assets -->', `
<link rel="stylesheet" href="/metro-os/v4.4.0/metro-layout.css">
<script defer src="/metro-os/v4.4.0/metro-model.js"></script>
<script defer src="/metro-os/v4.4.0/metro-platform.js"></script>`);

const igual = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

export function crearApp({ setter, repo, complete, completeJSON, embudoOpciones, etiquetas = new etq.Etiquetador({ repo }), pruebas: pruebasRepo, medios, ghl = null }) {
  const app = express();
  // JSON pequeño en general; las subidas de audio/imagen de Probar IA van en base64 y necesitan más
  const jsonNormal = express.json({ limit: '1mb' }); const jsonGrande = express.json({ limit: '36mb' });
  app.use((req, res, next) => (req.path.endsWith('/adjunto') ? jsonGrande : jsonNormal)(req, res, next));
  const pruebas = crearRepo(openDb(':memory:'));
  const enCurso = new Set();

  app.get('/panel', (_req, res) => res.sendFile(panelPath));

  app.get('/health', (_req, res) => res.json({ ok: true, modo: config.mode }));

  // Recursos públicos para que GHL los descargue al enviarlos (código aleatorio; solo los activos)
  app.get('/r/:token', (req, res) => {
    const r = recursosMod.porToken(repo.db, String(req.params.token).replace(/\.[a-z0-9]+$/i, ''));
    if (!r) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=3600');
    return enviarMedio(res, { media_ruta: r.media_ruta, media_mime: r.mime }, medios?.base || carpetaMedios());
  });

  // Webhook de GHL (mensajes entrantes y salientes). Responde rápido; el trabajo se hace después.
  app.post('/webhooks/ghl', async (req, res) => {
    if (!igual(req.get('x-setter-secret'), config.webhookSecret)) return res.status(401).json({ error: 'secreto no válido' });
    if (!config.ghlWebhookEnabled) return res.status(503).json({ error: 'entrada de GHL desactivada' });
    const evt = parseWebhook(req.body);
    res.json({ recibido: true });
    try { await setter.handleWebhook(evt); } catch (e) { console.error('Webhook:', e); }
  });

  const admin = express.Router();
  admin.use((req, res, next) => (igual(req.get('authorization')?.replace(/^Bearer /, ''), config.adminToken) ? next() : res.status(401).json({ error: 'no autorizado' })));
  admin.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  });
  admin.use(actividad.middleware(repo.db));

  // Chat de pruebas: habla con Sofía sin tocar GHL ni a ningún lead. Body: { sesion, texto, canal?, nombre? }
  admin.post('/probar', async (req, res) => {
    const { sesion = 'demo', texto, canal = 'whatsapp', nombre = null } = req.body || {};
    if (typeof texto !== 'string' || !texto.trim()) return res.status(400).json({ error: 'Escribe un mensaje.' });
    if (!config.ai.apiKey && !complete) return res.status(503).json({ error: 'Falta configurar la clave de Anthropic en el VPS.' });
    const id = `prueba-${sesion}`;
    if (enCurso.has(id)) return res.status(409).json({ error: 'Sofía todavía está respondiendo.' });
    enCurso.add(id);
    const ghl = new GhlCaptura();
    const prueba = new Setter({
      repo: pruebas, ghl, avisar: async (t) => ghl.salida.push(`[aviso equipo] ${t}`), complete, live: true, sleep: async () => {},
      aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: false }), prepararAlta: async () => ({ estado: 'simulada', detalle: 'chat de pruebas' }) },
    });
    try {
      await prueba.onInbound({ conversationId: id, contactId: id, canal, texto, nombre, messageId: crypto.randomUUID() });
      const r = await prueba.responder(id);
      res.json({ mensajes: r?.mensajes || [], fase: r?.fase, sede: r?.sede, efectos: ghl.salida });
    } catch (e) {
      console.error('Error del modelo en el simulador:', e.status || e.name);
      res.status(502).json({ error: 'El modelo de Sofía no ha podido responder.' });
    } finally {
      enCurso.delete(id);
    }
  });

  admin.post('/probar/reiniciar', (req, res) => {
    const id = `prueba-${req.body?.sesion || 'demo'}`;
    if (enCurso.has(id)) return res.status(409).json({ error: 'Espera a que Sofía termine de responder.' });
    pruebas.db.transaction(() => {
      for (const table of ['messages', 'scheduled', 'ai_runs', 'altas']) pruebas.db.prepare(`DELETE FROM ${table} WHERE conversation_id = ?`).run(id);
      pruebas.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    })();
    res.json({ ok: true });
  });

  // Los reportes se analizan en segundo plano (varias llamadas al modelo); el panel va mirando el estado
  const analizarFondo = (id) => { reportes.analizar(repo.db, id, { complete, completeJSON }).catch((e) => console.error('Reporte:', e.message)); };
  const sinModelo = (res) => (!config.ai.apiKey && !complete ? (res.status(503).json({ error: 'Falta configurar la clave de Anthropic en el VPS.' }), true) : false);

  // Probar IA con conversaciones guardadas (pruebas.db)
  admin.use('/probar', routerProbar({ repo, pruebas: pruebasRepo, complete, medios, analizarReporte: (id) => analizarFondo(id) }));

  admin.get('/costes', (req, res) => res.json(repo.costes(Number(req.query.dias) || 7)));

  admin.post('/conversaciones/:id/reanudar', (req, res) => {
    repo.updateConv(req.params.id, { ai_paused: 0, derivado: 0, pause_reason: null });
    res.json({ ok: true });
  });

  // ---------- Panel ----------
  const db = repo.db;
  admin.get('/panel/estado', (_req, res) => res.json({
    modo: config.mode, modelo: config.ai.model, alta_en_pruebas: config.aimharder.altaDryRun,
    modelo_configurado: Boolean(config.ai.apiKey), entrada_ghl: config.ghlWebhookEnabled,
    credenciales_alta: Boolean(config.aimharder.adminUser && config.aimharder.adminPassword),
    ajustes: leerAjustes(repo), contadores: panel.contadores(db), alertas: alertas.abiertas(db).length,
  }));
  admin.get('/panel/resumen', (req, res) => res.json(panel.resumen(db, req.query.dias)));
  admin.get('/panel/embudo', async (req, res) => {
    const mes = String(req.query.mes || mesActual());
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) return res.status(400).json({ error: 'Mes no válido.' });
    res.json(await embudo(mes, embudoOpciones));
  });
  admin.get('/panel/conversaciones', (req, res) => res.json(panel.conversaciones(db, req.query)));
  // Audio o imagen de un mensaje (el panel lo pide con su cabecera de acceso y lo muestra)
  admin.get('/panel/conversaciones/:id/media/:msg', (req, res) => {
    const m = db.prepare('SELECT media_ruta, media_mime FROM messages WHERE id = ? AND conversation_id = ?').get(Number(req.params.msg), req.params.id);
    return enviarMedio(res, m);
  });
  admin.get('/panel/conversaciones/:id', (req, res) => {
    const d = panel.detalle(db, req.params.id);
    return d ? res.json(d) : res.status(404).json({ error: 'no existe' });
  });
  // ⚡ Forzar respuesta: Sofía contesta ya (respeta su horario)
  admin.post('/panel/conversaciones/:id/forzar', (req, res) => {
    const c = repo.getConv(req.params.id);
    if (!c) return res.status(404).json({ error: 'no existe' });
    if (c.ai_paused || c.derivado) return res.status(409).json({ error: 'Sofía está pausada en este chat: reactívala primero.' });
    if (!config.ghlWebhookEnabled) return res.status(409).json({ error: 'La entrada de GHL está apagada: Sofía no está atendiendo chats.' });
    repo.updateConv(c.id, { respond_at: new Date().toISOString() });
    res.json({ ok: true });
  });
  admin.post('/panel/conversaciones/:id/pausar', (req, res) => {
    if (!repo.getConv(req.params.id)) return res.status(404).json({ error: 'no existe' });
    repo.updateConv(req.params.id, { ai_paused: 1, pause_reason: 'pausada desde el panel', respond_at: null });
    repo.cancelScheduled(req.params.id, 'pausada desde el panel');
    res.json({ ok: true });
  });
  admin.post('/panel/conversaciones/:id/reanudar', (req, res) => {
    if (!repo.getConv(req.params.id)) return res.status(404).json({ error: 'no existe' });
    repo.updateConv(req.params.id, { ai_paused: 0, derivado: 0, pause_reason: null });
    res.json({ ok: true });
  });
  admin.get('/panel/altas', (_req, res) => res.json(panel.altas(db)));
  admin.get('/panel/seguimientos', (_req, res) => res.json(panel.seguimientos(db)));
  // Prepara (o devuelve) el texto que Sofía enviará en ese seguimiento
  admin.post('/panel/seguimientos/:id/previa', async (req, res) => {
    const s = db.prepare('SELECT * FROM scheduled WHERE id = ?').get(Number(req.params.id));
    if (!s) return res.status(404).json({ error: 'Ese seguimiento no existe.' });
    if (!setter?.redactar || (!config.ai.apiKey && !complete)) return res.status(503).json({ error: 'Falta configurar la clave de Anthropic en el VPS.' });
    try { res.json(await textoPrevisto(setter, s, { forzar: req.body?.rehacer === true })); } catch (e) { console.error('Previa seguimiento:', e.message); res.status(502).json({ error: 'Sofía no ha podido preparar el texto.' }); }
  });
  // ---------- Alertas del sistema ----------
  admin.get('/panel/alertas', (_req, res) => res.json({ abiertas: alertas.abiertas(db), recientes: alertas.recientes(db) }));
  admin.post('/panel/alertas/comprobar', async (_req, res) => res.json({ comprobaciones: await alertas.vigilar(db, { ghl: ghl || etiquetas.ghl }), abiertas: alertas.abiertas(db) }));
  admin.post('/panel/alertas/:id/resolver', (req, res) => res.json({ ok: alertas.cerrarAMano(db, Number(req.params.id)) }));

  admin.get('/panel/meta', (_req, res) => res.json({ configurado: meta.configurado(), modo: config.mode, prueba: Boolean(config.meta.testCode), eventos: meta.recientes(db), tipos: meta.EVENTOS }));

  // ---------- Recursos ----------
  admin.get('/panel/recursos', (_req, res) => res.json(recursosMod.listar(db).map((r) => ({ ...r, url: recursosMod.urlPublica(r) }))));
  admin.post('/panel/recursos/adjunto', (req, res) => { try { res.status(201).json(recursosMod.crear(db, req.body || {}, { base: medios?.base })); } catch (e) { errorUsuario(res, e); } });
  admin.put('/panel/recursos/:id', (req, res) => {
    try { const r = recursosMod.actualizar(db, Number(req.params.id), req.body || {}); return r ? res.json(r) : res.status(404).json({ error: 'No existe.' }); } catch (e) { errorUsuario(res, e); }
  });
  admin.delete('/panel/recursos/:id', (req, res) => res.json({ ok: recursosMod.borrar(db, Number(req.params.id), { base: medios?.base }) }));
  admin.get('/panel/recursos/:id/archivo', (req, res) => { const r = recursosMod.obtener(db, Number(req.params.id)); return enviarMedio(res, r && { media_ruta: r.media_ruta, media_mime: r.mime }, medios?.base || carpetaMedios()); });

  // ---------- Reportes ----------
  admin.get('/panel/reportes', (req, res) => res.json({
    reportes: reportes.listar(db, { estado: req.query.estado || null }),
    contadores: Object.fromEntries(db.prepare('SELECT estado, count(*) n FROM reportes GROUP BY estado').all().map((r) => [r.estado, r.n])),
    estados: reportes.ESTADOS,
  }));
  admin.get('/panel/reportes/:id', (req, res) => {
    const r = reportes.obtener(db, Number(req.params.id));
    return r ? res.json(r) : res.status(404).json({ error: 'Ese reporte no existe.' });
  });
  // Reporte de una respuesta de un chat real. Body: { message_id, que_fallo, que_esperaba?, texto_exacto? }
  admin.post('/panel/conversaciones/:id/reportar', (req, res) => {
    if (sinModelo(res)) return;
    const b = req.body || {};
    const msg = db.prepare("SELECT id, texto FROM messages WHERE id = ? AND conversation_id = ? AND autor = 'ia'").get(Number(b.message_id), req.params.id);
    if (!msg) return res.status(404).json({ error: 'Ese mensaje no existe.' });
    try {
      const snap = reportes.instantanea(db, req.params.id, msg.id);
      const id = reportes.crear(db, { ...b, origen: 'chat', conversation_id: req.params.id, message_id: msg.id, respuesta_ia: msg.texto, contexto: snap.mensajes, meta: snap.meta });
      analizarFondo(id);
      res.status(201).json({ id });
    } catch (e) { errorUsuario(res, e); }
  });
  // Reporte general (sin chat): algo que Sofía debería hacer distinto
  admin.post('/panel/reportes', (req, res) => {
    if (sinModelo(res)) return;
    try { const id = reportes.crear(db, { ...req.body, origen: 'general' }); analizarFondo(id); res.status(201).json({ id }); } catch (e) { errorUsuario(res, e); }
  });
  admin.post('/panel/reportes/:id/responder', (req, res) => {
    try { reportes.responder(db, Number(req.params.id), req.body?.respuesta); analizarFondo(Number(req.params.id)); res.json({ ok: true }); } catch (e) { errorUsuario(res, e); }
  });
  admin.post('/panel/reportes/:id/reanalizar', (req, res) => {
    if (sinModelo(res)) return;
    if (!reportes.obtener(db, Number(req.params.id))) return res.status(404).json({ error: 'Ese reporte no existe.' });
    analizarFondo(Number(req.params.id)); res.json({ ok: true });
  });
  admin.post('/panel/reportes/:id/aplicar', (req, res) => {
    try { res.json(reportes.aplicar(db, Number(req.params.id), { aunqueFallido: req.body?.aunque === true })); } catch (e) { errorUsuario(res, e); }
  });
  admin.post('/panel/reportes/:id/descartar', (req, res) => { reportes.descartar(db, Number(req.params.id)); res.json({ ok: true }); });

  // ---------- Instrucciones de Sofía (prompt y base de conocimiento, con versiones) ----------
  admin.get('/panel/estadisticas', (req, res) => res.json(panel.estadisticas(db, { dias: req.query.dias, sede: req.query.sede || '', canal: req.query.canal || '' })));
  admin.get('/panel/consumo', (req, res) => res.json(panel.consumo(db, { meses: req.query.meses })));
  admin.get('/panel/exportar', (req, res) => {
    const formato = req.query.formato === 'mensajes' ? 'mensajes' : 'chats';
    res.type('text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="sofia_${formato}_${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(panel.exportar(db, { criterios: req.query.criterios, q: req.query.q || '', formato }));
  });
  admin.get('/panel/actividad', (req, res) => res.json({ actividad: actividad.listar(db, { quien: req.query.quien || '' }), personas: actividad.personas(db) }));
  admin.post('/panel/instrucciones/resumen', async (req, res) => {
    if (sinModelo(res)) return;
    try { res.json(await resumenInstrucciones(db, { completeJSON, rehacer: req.body?.rehacer === true })); } catch (e) { console.error('Resumen:', e.message); res.status(502).json({ error: 'No se ha podido preparar el resumen.' }); }
  });
  admin.get('/panel/rendimiento', (req, res) => res.json(panel.rendimiento(db, req.query.dias)));
  admin.get('/panel/instrucciones', (_req, res) => res.json(Object.fromEntries(Object.entries(documentos.DOCS).map(([doc, d]) => [doc, { nombre: d.nombre, versiones: documentos.versiones(db, doc) }]))));
  admin.get('/panel/instrucciones/:id', (req, res) => {
    const d = documentos.obtener(db, Number(req.params.id));
    return d ? res.json(d) : res.status(404).json({ error: 'Esa versión no existe.' });
  });
  admin.post('/panel/instrucciones', (req, res) => {
    const b = req.body || {};
    try { res.status(201).json(documentos.crearVersion(db, b.doc, b.texto, { nota: b.nota || 'Editado desde el panel', autor: 'panel', produccion: b.produccion === true })); } catch (e) { errorUsuario(res, e); }
  });
  admin.post('/panel/instrucciones/:id/activar', (req, res) => { try { res.json(documentos.activar(db, Number(req.params.id))); } catch (e) { errorUsuario(res, e); } });

  // ---------- Reglas de seguimiento (editables) ----------
  admin.get('/panel/reglas', (_req, res) => res.json({ reglas: reglasSeg.listar(db), etiquetas: etq.listar(db).map(({ id, nombre, color }) => ({ id, nombre, color })) }));
  admin.post('/panel/reglas', (req, res) => { try { res.status(201).json(reglasSeg.crear(db, req.body || {})); } catch (e) { errorUsuario(res, e); } });
  admin.put('/panel/reglas/:id', (req, res) => {
    try { const r = reglasSeg.actualizar(db, req.params.id, req.body || {}); return r ? res.json(r) : res.status(404).json({ error: 'Esa regla no existe.' }); } catch (e) { errorUsuario(res, e); }
  });
  admin.delete('/panel/reglas/:id', (req, res) => res.json({ ok: reglasSeg.borrar(db, req.params.id) }));

  // Mensaje programado a mano desde un chat. Body: { texto, cuando (ISO) }
  admin.post('/panel/conversaciones/:id/programar', (req, res) => {
    try { res.status(201).json({ id: programarManual(repo, req.params.id, req.body?.texto, req.body?.cuando) }); } catch (e) { errorUsuario(res, e); }
  });
  // La clase de prueba se anula o se cambia: se cancelan sus recordatorios
  admin.post('/panel/conversaciones/:id/prueba/cancelar', (req, res) => {
    if (!repo.getConv(req.params.id)) return res.status(404).json({ error: 'no existe' });
    cancelarCita(repo, req.params.id);
    res.json({ ok: true });
  });

  // ---------- Lanzamientos ----------
  admin.post('/panel/lanzamientos/previa', (req, res) => {
    const b = req.body || {};
    const d = destinatarios(db, { dias_actividad: b.dias_actividad, canales: b.canales || [], excluir_etiquetas: b.excluir_etiquetas || [], solo_etiquetas: b.solo_etiquetas || [] });
    const fuera = d.filter((c) => !c.last_inbound_at || Date.now() - new Date(c.last_inbound_at) > 24 * 3600e3).length;
    res.json({ total: d.length, por_plantilla: fuera, ejemplo: d.slice(0, 8).map((c) => c.nombre || c.id) });
  });
  admin.post('/panel/lanzamientos', (req, res) => {
    let l; try { l = validarLanzamiento(req.body || {}); } catch (e) { return errorUsuario(res, e); }
    const r = db.prepare(`INSERT INTO lanzamientos (nombre, texto, programado_at, dias_actividad, canales, excluir_etiquetas, solo_etiquetas)
      VALUES (@nombre, @texto, @programado_at, @dias_actividad, @canales, @excluir_etiquetas, @solo_etiquetas)`).run(l);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  });
  admin.post('/panel/lanzamientos/:id/cancelar', (req, res) => res.json({ ok: cancelarLanzamiento(db, Number(req.params.id)) }));

  admin.post('/panel/seguimientos/:id/cancelar', (req, res) => {
    repo.finishScheduled(Number(req.params.id), 'cancelado', 'cancelado desde el panel');
    res.json({ ok: true });
  });
  // ---------- Etiquetas ----------
  const errorUsuario = (res, e) => res.status(400).json({ error: e.message });
  admin.get('/panel/etiquetas', (_req, res) => res.json({ etiquetas: etq.listar(db, { conUso: true }).map((e) => ({ ...e, reglas_texto: e.reglas.map(etq.describirRegla) })), colores: etq.COLORES }));
  // Catálogo sincronizado con GHL: crear o renombrar aquí crea o renombra el tag allí
  const enGhl = async (fn) => { if (!etiquetas.ghl) return null; try { await fn(); return 'ok'; } catch (e) { console.error('[etiquetas] catálogo GHL:', e.message); return 'error'; } };
  admin.post('/panel/etiquetas', async (req, res) => {
    let e;
    try { e = etq.crear(db, req.body || {}); } catch (err) { return errorUsuario(res, err); }
    res.status(201).json({ ...e, ghl: await enGhl(() => etq.asegurarTagGhl(etiquetas.ghl, e.nombre)) });
  });
  admin.get('/panel/etiquetas/ghl', async (_req, res) => {
    if (!etiquetas.ghl?.listarTags) return res.json({ tags: [] });
    try { res.json({ tags: await etq.tagsGhlSinImportar(etiquetas.ghl, db) }); } catch { res.status(502).json({ error: 'No se han podido leer las etiquetas de GHL.' }); }
  });
  admin.post('/panel/etiquetas/importar', async (req, res) => {
    const creadas = [];
    for (const n of (req.body?.nombres || []).slice(0, 100)) {
      try { creadas.push(etq.crear(db, { nombre: String(n).charAt(0).toUpperCase() + String(n).slice(1) }).nombre); } catch { /* ya existe o no válida */ }
    }
    const sync = creadas.length ? await etiquetas.sincronizarDesdeGhl({ dias: 90 }).catch(() => null) : null;
    res.json({ creadas, sync });
  });
  admin.post('/panel/etiquetas/sincronizar', async (_req, res) => {
    try { res.json(await etiquetas.sincronizarDesdeGhl({ dias: 90 })); } catch (e) { res.status(502).json({ error: 'No se ha podido sincronizar con GHL.' }); }
  });
  admin.put('/panel/etiquetas/orden', (req, res) => { etq.reordenar(db, (req.body?.ids || []).map(Number)); res.json({ ok: true }); });
  admin.put('/panel/etiquetas/:id', async (req, res) => {
    const antes = etq.obtener(db, Number(req.params.id));
    if (!antes) return res.status(404).json({ error: 'La etiqueta no existe.' });
    let e;
    try { e = etq.actualizar(db, antes.id, req.body || {}); } catch (err) { return errorUsuario(res, err); }
    res.json({ ...e, ghl: e.nombre !== antes.nombre ? await enGhl(() => etq.renombrarTagGhl(etiquetas.ghl, antes.nombre, e.nombre)) : null });
  });
  admin.delete('/panel/etiquetas/:id', (req, res) => { etq.borrar(db, Number(req.params.id)); res.json({ ok: true }); });
  // «Aplicar a chats de antes»: busca en el historial los chats que cumplen sus reglas
  admin.post('/panel/etiquetas/:id/aplicar', async (req, res) => {
    if (!etq.obtener(db, Number(req.params.id))) return res.status(404).json({ error: 'La etiqueta no existe.' });
    res.json(await etiquetas.aplicarAAnteriores(Number(req.params.id)));
  });
  admin.post('/panel/conversaciones/:id/etiquetas', async (req, res) => {
    if (!repo.getConv(req.params.id)) return res.status(404).json({ error: 'no existe' });
    const r = await etiquetas.poner(req.params.id, Number(req.body?.etiqueta), 'manual');
    if (!r.puesta && r.motivo === 'no existe') return res.status(404).json({ error: 'La etiqueta no existe.' });
    res.json({ ...r, etiquetas: etq.deChats(db, [req.params.id])[req.params.id] || [] });
  });
  admin.delete('/panel/conversaciones/:id/etiquetas/:etq', async (req, res) => {
    await etiquetas.quitar(req.params.id, Number(req.params.etq));
    res.json({ etiquetas: etq.deChats(db, [req.params.id])[req.params.id] || [] });
  });

  // ---------- Vistas (filtros guardados) ----------
  admin.get('/panel/vistas', (_req, res) => res.json(panel.vistas(db)));
  admin.post('/panel/vistas', (req, res) => { try { res.status(201).json({ id: panel.guardarVista(db, req.body || {}) }); } catch (e) { errorUsuario(res, e); } });
  admin.put('/panel/vistas/orden', (req, res) => { panel.reordenarVistas(db, (req.body?.ids || []).map(Number)); res.json({ ok: true }); });
  admin.put('/panel/vistas/:id', (req, res) => { try { res.json({ id: panel.guardarVista(db, { ...req.body, id: Number(req.params.id) }) }); } catch (e) { errorUsuario(res, e); } });
  admin.delete('/panel/vistas/:id', (req, res) => res.json({ ok: panel.borrarVista(db, Number(req.params.id)) }));
  admin.get('/panel/opciones', (_req, res) => res.json({
    etiquetas: etq.listar(db).map(({ id, nombre, color }) => ({ id, nombre, color })),
    sedes: ['parla', 'getafe', 'las_rosas', 'el_canaveral'], canales: ['whatsapp', 'instagram'],
    fases: ['f1 apertura', 'f2 diagnóstico', 'f3 presentación', 'f4 objeciones', 'f5 cierre', 'cerrada'],
    estados: Object.keys(panel.ESTADOS),
  }));

  admin.get('/panel/ajustes', (_req, res) => res.json(leerAjustes(repo)));
  admin.put('/panel/ajustes', (req, res) => {
    try { res.json(guardarAjustes(repo, req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.use('/admin', admin);

  // Nginx valida la sesión de MetroTools e inyecta el rol y la clave del servidor.
  const metrotools = express.Router();
  metrotools.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    if (req.get('x-cfmpo-admin') !== '1' || !igual(req.get('authorization'), `Bearer ${config.adminToken}`) || !config.adminToken) {
      return res.status(403).json({ error: 'Esta herramienta requiere acceso de administración.' });
    }
    next();
  });
  metrotools.get('/', (_req, res) => res.type('html').send(metroPanel));
  metrotools.use('/api', (req, res, next) => {
    if (req.get('x-metrotools-client') !== 'zapp') return res.status(403).json({ error: 'Petición fuera del panel de MetroTools.' });
    next();
  }, admin);
  app.use('/metrotools', metrotools);
  return app;
}
