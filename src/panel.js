import { knowledge } from './knowledge.js';
import { deChats } from './etiquetas.js';

/** Consultas del panel de control. Solo lectura, salvo lo que hace el router (pausar, reanudar, ajustes). */
const PRUEBAS = "c.id NOT LIKE 'prueba-%'";


export function resumen(db, dias = 1) {
  const desde = `-${Math.max(1, Math.min(90, Number(dias) || 1))} days`;
  const uno = (sql, ...p) => db.prepare(sql).get(...p);
  const todos = (sql, ...p) => db.prepare(sql).all(...p);
  const enPeriodo = (col) => `datetime(${col}) >= datetime('now', '${desde}')`;

  const conversaciones = uno(`SELECT count(*) n,
      sum(IFNULL(tipo, '') = 'socio') socios,
      sum(IFNULL(tipo, '') != 'socio') leads
    FROM conversations c WHERE ${PRUEBAS} AND ${enPeriodo('c.created_at')}`);
  const mensajes = uno(`SELECT
      sum(autor = 'lead') lead, sum(autor = 'ia' AND enviado = 1) ia, sum(autor = 'ia' AND enviado = 0) borradores, sum(autor = 'humano') equipo
    FROM messages m WHERE m.conversation_id NOT LIKE 'prueba-%' AND ${enPeriodo('m.created_at')}`);
  const atendidas = uno(`SELECT count(DISTINCT conversation_id) n FROM messages m
    WHERE m.autor = 'ia' AND m.conversation_id NOT LIKE 'prueba-%' AND ${enPeriodo('m.created_at')}`).n;
  const altas = Object.fromEntries(todos(`SELECT estado, count(*) n FROM altas a WHERE a.conversation_id NOT LIKE 'prueba-%' AND ${enPeriodo('a.created_at')} GROUP BY estado`).map((r) => [r.estado, r.n]));
  const seguimientos = Object.fromEntries(todos(`SELECT estado, count(*) n FROM scheduled s WHERE s.conversation_id NOT LIKE 'prueba-%' AND ${enPeriodo('s.created_at')} GROUP BY estado`).map((r) => [r.estado, r.n]));
  const ahora = uno(`SELECT sum(c.derivado = 1) derivadas, sum(c.ai_paused = 1 AND c.derivado = 0) pausadas,
      sum(c.alta_estado = 'pendiente') altas_pendientes, sum(c.prueba_reservada = 1) pruebas
    FROM conversations c WHERE ${PRUEBAS}`);
  const embudo = todos(`SELECT IFNULL(fase, 'sin fase') fase, count(*) n FROM conversations c
    WHERE ${PRUEBAS} AND IFNULL(tipo, '') != 'socio' AND ${enPeriodo('c.updated_at')} GROUP BY 1 ORDER BY 1`);
  const ia = uno(`SELECT count(*) llamadas, sum(error IS NOT NULL) errores, sum(tokens_in) entrada, sum(tokens_cache_read) cache,
      sum(tokens_cache_write) cache_escritura, sum(tokens_out) salida, avg(ms) ms
    FROM ai_runs r WHERE IFNULL(r.conversation_id, '') NOT LIKE 'prueba-%' AND ${enPeriodo('r.created_at')}`);
  const serie = todos(`SELECT date(datetime(created_at)) dia, sum(autor = 'lead') lead, sum(autor = 'ia') ia
    FROM messages m WHERE m.conversation_id NOT LIKE 'prueba-%' AND ${enPeriodo('m.created_at')} GROUP BY dia ORDER BY dia`);
  return { dias: Number(dias) || 1, conversaciones, mensajes, atendidas, altas, seguimientos, ahora, embudo, ia, serie };
}

// ---------- Filtros y vistas de Chats ----------

/**
 * Criterios combinables (todos opcionales; dentro de cada lista basta con uno):
 *  estado: ['ia_activa'|'pausadas'|'derivadas'|'seguimiento'|'prueba'|'alta'|'socios'|'leads']
 *  etiquetas: [ids], modo: 'alguna'|'todas'   ·   sin_etiquetas: [ids]   ·   sin_ninguna: true
 *  sede: ['parla'|...|'sin_sede']   ·   canal: ['whatsapp'|'instagram']   ·   fase: ['f1 apertura'|...|'sin_fase']
 *  actividad: días (último mensaje en los últimos N días)   ·   espera: 'equipo' (último mensaje del lead) | 'lead'
 *  q: texto (nombre, teléfono o mensajes)
 */
export const ESTADOS = {
  ia_activa: "c.ai_paused = 0 AND c.derivado = 0 AND IFNULL(c.tipo, '') != 'socio'",
  pausadas: 'c.ai_paused = 1 AND c.derivado = 0',
  derivadas: 'c.derivado = 1',
  seguimiento: "EXISTS (SELECT 1 FROM scheduled s WHERE s.conversation_id = c.id AND s.estado = 'pendiente')",
  prueba: 'c.prueba_reservada = 1',
  alta: 'c.alta_estado IS NOT NULL',
  socios: "c.tipo = 'socio'",
  leads: "IFNULL(c.tipo, '') != 'socio'",
};

const lista = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean);

/** Normaliza criterios que llegan del panel o de una vista guardada. */
export function limpiarCriterios(c = {}) {
  const ids = (v) => [...new Set(lista(v).map(Number).filter(Number.isInteger))];
  const out = {
    estado: lista(c.estado).filter((e) => ESTADOS[e]),
    etiquetas: ids(c.etiquetas), modo: c.modo === 'todas' ? 'todas' : 'alguna', sin_etiquetas: ids(c.sin_etiquetas),
    sin_ninguna: c.sin_ninguna === true || c.sin_ninguna === 'true',
    sede: lista(c.sede), canal: lista(c.canal), fase: lista(c.fase),
    actividad: Math.max(0, Math.min(365, Number(c.actividad) || 0)),
    espera: ['equipo', 'lead'].includes(c.espera) ? c.espera : '',
    q: String(c.q || '').trim().slice(0, 100),
  };
  return Object.fromEntries(Object.entries(out).filter(([k, v]) => (Array.isArray(v) ? v.length : k === 'modo' ? out.etiquetas.length > 1 : Boolean(v))));
}

/** WHERE + parámetros para unos criterios. Siempre excluye los chats de prueba. */
export function filtrosSql(criterios = {}) {
  const c = limpiarCriterios(criterios);
  const w = [PRUEBAS]; const p = {};
  const enLista = (col, valores, clave, nulo) => {
    const normales = valores.filter((v) => v !== nulo);
    const partes = normales.map((v, i) => { p[`${clave}${i}`] = v; return `${col} = @${clave}${i}`; });
    if (valores.includes(nulo)) partes.push(`${col} IS NULL`);
    if (partes.length) w.push(`(${partes.join(' OR ')})`);
  };
  if (c.estado) w.push(`(${c.estado.map((e) => ESTADOS[e]).join(' OR ')})`);
  if (c.etiquetas) {
    const marcas = c.etiquetas.map((id, i) => { p[`etq${i}`] = id; return `@etq${i}`; }).join(',');
    w.push(c.modo === 'todas'
      ? `(SELECT count(*) FROM conv_etiquetas ce WHERE ce.conversation_id = c.id AND ce.etiqueta_id IN (${marcas})) = ${c.etiquetas.length}`
      : `EXISTS (SELECT 1 FROM conv_etiquetas ce WHERE ce.conversation_id = c.id AND ce.etiqueta_id IN (${marcas}))`);
  }
  if (c.sin_etiquetas) {
    const marcas = c.sin_etiquetas.map((id, i) => { p[`sin${i}`] = id; return `@sin${i}`; }).join(',');
    w.push(`NOT EXISTS (SELECT 1 FROM conv_etiquetas ce WHERE ce.conversation_id = c.id AND ce.etiqueta_id IN (${marcas}))`);
  }
  if (c.sin_ninguna) w.push('NOT EXISTS (SELECT 1 FROM conv_etiquetas ce WHERE ce.conversation_id = c.id)');
  if (c.sede) enLista('c.sede', c.sede, 'sede', 'sin_sede');
  if (c.canal) enLista('c.channel', c.canal, 'canal', '__');
  if (c.fase) enLista('c.fase', c.fase, 'fase', 'sin_fase');
  if (c.actividad) w.push(`datetime((SELECT max(created_at) FROM messages m WHERE m.conversation_id = c.id)) >= datetime('now', '-${c.actividad} days')`);
  if (c.espera) {
    const autores = c.espera === 'equipo' ? "('lead')" : "('ia', 'humano')";
    w.push(`(SELECT autor FROM messages m WHERE m.conversation_id = c.id AND m.enviado = 1 ORDER BY m.id DESC LIMIT 1) IN ${autores}`);
  }
  if (c.q) {
    p.q = `%${c.q}%`;
    w.push('(c.nombre LIKE @q OR c.telefono LIKE @q OR EXISTS (SELECT 1 FROM messages b WHERE b.conversation_id = c.id AND b.texto LIKE @q))');
  }
  return { where: w.join(' AND '), params: p, criterios: c };
}

export const VISTAS_SISTEMA = [
  { id: 'todos', nombre: 'Todos', criterios: {} },
  { id: 'ia_activa', nombre: 'IA activa', criterios: { estado: ['ia_activa'] } },
  { id: 'espera', nombre: 'Esperan respuesta', criterios: { espera: 'equipo', estado: ['leads'] } },
  { id: 'pausadas', nombre: 'Pausadas', criterios: { estado: ['pausadas'] } },
  { id: 'derivadas', nombre: 'Derivadas', criterios: { estado: ['derivadas'] } },
  { id: 'seguimiento', nombre: 'Seguimiento', criterios: { estado: ['seguimiento'] } },
  { id: 'prueba', nombre: 'Clase prueba', criterios: { estado: ['prueba'] } },
  { id: 'alta', nombre: 'Alta', criterios: { estado: ['alta'] } },
  { id: 'socios', nombre: 'Socios', criterios: { estado: ['socios'] } },
];

const contar = (db, criterios) => { const f = filtrosSql(criterios); return db.prepare(`SELECT count(*) n FROM conversations c WHERE ${f.where}`).get(f.params).n; };

/** Vistas del sistema + las creadas en el panel, con su contador. */
export function vistas(db) {
  const propias = db.prepare('SELECT * FROM vistas ORDER BY orden, id').all()
    .map((v) => ({ id: v.id, nombre: v.nombre, criterios: limpiarCriterios(JSON.parse(v.criterios)), propia: true }));
  return [...VISTAS_SISTEMA.map((v) => ({ ...v, propia: false })), ...propias].map((v) => ({ ...v, total: contar(db, v.criterios) }));
}

export function guardarVista(db, { id = null, nombre, criterios }) {
  const n = String(nombre || '').trim().slice(0, 40);
  if (!n) throw new Error('Ponle un nombre a la vista.');
  const c = JSON.stringify(limpiarCriterios(criterios));
  if (id) {
    if (!db.prepare('UPDATE vistas SET nombre = ?, criterios = ? WHERE id = ?').run(n, c, id).changes) throw new Error('La vista no existe.');
    return Number(id);
  }
  const orden = (db.prepare('SELECT max(orden) m FROM vistas').get().m ?? 0) + 1;
  return Number(db.prepare('INSERT INTO vistas (nombre, criterios, orden) VALUES (?, ?, ?)').run(n, c, orden).lastInsertRowid);
}

export const borrarVista = (db, id) => db.prepare('DELETE FROM vistas WHERE id = ?').run(id).changes > 0;

export function reordenarVistas(db, ids) {
  const upd = db.prepare('UPDATE vistas SET orden = ? WHERE id = ?');
  db.transaction(() => ids.forEach((id, i) => upd.run(i, id)))();
}

/** Compatibilidad: contadores de los filtros antiguos. */
export function contadores(db) {
  return Object.fromEntries([['todos', {}], ...Object.keys(ESTADOS).map((k) => [k, { estado: [k] }])].map(([k, c]) => [k, contar(db, c)]));
}

/**
 * Lista de chats. Usa `criterios` (objeto o JSON) si llegan; si no, los de la `vista` (id de sistema o propia);
 * si no, el `filtro` antiguo. `q` se suma siempre.
 */
export function conversaciones(db, { filtro, vista, criterios, q = '', limite = 100 } = {}) {
  let combinados = {};
  if (criterios) combinados = typeof criterios === 'string' ? (() => { try { return JSON.parse(criterios); } catch { return {}; } })() : criterios;
  else if (vista) {
    const sis = VISTAS_SISTEMA.find((x) => x.id === vista);
    const propia = sis ? null : db.prepare('SELECT criterios FROM vistas WHERE id = ?').get(Number(vista));
    combinados = sis ? sis.criterios : propia ? JSON.parse(propia.criterios) : {};
  } else if (filtro && ESTADOS[filtro]) combinados = { estado: [filtro] };
  if (q) combinados = { ...combinados, q };
  const f = filtrosSql(combinados);
  const filas = db.prepare(`SELECT c.*,
      (SELECT texto FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) ultimo_texto,
      (SELECT autor FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) ultimo_autor,
      (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) ultimo_at,
      (SELECT count(*) FROM scheduled s WHERE s.conversation_id = c.id AND s.estado = 'pendiente') seguimientos_pendientes
    FROM conversations c WHERE ${f.where}
    ORDER BY datetime(IFNULL(ultimo_at, c.updated_at)) DESC LIMIT @limite`)
    .all({ ...f.params, limite: Math.min(500, Number(limite) || 100) });
  const etq = deChats(db, filas.map((c) => c.id));
  return filas.map((c) => ({ ...c, etiquetas: etq[c.id] || [] }));
}

export function detalle(db, id) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (!conv) return null;
  return {
    conv: { ...conv, ultimo_turno: conv.ultimo_turno ? JSON.parse(conv.ultimo_turno) : null },
    etiquetas: deChats(db, [id])[id] || [],
    mensajes: db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id').all(id),
    seguimientos: db.prepare('SELECT * FROM scheduled WHERE conversation_id = ? ORDER BY id DESC LIMIT 20').all(id),
    altas: db.prepare('SELECT * FROM altas WHERE conversation_id = ? ORDER BY id DESC').all(id).map((a) => ({ ...a, datos: JSON.parse(a.datos) })),
    ia: db.prepare('SELECT * FROM ai_runs WHERE conversation_id = ? ORDER BY id DESC LIMIT 20').all(id),
  };
}

export function altas(db, limite = 100) {
  return db.prepare(`SELECT a.*, c.nombre, c.channel, c.sede FROM altas a LEFT JOIN conversations c ON c.id = a.conversation_id
    WHERE a.conversation_id NOT LIKE 'prueba-%' ORDER BY a.id DESC LIMIT ?`).all(limite)
    .map((a) => ({ ...a, datos: JSON.parse(a.datos) }));
}

export function seguimientos(db) {
  const reglas = knowledge.followups.reglas.map((r) => ({
    id: r.id, nombre: r.nombre, minutos: r.minutos, canales: r.canales, condicion: r.condicion, instrucciones: r.instrucciones,
    plantilla: r.plantillaWhatsapp?.nombre || null,
    ...Object.fromEntries(['enviado', 'omitido', 'cancelado', 'error', 'pendiente'].map((e) => [e,
      db.prepare(`SELECT count(*) n FROM scheduled WHERE regla_id = ? AND estado = ? AND conversation_id NOT LIKE 'prueba-%' AND datetime(created_at) >= datetime('now', '-7 days')`).get(r.id, e).n])),
  }));
  const proximos = db.prepare(`SELECT s.*, c.nombre, c.channel, c.sede FROM scheduled s LEFT JOIN conversations c ON c.id = s.conversation_id
    WHERE s.estado = 'pendiente' AND s.conversation_id NOT LIKE 'prueba-%' ORDER BY s.due_at LIMIT 100`).all();
  return { reglas, proximos };
}
