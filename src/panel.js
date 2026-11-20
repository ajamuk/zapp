import { knowledge } from './knowledge.js';

/** Consultas del panel de control. Solo lectura, salvo lo que hace el router (pausar, reanudar, ajustes). */
const PRUEBAS = "c.id NOT LIKE 'prueba-%'";

const FILTROS = {
  todos: '1=1',
  ia_activa: "c.ai_paused = 0 AND c.derivado = 0 AND IFNULL(c.tipo, '') != 'socio'",
  pausadas: 'c.ai_paused = 1 AND c.derivado = 0',
  derivadas: 'c.derivado = 1',
  seguimiento: "EXISTS (SELECT 1 FROM scheduled s WHERE s.conversation_id = c.id AND s.estado = 'pendiente')",
  prueba: 'c.prueba_reservada = 1',
  alta: 'c.alta_estado IS NOT NULL',
  socios: "c.tipo = 'socio'",
};

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

export function contadores(db) {
  return Object.fromEntries(Object.entries(FILTROS).map(([k, w]) => [k, db.prepare(`SELECT count(*) n FROM conversations c WHERE ${PRUEBAS} AND ${w}`).get().n]));
}

export function conversaciones(db, { filtro = 'todos', q = '', limite = 100 } = {}) {
  const where = FILTROS[filtro] || FILTROS.todos;
  const busca = q ? 'AND (c.nombre LIKE @q OR c.telefono LIKE @q OR EXISTS (SELECT 1 FROM messages b WHERE b.conversation_id = c.id AND b.texto LIKE @q))' : '';
  return db.prepare(`SELECT c.*,
      (SELECT texto FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) ultimo_texto,
      (SELECT autor FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) ultimo_autor,
      (SELECT created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) ultimo_at,
      (SELECT count(*) FROM scheduled s WHERE s.conversation_id = c.id AND s.estado = 'pendiente') seguimientos_pendientes
    FROM conversations c WHERE ${PRUEBAS} AND ${where} ${busca}
    ORDER BY datetime(IFNULL(ultimo_at, c.updated_at)) DESC LIMIT @limite`)
    .all({ q: `%${q}%`, limite: Math.min(500, Number(limite) || 100) });
}

export function detalle(db, id) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  if (!conv) return null;
  return {
    conv,
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
