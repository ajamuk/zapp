// Preguntas que Sofía no sabe responder («smart FAQ»).
//
// Cuando un lead pregunta algo del negocio que no está en la base de conocimiento, Sofía la apunta con la
// herramienta `pregunta_sin_respuesta` (en vez de inventar o derivar todo el chat), el equipo recibe un aviso
// y la responde desde el panel (Preguntas). Al responderla:
//   - si se marca «que Sofía la use», entra en el bloque «Respuestas del equipo» de la base de conocimiento
//     y Sofía ya la sabe en todos los chats;
//   - si se marca «contestar al lead», Sofía le escribe en ese chat con la respuesta (dentro de la ventana de 24 h).

export const ESTADOS = { pendiente: 'Pendiente', respondida: 'Respondida', descartada: 'Descartada' };

export function crearTabla(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS preguntas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT,
    sede TEXT,
    pregunta TEXT NOT NULL,
    mensaje_lead TEXT,                 -- lo que escribió el lead, tal cual
    estado TEXT NOT NULL DEFAULT 'pendiente',
    respuesta TEXT,
    usar INTEGER NOT NULL DEFAULT 1,   -- 1 = forma parte de lo que sabe Sofía
    veces INTEGER NOT NULL DEFAULT 1,  -- cuántas veces se ha preguntado (mismo texto)
    enviada TEXT,                      -- resultado de contestar al lead (enviada, borrador, fuera de plazo…)
    respondida_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS preguntas_estado ON preguntas(estado, id);`);
}

/** Texto comparable: minúsculas, sin acentos ni signos. */
export const normalizar = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Apunta una pregunta. Si ese chat ya tiene una pendiente igual (mismo texto normalizado), suma una vez más en vez de duplicarla.
 * Devuelve { id, nueva }.
 */
export function apuntar(db, { conversation_id = null, sede = null, pregunta, mensaje_lead = null }) {
  const p = String(pregunta || '').trim().slice(0, 500);
  if (!p) throw new Error('Falta la pregunta.');
  const n = normalizar(p);
  // Solo se agrupa dentro del mismo chat: cada chat necesita su fila para que se le conteste
  const igual = db.prepare("SELECT id, pregunta FROM preguntas WHERE estado = 'pendiente' AND conversation_id IS ?").all(conversation_id).find((r) => normalizar(r.pregunta) === n);
  if (igual) {
    db.prepare("UPDATE preguntas SET veces = veces + 1, updated_at = datetime('now') WHERE id = ?").run(igual.id);
    return { id: igual.id, nueva: false };
  }
  const r = db.prepare('INSERT INTO preguntas (conversation_id, sede, pregunta, mensaje_lead) VALUES (?, ?, ?, ?)')
    .run(conversation_id, sede, p, mensaje_lead ? String(mensaje_lead).slice(0, 1000) : null);
  return { id: Number(r.lastInsertRowid), nueva: true };
}

export function listar(db, { estado = null } = {}) {
  const filas = estado
    ? db.prepare('SELECT * FROM preguntas WHERE estado = ? ORDER BY id DESC LIMIT 300').all(estado)
    : db.prepare("SELECT * FROM preguntas ORDER BY estado = 'pendiente' DESC, id DESC LIMIT 300").all();
  const nombre = db.prepare('SELECT nombre, telefono, channel FROM conversations WHERE id = ?');
  return filas.map((f) => ({ ...f, chat: f.conversation_id ? nombre.get(f.conversation_id) || null : null }));
}

export const obtener = (db, id) => db.prepare('SELECT * FROM preguntas WHERE id = ?').get(id) || null;

export function contadores(db) {
  return Object.fromEntries(db.prepare('SELECT estado, count(*) n FROM preguntas GROUP BY estado').all().map((r) => [r.estado, r.n]));
}

export function responder(db, id, { respuesta, pregunta = null, usar = true }) {
  const r = obtener(db, id);
  if (!r) throw new Error('Esa pregunta no existe.');
  const t = String(respuesta || '').trim();
  if (!t) throw new Error('Escribe la respuesta.');
  if (t.length > 2000) throw new Error('La respuesta puede tener como mucho 2000 caracteres.');
  const p = pregunta != null && String(pregunta).trim() ? String(pregunta).trim().slice(0, 500) : r.pregunta;
  db.prepare(`UPDATE preguntas SET estado = 'respondida', respuesta = ?, pregunta = ?, usar = ?, respondida_at = IFNULL(respondida_at, datetime('now')),
    updated_at = datetime('now') WHERE id = ?`).run(t, p, usar ? 1 : 0, id);
  return obtener(db, id);
}

export function descartar(db, id) {
  db.prepare("UPDATE preguntas SET estado = 'descartada', updated_at = datetime('now') WHERE id = ?").run(id);
}

export function borrar(db, id) { db.prepare('DELETE FROM preguntas WHERE id = ?').run(id); }

export function marcarEnviada(db, id, resultado) {
  db.prepare("UPDATE preguntas SET enviada = ?, updated_at = datetime('now') WHERE id = ?").run(String(resultado).slice(0, 200), id);
}

/** Bloque para la base de conocimiento de Sofía con las respuestas del equipo ('' si no hay ninguna). */
export function bloqueConocimiento(db) {
  let filas;
  try { filas = db.prepare("SELECT pregunta, respuesta FROM preguntas WHERE estado = 'respondida' AND usar = 1 AND respuesta IS NOT NULL ORDER BY id").all(); } catch { return ''; }
  if (!filas.length) return '';
  return ['## Respuestas del equipo a preguntas de leads',
    'El equipo ha respondido estas preguntas que no estaban en la información anterior. Úsalas como un dato más (con tus palabras).',
    ...filas.map((f) => `- **${f.pregunta.replace(/\s+/g, ' ')}** → ${f.respuesta.replace(/\s+/g, ' ')}`)].join('\n');
}

/** Instrucción para que Sofía le cuente la respuesta al lead en su chat. */
export function contextoRespuesta(p) {
  return `# Tarea: el equipo ha respondido una pregunta pendiente\nEl lead preguntó «${p.pregunta}» y le dijiste que lo consultabas con el equipo. Respuesta del equipo: «${p.respuesta}».\nEscríbele ahora para contárselo con tus palabras (sin decir que es un mensaje automático) y, si encaja, retoma la conversación donde se quedó con una sola pregunta. Si en el chat ya se le ha contestado esto, llama a \`responder\` con \`mensajes\` vacío.`;
}
