// Etiquetas del panel (como las de Zapp): se ponen a mano, por reglas automáticas o por Sofía con un criterio
// escrito en lenguaje natural. Al ponerse pueden ejecutar acciones (pausar/reanudar/forzar a Sofía, derivar,
// avisar al equipo) y se copian a GHL como tag.
//
// Reglas (JSON en etiquetas.reglas; basta con que se cumpla una):
//   { tipo: 'texto', quien: 'lead'|'nosotros'|'cualquiera', operador: 'contiene'|'exacto'|'empieza'|'termina', patron }
//   { tipo: 'adjunto', quien, media: 'imagen'|'audio'|'video'|'documento'|'cualquiera' }
//   { tipo: 'inactividad', horas }      — el lead no contesta a nuestro último mensaje en X horas
//   { tipo: 'fase', fase }              — Sofía pone el chat en esa fase
//   { tipo: 'sede', sede }              — se conoce la sede del lead
// Condiciones (solo para reglas y para Sofía; a mano se pone siempre):
//   solo_si: ids → solo si el chat ya lleva alguna de esas etiquetas
//   nunca_si: ids → nunca si lleva alguna de esas

import { validarAccion as validarMeta, enviarEvento } from './meta.js';

export const COLORES = ['#386b36', '#2f5a77', '#805003', '#a13030', '#6a4882', '#0f766e', '#be185d', '#4b5563'];
export const MEDIA = ['imagen', 'audio', 'video', 'documento'];
const ORIGENES = ['manual', 'regla', 'ia', 'ghl'];
const clave = (t) => String(t ?? '').trim().toLowerCase().replace(/\s+/g, ' '); // GHL guarda los tags en minúsculas

const json = (t, def) => { try { return t ? JSON.parse(t) : def; } catch { return def; } };
const norm = (t) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

function deFila(f) {
  if (!f) return null;
  return {
    ...f, activa: Boolean(f.activa), reglas: json(f.reglas, []), solo_si: json(f.solo_si, []), nunca_si: json(f.nunca_si, []),
    acciones: { ...json(f.acciones, {}), ghl: true },
  };
}

// ---------- Catálogo ----------

export function listar(db, { conUso = false } = {}) {
  const filas = db.prepare('SELECT * FROM etiquetas ORDER BY orden, nombre COLLATE NOCASE').all().map(deFila);
  if (!conUso) return filas;
  const uso = Object.fromEntries(db.prepare(`SELECT etiqueta_id, count(*) n FROM conv_etiquetas WHERE conversation_id NOT LIKE 'prueba-%' GROUP BY 1`).all().map((r) => [r.etiqueta_id, r.n]));
  return filas.map((e) => ({ ...e, chats: uso[e.id] || 0 }));
}

export const obtener = (db, id) => deFila(db.prepare('SELECT * FROM etiquetas WHERE id = ?').get(id));
export const porNombre = (db, nombre) => deFila(db.prepare('SELECT * FROM etiquetas WHERE nombre = ? COLLATE NOCASE').get(String(nombre).trim()));

/** Valida y normaliza lo que llega del panel. Lanza Error con un mensaje para el usuario. */
export function validar(datos = {}, db, id = null) {
  const nombre = String(datos.nombre ?? '').trim().replace(/\s+/g, ' ');
  if (!nombre) throw new Error('Ponle un nombre a la etiqueta.');
  if (nombre.length > 40) throw new Error('El nombre puede tener como mucho 40 letras.');
  const otra = porNombre(db, nombre);
  if (otra && otra.id !== id) throw new Error(`Ya existe una etiqueta «${otra.nombre}».`);
  const color = /^#[0-9a-f]{6}$/i.test(datos.color || '') ? datos.color : COLORES[0];
  const criterio = String(datos.criterio_ia ?? '').trim().slice(0, 600) || null;
  const reglas = (Array.isArray(datos.reglas) ? datos.reglas : []).map(validarRegla).filter(Boolean);
  const ids = (l) => [...new Set((Array.isArray(l) ? l : []).map(Number).filter((x) => Number.isInteger(x) && x !== id))];
  const solo = ids(datos.solo_si); const nunca = ids(datos.nunca_si).filter((x) => !solo.includes(x));
  const a = datos.acciones || {};
  const acciones = {
    pausar_ia: Boolean(a.pausar_ia), reanudar_ia: Boolean(a.reanudar_ia) && !a.pausar_ia,
    forzar_respuesta: Boolean(a.forzar_respuesta) && !a.pausar_ia, derivar: Boolean(a.derivar),
    avisar: Boolean(a.avisar), ghl: true, // siempre sincronizada con GHL
    meta: validarMeta(a.meta),
  };
  return { nombre, color, criterio_ia: criterio, reglas, solo_si: solo, nunca_si: nunca, acciones, activa: datos.activa !== false };
}

function validarRegla(r = {}) {
  const quien = ['lead', 'nosotros', 'cualquiera'].includes(r.quien) ? r.quien : 'lead';
  switch (r.tipo) {
    case 'texto': {
      const patron = String(r.patron ?? '').trim().slice(0, 200);
      if (!patron) throw new Error('Una regla de texto necesita la palabra o frase que buscar.');
      return { tipo: 'texto', quien, operador: ['contiene', 'exacto', 'empieza', 'termina'].includes(r.operador) ? r.operador : 'contiene', patron };
    }
    case 'adjunto': return { tipo: 'adjunto', quien, media: [...MEDIA, 'cualquiera'].includes(r.media) ? r.media : 'cualquiera' };
    case 'inactividad': {
      const horas = Number(r.horas);
      if (!(horas > 0 && horas <= 24 * 60)) throw new Error('La regla de inactividad necesita un número de horas (1 a 1440).');
      return { tipo: 'inactividad', horas };
    }
    case 'fase': return r.fase ? { tipo: 'fase', fase: String(r.fase) } : null;
    case 'sede': return r.sede ? { tipo: 'sede', sede: String(r.sede) } : null;
    default: return null;
  }
}

const aFila = (e) => ({ ...e, reglas: JSON.stringify(e.reglas), solo_si: JSON.stringify(e.solo_si), nunca_si: JSON.stringify(e.nunca_si), acciones: JSON.stringify(e.acciones), activa: e.activa ? 1 : 0 });

export function crear(db, datos) {
  const e = validar(datos, db);
  const orden = (db.prepare('SELECT max(orden) m FROM etiquetas').get().m ?? 0) + 1;
  const r = db.prepare(`INSERT INTO etiquetas (nombre, color, criterio_ia, reglas, solo_si, nunca_si, acciones, activa, orden)
    VALUES (@nombre, @color, @criterio_ia, @reglas, @solo_si, @nunca_si, @acciones, @activa, @orden)`).run({ ...aFila(e), orden });
  return obtener(db, r.lastInsertRowid);
}

export function actualizar(db, id, datos) {
  const actual = obtener(db, id);
  if (!actual) return null;
  const e = validar({ ...actual, ...datos }, db, id);
  db.prepare(`UPDATE etiquetas SET nombre=@nombre, color=@color, criterio_ia=@criterio_ia, reglas=@reglas, solo_si=@solo_si,
    nunca_si=@nunca_si, acciones=@acciones, activa=@activa WHERE id=@id`).run({ ...aFila(e), id });
  return obtener(db, id);
}

export function borrar(db, id) {
  db.transaction(() => {
    db.prepare('DELETE FROM conv_etiquetas WHERE etiqueta_id = ?').run(id);
    db.prepare('DELETE FROM etiquetas WHERE id = ?').run(id);
    for (const e of listar(db)) {
      if (e.solo_si.includes(id) || e.nunca_si.includes(id)) {
        db.prepare('UPDATE etiquetas SET solo_si = ?, nunca_si = ? WHERE id = ?')
          .run(JSON.stringify(e.solo_si.filter((x) => x !== id)), JSON.stringify(e.nunca_si.filter((x) => x !== id)), e.id);
      }
    }
    // Vistas que filtraban por ella
    for (const v of db.prepare('SELECT id, criterios FROM vistas').all()) {
      const c = json(v.criterios, {});
      const limpiar = (l) => (Array.isArray(l) ? l.filter((x) => Number(x) !== id) : l);
      db.prepare('UPDATE vistas SET criterios = ? WHERE id = ?').run(JSON.stringify({ ...c, etiquetas: limpiar(c.etiquetas), sin_etiquetas: limpiar(c.sin_etiquetas) }), v.id);
    }
  })();
}

export function reordenar(db, ids) {
  const upd = db.prepare('UPDATE etiquetas SET orden = ? WHERE id = ?');
  db.transaction(() => ids.forEach((id, i) => upd.run(i, id)))();
}

// ---------- Etiquetas de un chat ----------

/** Etiquetas de uno o varios chats: { convId: [{id, nombre, color, origen}] } */
export function deChats(db, convIds) {
  if (!convIds.length) return {};
  const out = {};
  const filas = db.prepare(`SELECT ce.conversation_id, ce.origen, ce.created_at puesta, e.id, e.nombre, e.color FROM conv_etiquetas ce
    JOIN etiquetas e ON e.id = ce.etiqueta_id WHERE ce.conversation_id IN (${convIds.map(() => '?').join(',')}) ORDER BY e.orden, e.nombre`).all(...convIds);
  for (const f of filas) (out[f.conversation_id] ??= []).push({ id: f.id, nombre: f.nombre, color: f.color, origen: f.origen, puesta: f.puesta });
  return out;
}

const idsDelChat = (db, convId) => db.prepare('SELECT etiqueta_id FROM conv_etiquetas WHERE conversation_id = ?').all(convId).map((r) => r.etiqueta_id);

/** ¿Se puede poner por regla/IA? Devuelve null si sí, o el motivo si no. */
export function bloqueo(etq, idsActuales) {
  if (etq.solo_si.length && !etq.solo_si.some((x) => idsActuales.includes(x))) return 'no lleva ninguna de las etiquetas necesarias';
  if (etq.nunca_si.some((x) => idsActuales.includes(x))) return 'lleva una etiqueta que lo impide';
  return null;
}

/**
 * Motor: se crea por cada repo (el real o el de pruebas). `catalogo` es la base donde viven las etiquetas
 * (en Probar IA las conversaciones van a otra base pero usan las etiquetas reales).
 * - ghl: { addTags, removeTags } (opcional)
 * - avisar(texto, {sede}) (opcional)
 * - now(): fecha actual (para chats de prueba con hora simulada)
 */
export class Etiquetador {
  constructor({ repo, catalogo = repo.db, ghl, avisar, now = () => new Date(), alPoner = null, alQuitar = null, enviarMeta = null }) {
    // alPoner/alQuitar(convId, etiquetaId): para los seguimientos que dispara una etiqueta
    Object.assign(this, { repo, catalogo, ghl, avisar, now, alPoner, alQuitar, enviarMeta });
  }

  get db() { return this.repo.db; }

  /** Pone una etiqueta. Devuelve { puesta: bool, motivo? }. Las acciones solo corren si es nueva. */
  async poner(convId, etiquetaId, origen = 'manual', { porInactividad = false, retroactivo = false } = {}) {
    // retroactivo («aplicar a chats de antes»): solo marca y copia a GHL; no pausa, no fuerza respuesta, no avisa,
    // no manda eventos a Meta ni programa seguimientos (serían mensajes a leads de hace meses).
    // origen 'ghl': la han puesto en GHL (a mano o una automatización); cuenta como manual y ya está allí.
    if (!ORIGENES.includes(origen)) throw new Error('origen no válido');
    const etq = obtener(this.catalogo, etiquetaId);
    const conv = this.repo.getConv(convId);
    if (!etq || !conv) return { puesta: false, motivo: 'no existe' };
    if (origen !== 'manual' && !etq.activa) return { puesta: false, motivo: 'etiqueta desactivada' };
    const actuales = idsDelChat(this.db, convId);
    if (actuales.includes(etq.id)) return { puesta: false, motivo: 'ya la lleva' };
    if (origen === 'regla' || origen === 'ia') {
      const b = bloqueo(etq, actuales);
      if (b) return { puesta: false, motivo: b };
    }
    this.db.prepare('INSERT OR IGNORE INTO conv_etiquetas (conversation_id, etiqueta_id, origen, created_at, ghl_sync) VALUES (?, ?, ?, ?, ?)')
      .run(convId, etq.id, origen, this.now().toISOString(), origen === 'ghl' ? 1 : 0);
    if (retroactivo) await this.subirAGhl(conv, etq);
    else {
      await this.acciones(conv, etq, origen, porInactividad);
      await this.safe(async () => this.alPoner?.(convId, etq.id));
    }
    return { puesta: true, etiqueta: { id: etq.id, nombre: etq.nombre, color: etq.color } };
  }

  async quitar(convId, etiquetaId) {
    const etq = obtener(this.catalogo, etiquetaId);
    const conv = this.repo.getConv(convId);
    const r = this.db.prepare('DELETE FROM conv_etiquetas WHERE conversation_id = ? AND etiqueta_id = ?').run(convId, etiquetaId);
    if (r.changes) await this.safe(async () => this.alQuitar?.(convId, etiquetaId));
    if (r.changes && etq && conv?.contact_id && !(await this.otroChatDelContactoLaLleva(conv, etq.id))) {
      await this.safe(() => this.ghl?.removeTags(conv.contact_id, [clave(etq.nombre)]));
    }
    return { quitada: r.changes > 0 };
  }

  async acciones(conv, etq, origen, porInactividad = false) {
    const a = etq.acciones;
    const patch = {};
    if (a.pausar_ia || a.derivar) {
      Object.assign(patch, { ai_paused: 1, respond_at: null, pause_reason: `etiqueta «${etq.nombre}»` });
      if (a.derivar) patch.derivado = 1;
      this.repo.cancelScheduled(conv.id, `etiqueta «${etq.nombre}»`);
    } else if (a.reanudar_ia) {
      Object.assign(patch, { ai_paused: 0, derivado: 0, pause_reason: null });
    }
    // Forzar respuesta: Sofía contesta en el siguiente ciclo (respeta horario y pausa). No con inactividad.
    const despuesPausa = { ...conv, ...patch };
    if (a.forzar_respuesta && !porInactividad && !despuesPausa.ai_paused && !despuesPausa.derivado && !conv.respond_at) {
      patch.respond_at = this.now().toISOString();
    }
    if (Object.keys(patch).length) this.repo.updateConv(conv.id, patch);
    if (origen !== 'ghl') await this.subirAGhl(conv, etq);
    if (a.meta?.evento) await this.safe(() => (this.enviarMeta || enviarEvento)(this.db, this.repo.getConv(conv.id) || conv, a.meta));
    if (a.avisar) {
      const quien = { manual: 'a mano', regla: 'por regla', ia: 'por Sofía' }[origen] || origen;
      await this.safe(() => this.avisar?.(`Etiqueta «${etq.nombre}» (${quien}) en ${conv.nombre || conv.telefono || 'un chat'}${conv.sede ? ` · ${conv.sede}` : ''}`, { sede: conv.sede }));
    }
  }

  // ---------- Sincronización con GHL ----------

  /** Pone el tag en el contacto de GHL y marca la etiqueta como confirmada si sale bien. */
  async subirAGhl(conv, etq) {
    if (!this.ghl?.addTags || !conv.contact_id) return false;
    try {
      await this.ghl.addTags(conv.contact_id, [clave(etq.nombre)]);
      this.db.prepare('UPDATE conv_etiquetas SET ghl_sync = 1 WHERE conversation_id = ? AND etiqueta_id = ?').run(conv.id, etq.id);
      return true;
    } catch (e) { console.error('[etiquetas] GHL:', e.message); return false; }
  }

  async otroChatDelContactoLaLleva(conv, etiquetaId) {
    return Boolean(this.db.prepare(`SELECT 1 FROM conv_etiquetas ce JOIN conversations c ON c.id = ce.conversation_id
      WHERE c.contact_id = ? AND c.id != ? AND ce.etiqueta_id = ?`).get(conv.contact_id, conv.id, etiquetaId));
  }

  /**
   * Ajusta las etiquetas de los chats de un contacto a sus tags de GHL (lista completa).
   * - Tag en GHL de una etiqueta del panel que el chat no lleva → se pone (origen ghl, con sus acciones).
   * - Etiqueta confirmada en GHL que ya no está allí → la han quitado en GHL: se quita del panel.
   * - Etiqueta del panel aún sin confirmar en GHL → se reintenta subir.
   */
  async sincronizarContacto(contactId, tags) {
    if (!contactId || !Array.isArray(tags)) return { puestas: 0, quitadas: 0, subidas: 0 };
    const enGhl = new Set(tags.map(clave));
    const catalogo = listar(this.catalogo);
    const chats = this.db.prepare("SELECT * FROM conversations WHERE contact_id = ? AND id NOT LIKE 'prueba-%'").all(contactId);
    const out = { puestas: 0, quitadas: 0, subidas: 0 };
    for (const conv of chats) {
      const filas = this.db.prepare('SELECT etiqueta_id, ghl_sync, created_at FROM conv_etiquetas WHERE conversation_id = ?').all(conv.id);
      const actuales = new Map(filas.map((r) => [r.etiqueta_id, r.ghl_sync]));
      // Recién puestas (2 min): la lista de GHL puede venir de antes de que llegase nuestro tag; no se quitan todavía
      const recientes = new Set(filas.filter((r) => this.now().getTime() - Date.parse(r.created_at) < 120000).map((r) => r.etiqueta_id));
      for (const etq of catalogo) {
        const enElChat = actuales.has(etq.id);
        const estaEnGhl = enGhl.has(clave(etq.nombre));
        if (estaEnGhl && !enElChat) { if ((await this.poner(conv.id, etq.id, 'ghl')).puesta) out.puestas++; }
        else if (estaEnGhl && enElChat && !actuales.get(etq.id)) this.db.prepare('UPDATE conv_etiquetas SET ghl_sync = 1 WHERE conversation_id = ? AND etiqueta_id = ?').run(conv.id, etq.id);
        else if (!estaEnGhl && enElChat && actuales.get(etq.id) && recientes.has(etq.id)) { /* esperar a la siguiente sincronización */ }
        else if (!estaEnGhl && enElChat && actuales.get(etq.id)) { this.db.prepare('DELETE FROM conv_etiquetas WHERE conversation_id = ? AND etiqueta_id = ?').run(conv.id, etq.id); out.quitadas++; await this.safe(async () => this.alQuitar?.(conv.id, etq.id)); }
        else if (!estaEnGhl && enElChat) { if (await this.subirAGhl(conv, etq)) out.subidas++; }
      }
    }
    return out;
  }

  /** Revisión periódica: lee de GHL los tags de los contactos con actividad reciente. */
  async sincronizarDesdeGhl({ dias = 30, pausaMs = 150 } = {}) {
    if (!this.ghl?.getContact) return { contactos: 0 };
    const contactos = this.db.prepare(`SELECT DISTINCT c.contact_id FROM conversations c WHERE c.id NOT LIKE 'prueba-%' AND c.contact_id IS NOT NULL
      AND (datetime(c.updated_at) >= datetime('now', ?) OR EXISTS (SELECT 1 FROM conv_etiquetas ce WHERE ce.conversation_id = c.id AND ce.ghl_sync = 0))`).all(`-${dias} days`).map((r) => r.contact_id);
    const total = { contactos: 0, puestas: 0, quitadas: 0, subidas: 0, errores: 0 };
    for (const id of contactos) {
      try {
        const r = await this.ghl.getContact(id);
        const tags = r?.contact?.tags;
        if (Array.isArray(tags)) {
          const x = await this.sincronizarContacto(id, tags);
          total.puestas += x.puestas; total.quitadas += x.quitadas; total.subidas += x.subidas;
        }
        total.contactos++;
      } catch (e) { total.errores++; console.error('[etiquetas] leer contacto GHL:', e.message); }
      if (pausaMs) await new Promise((res) => setTimeout(res, pausaMs)); // sin agotar el límite de GHL
    }
    return total;
  }

  /** Reglas de texto y adjunto ante un mensaje nuevo. autor: lead | ia | humano. */
  async alMensaje(convId, { autor, texto, adjunto = null }) {
    const puestas = [];
    for (const etq of listar(this.catalogo)) {
      if (!etq.activa) continue;
      if (etq.reglas.some((r) => cumpleMensaje(r, { autor, texto, adjunto }))) {
        const r = await this.poner(convId, etq.id, 'regla');
        if (r.puesta) puestas.push(etq.nombre);
      }
    }
    return puestas;
  }

  /** Reglas de fase y sede después de cada turno de Sofía. */
  async alCambiarEstado(convId) {
    const conv = this.repo.getConv(convId);
    if (!conv) return [];
    const puestas = [];
    for (const etq of listar(this.catalogo)) {
      if (!etq.activa) continue;
      const cumple = etq.reglas.some((r) => (r.tipo === 'fase' && conv.fase === r.fase) || (r.tipo === 'sede' && conv.sede === r.sede));
      if (cumple && (await this.poner(convId, etq.id, 'regla')).puesta) puestas.push(etq.nombre);
    }
    return puestas;
  }

  /** Reglas de inactividad: chats cuyo último mensaje es nuestro y el lead no contesta en X horas. */
  async revisarInactividad() {
    const reglas = listar(this.catalogo).filter((e) => e.activa).flatMap((e) => e.reglas.filter((r) => r.tipo === 'inactividad').map((r) => ({ e, horas: r.horas })));
    let n = 0;
    for (const { e, horas } of reglas) {
      const limite = new Date(this.now().getTime() - horas * 3600e3).toISOString();
      // Solo chats recientes (hasta 7 días después de cumplir el plazo): una regla nueva no etiqueta el histórico entero
      const antiguo = new Date(this.now().getTime() - horas * 3600e3 - 7 * 864e5).toISOString();
      const chats = this.db.prepare(`SELECT c.id FROM conversations c
        JOIN messages m ON m.id = (SELECT max(id) FROM messages WHERE conversation_id = c.id)
        WHERE m.autor IN ('ia', 'humano') AND m.created_at <= ? AND m.created_at >= ? AND c.id NOT LIKE 'prueba-%'
          AND NOT EXISTS (SELECT 1 FROM conv_etiquetas ce WHERE ce.conversation_id = c.id AND ce.etiqueta_id = ?)`).all(limite, antiguo, e.id);
      for (const c of chats) if ((await this.poner(c.id, e.id, 'regla', { porInactividad: true })).puesta) n++;
    }
    return n;
  }

  /** «Aplicar a chats de antes»: busca en todo el historial los chats que cumplen las reglas de texto/adjunto/fase/sede. */
  async aplicarAAnteriores(etiquetaId) {
    const etq = obtener(this.catalogo, etiquetaId);
    if (!etq) return { aplicadas: 0 };
    const deMensaje = etq.reglas.filter((r) => r.tipo === 'texto' || r.tipo === 'adjunto');
    const deEstado = etq.reglas.filter((r) => r.tipo === 'fase' || r.tipo === 'sede');
    const candidatos = new Set();
    if (deMensaje.length) {
      for (const m of this.db.prepare(`SELECT conversation_id, autor, texto, adjunto FROM messages WHERE conversation_id NOT LIKE 'prueba-%' AND enviado = 1`).iterate()) {
        if (deMensaje.some((r) => cumpleMensaje(r, m))) candidatos.add(m.conversation_id);
      }
    }
    for (const r of deEstado) {
      for (const c of this.db.prepare(`SELECT id FROM conversations WHERE ${r.tipo} = ? AND id NOT LIKE 'prueba-%'`).all(r[r.tipo])) candidatos.add(c.id);
    }
    let aplicadas = 0;
    for (const id of candidatos) {
      const r = await this.poner(id, etq.id, 'regla', { retroactivo: true });
      if (r.puesta) aplicadas++;
    }
    return { aplicadas, revisados: candidatos.size };
  }

  /** Bloque de contexto para Sofía con las etiquetas que puede poner, y si el chat ya las lleva. */
  contextoIA(convId) {
    const conIA = listar(this.catalogo).filter((e) => e.activa && e.criterio_ia);
    if (!conIA.length) return '';
    const actuales = idsDelChat(this.db, convId);
    const lineas = conIA.filter((e) => !actuales.includes(e.id) && !bloqueo(e, actuales)).map((e) => `- «${e.nombre}»: ${e.criterio_ia}`);
    if (!lineas.length) return '';
    return ['# Etiquetas que puedes poner', 'Añade a `etiquetas` en `responder` el nombre exacto de cada una cuyo criterio se cumpla ahora. Si no se cumple ninguna, no pongas ninguna de estas.', ...lineas].join('\n');
  }

  /**
   * Etiquetas que Sofía devuelve en `responder`. Las del catálogo con criterio IA se ponen (respetando condiciones).
   * Devuelve { puestas: [nombres], libres: [nombres que no son del catálogo] }.
   */
  async deSofia(convId, nombres = []) {
    const puestas = []; const libres = [];
    for (const n of nombres) {
      const etq = porNombre(this.catalogo, n);
      if (!etq) { libres.push(n); continue; }
      if (!etq.criterio_ia) continue; // las del catálogo sin criterio IA no las pone Sofía
      const r = await this.poner(convId, etq.id, 'ia');
      if (r.puesta) puestas.push(etq.nombre);
    }
    return { puestas, libres };
  }

  async safe(fn) { try { return await fn(); } catch (e) { console.error('[etiquetas]', e.message); return null; } }
}

/** ¿Cumple una regla de texto/adjunto este mensaje? */
export function cumpleMensaje(r, { autor, texto, adjunto }) {
  const deQuien = r.quien === 'cualquiera' || (r.quien === 'lead' ? autor === 'lead' : ['ia', 'humano'].includes(autor));
  if (!deQuien) return false;
  if (r.tipo === 'adjunto') return Boolean(adjunto) && (r.media === 'cualquiera' || r.media === adjunto);
  if (r.tipo !== 'texto') return false;
  const t = norm(texto); const p = norm(r.patron);
  if (!t || !p) return false;
  switch (r.operador) {
    case 'exacto': return t === p;
    case 'empieza': return t.startsWith(p);
    case 'termina': return t.endsWith(p);
    default: return new RegExp(`(^|[^a-z0-9ñ])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9ñ])`).test(t);
  }
}

/** Tipo de adjunto a partir de las URLs/objetos que manda GHL. */
export function tipoAdjunto(adjuntos = []) {
  for (const a of adjuntos) {
    const s = String(typeof a === 'string' ? a : a?.url || a?.type || a?.mimeType || '').toLowerCase();
    if (/image|\.(jpe?g|png|gif|webp|heic)(\?|$)/.test(s)) return 'imagen';
    if (/audio|\.(mp3|ogg|opus|m4a|wav|aac)(\?|$)/.test(s)) return 'audio';
    if (/video|\.(mp4|mov|avi|webm|3gp)(\?|$)/.test(s)) return 'video';
    if (s) return 'documento';
  }
  return null;
}

/** Descripción corta de una regla para el panel. */
export function describirRegla(r) {
  const quien = { lead: 'el lead', nosotros: 'nosotros', cualquiera: 'cualquiera' }[r.quien] || 'el lead';
  switch (r.tipo) {
    case 'texto': return `Si ${quien} ${{ contiene: 'escribe la palabra', exacto: 'escribe exactamente', empieza: 'empieza con', termina: 'termina con' }[r.operador]} «${r.patron}»`;
    case 'adjunto': return `Si ${quien} envía ${r.media === 'cualquiera' ? 'un adjunto' : `un${r.media === 'imagen' ? 'a' : ''} ${r.media}`}`;
    case 'inactividad': return `Si no responde en ${r.horas} h`;
    case 'fase': return `Si llega a la fase «${r.fase}»`;
    case 'sede': return `Si su sede es ${r.sede}`;
    default: return '';
  }
}

// ---------- Catálogo en GHL ----------

/** Crea el tag en el catálogo de GHL si no existe (para que aparezca en sus listas y filtros). */
export async function asegurarTagGhl(ghl, nombre) {
  if (!ghl?.listarTags) return null;
  const tags = await ghl.listarTags();
  const ya = tags.find((t) => clave(t.name) === clave(nombre));
  return ya || ghl.crearTag(clave(nombre));
}

/** Renombra el tag en GHL (cambia en todos sus contactos). Si no existía, lo crea con el nombre nuevo. */
export async function renombrarTagGhl(ghl, viejo, nuevo) {
  if (!ghl?.listarTags || clave(viejo) === clave(nuevo)) return null;
  const tags = await ghl.listarTags();
  const t = tags.find((x) => clave(x.name) === clave(viejo));
  if (t && !tags.some((x) => clave(x.name) === clave(nuevo))) return ghl.renombrarTag(t.id, clave(nuevo));
  return asegurarTagGhl(ghl, nuevo);
}

/** Tags de GHL que todavía no son etiquetas del panel (para importarlas). */
export async function tagsGhlSinImportar(ghl, db) {
  const nuestros = new Set(listar(db).map((e) => clave(e.nombre)));
  const vistos = new Set();
  return (await ghl.listarTags()).map((t) => clave(t.name)).filter((n) => n && !nuestros.has(n) && !vistos.has(n) && vistos.add(n)).sort((a, b) => a.localeCompare(b, 'es'));
}
