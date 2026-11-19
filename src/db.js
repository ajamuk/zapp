import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,              -- conversationId de GHL
  contact_id TEXT NOT NULL,
  channel TEXT NOT NULL,            -- whatsapp | instagram
  nombre TEXT,
  telefono TEXT,
  sede TEXT,
  tipo TEXT,                        -- socio | captacion
  fase TEXT,
  ai_paused INTEGER NOT NULL DEFAULT 0,
  pause_reason TEXT,
  derivado INTEGER NOT NULL DEFAULT 0,
  alta_estado TEXT,                 -- null | pendiente | preparada | fallida
  prueba_reservada INTEGER NOT NULL DEFAULT 0,
  last_inbound_at TEXT,
  last_ai_at TEXT,
  respond_at TEXT,                  -- cuándo debe contestar la IA (se reinicia con cada mensaje del lead)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS conversations_respond ON conversations(respond_at);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  external_id TEXT,
  autor TEXT NOT NULL,              -- lead | ia | humano | sistema
  texto TEXT,
  tipo TEXT NOT NULL DEFAULT 'texto',
  enviado INTEGER NOT NULL DEFAULT 1, -- 0 = borrador en modo shadow
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_ext ON messages(external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_conv ON messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS scheduled (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  regla_id TEXT NOT NULL,
  due_at TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente', -- pendiente | enviado | omitido | cancelado | error
  detalle TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS scheduled_due ON scheduled(estado, due_at);
CREATE TABLE IF NOT EXISTS ai_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT,
  motivo TEXT,                      -- respuesta | followup
  modelo TEXT,
  tokens_in INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, tokens_out INTEGER,
  ms INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS altas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  datos TEXT NOT NULL,              -- JSON
  estado TEXT NOT NULL,             -- pendiente | preparada | fallida | simulada
  detalle TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

export function repo(db) {
  const now = () => new Date().toISOString();
  return {
    db,
    getConv: (id) => db.prepare('SELECT * FROM conversations WHERE id = ?').get(id),
    upsertConv(c) {
      const cur = this.getConv(c.id);
      if (!cur) {
        db.prepare(`INSERT INTO conversations (id, contact_id, channel, nombre, telefono) VALUES (@id, @contact_id, @channel, @nombre, @telefono)`)
          .run({ nombre: null, telefono: null, ...c });
      } else {
        const fields = ['nombre', 'telefono', 'channel', 'contact_id'].filter((k) => c[k] && !cur[k]);
        for (const k of fields) db.prepare(`UPDATE conversations SET ${k} = ? WHERE id = ?`).run(c[k], c.id);
      }
      return this.getConv(c.id);
    },
    updateConv(id, patch) {
      const keys = Object.keys(patch);
      if (!keys.length) return;
      const set = keys.map((k) => `${k} = @${k}`).join(', ');
      db.prepare(`UPDATE conversations SET ${set}, updated_at = @__now WHERE id = @__id`).run({ ...patch, __now: now(), __id: id });
    },
    addMessage(m) {
      try {
        return db.prepare(`INSERT INTO messages (conversation_id, external_id, autor, texto, tipo, enviado, created_at)
          VALUES (@conversation_id, @external_id, @autor, @texto, @tipo, @enviado, @created_at)`)
          .run({ external_id: null, tipo: 'texto', enviado: 1, created_at: now(), ...m });
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) return null; // duplicado: GHL reintenta webhooks
        throw e;
      }
    },
    history: (convId, limit = 40) =>
      db.prepare('SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? AND enviado = 1 ORDER BY id DESC LIMIT ?) ORDER BY id ASC').all(convId, limit),
    schedule: (convId, reglaId, dueAt) =>
      db.prepare('INSERT INTO scheduled (conversation_id, regla_id, due_at) VALUES (?, ?, ?)').run(convId, reglaId, dueAt),
    cancelScheduled: (convId, motivo) =>
      db.prepare(`UPDATE scheduled SET estado = 'cancelado', detalle = ? WHERE conversation_id = ? AND estado = 'pendiente'`).run(motivo, convId),
    dueResponses: (at) => db.prepare('SELECT * FROM conversations WHERE respond_at IS NOT NULL AND respond_at <= ? ORDER BY respond_at').all(at),
    dueScheduled: (at) => db.prepare(`SELECT * FROM scheduled WHERE estado = 'pendiente' AND due_at <= ? ORDER BY due_at`).all(at),
    finishScheduled: (id, estado, detalle = null) =>
      db.prepare('UPDATE scheduled SET estado = ?, detalle = ? WHERE id = ?').run(estado, detalle, id),
    logRun: (r) =>
      db.prepare(`INSERT INTO ai_runs (conversation_id, motivo, modelo, tokens_in, tokens_cache_read, tokens_cache_write, tokens_out, ms, error)
        VALUES (@conversation_id, @motivo, @modelo, @tokens_in, @tokens_cache_read, @tokens_cache_write, @tokens_out, @ms, @error)`)
        .run({ tokens_in: 0, tokens_cache_read: 0, tokens_cache_write: 0, tokens_out: 0, ms: 0, error: null, ...r }),
    addAlta: (convId, datos, estado, detalle = null) =>
      db.prepare('INSERT INTO altas (conversation_id, datos, estado, detalle) VALUES (?, ?, ?, ?)').run(convId, JSON.stringify(datos), estado, detalle),
    costes: (dias = 7) =>
      db.prepare(`SELECT date(created_at) AS dia, count(*) AS llamadas, sum(tokens_in) AS entrada, sum(tokens_cache_read) AS cache,
        sum(tokens_out) AS salida FROM ai_runs WHERE created_at >= datetime('now', ?) GROUP BY dia ORDER BY dia`).all(`-${dias} days`),
  };
}
