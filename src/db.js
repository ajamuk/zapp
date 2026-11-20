import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { sembrarReglas } from './reglas.js';
import { sembrarDocumentos } from './documentos.js';

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
CREATE TABLE IF NOT EXISTS socios (
  telefono TEXT NOT NULL,
  sede TEXT NOT NULL,
  aimharder_id INTEGER NOT NULL,
  nombre TEXT,
  activo INTEGER NOT NULL,
  tarifa TEXT,
  actualizado TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS socios_tel ON socios(telefono);
CREATE TABLE IF NOT EXISTS altas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  datos TEXT NOT NULL,              -- JSON
  estado TEXT NOT NULL,             -- pendiente | preparada | fallida | simulada
  detalle TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS etiquetas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT NOT NULL DEFAULT '#386b36',
  criterio_ia TEXT,                 -- si tiene texto, Sofía la pone cuando se cumple
  reglas TEXT NOT NULL DEFAULT '[]',     -- JSON: reglas automáticas (texto, adjunto, inactividad, fase, sede)
  solo_si TEXT NOT NULL DEFAULT '[]',    -- JSON: ids; regla/IA solo la ponen si el chat ya lleva alguna
  nunca_si TEXT NOT NULL DEFAULT '[]',   -- JSON: ids; regla/IA no la ponen si el chat lleva alguna
  acciones TEXT NOT NULL DEFAULT '{}',   -- JSON: pausar_ia, reanudar_ia, forzar_respuesta, derivar, avisar, ghl
  activa INTEGER NOT NULL DEFAULT 1,
  orden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS conv_etiquetas (
  conversation_id TEXT NOT NULL,
  etiqueta_id INTEGER NOT NULL,
  origen TEXT NOT NULL,             -- manual | regla | ia
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (conversation_id, etiqueta_id)
);
CREATE INDEX IF NOT EXISTS conv_etiquetas_etq ON conv_etiquetas(etiqueta_id);
CREATE TABLE IF NOT EXISTS vistas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  criterios TEXT NOT NULL,          -- JSON: ver panel.js (filtrosSql)
  orden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS reglas_seguimiento (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL,               -- silencio | etiqueta | cita | largo-plazo
  canales TEXT NOT NULL DEFAULT '["whatsapp","instagram"]',
  minutos INTEGER NOT NULL DEFAULT 0, -- silencio/etiqueta: después; cita: antes; largo-plazo: por defecto
  despues_de TEXT,                  -- largo-plazo: va detrás de otra regla
  etiqueta_id INTEGER,              -- etiqueta: la que la dispara
  condicion TEXT,                   -- vacía = siempre
  instrucciones TEXT,
  modo TEXT NOT NULL DEFAULT 'ia',  -- ia | fijo
  texto_fijo TEXT,                  -- modo fijo; lo que va entre [corchetes] lo rellena Sofía
  excluir TEXT NOT NULL DEFAULT '{}', -- JSON: { clientes, pausada, calladas_horas }
  poner_etiqueta INTEGER,           -- etiqueta que se pone al enviarlo
  plantilla INTEGER NOT NULL DEFAULT 1, -- fuera de las 24 h de WhatsApp, por plantilla
  activo INTEGER NOT NULL DEFAULT 1,
  orden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS lanzamientos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  texto TEXT NOT NULL,
  programado_at TEXT NOT NULL,
  dias_actividad INTEGER NOT NULL DEFAULT 30,
  canales TEXT NOT NULL DEFAULT '["whatsapp"]',
  excluir_etiquetas TEXT NOT NULL DEFAULT '[]',
  solo_etiquetas TEXT NOT NULL DEFAULT '[]',
  estado TEXT NOT NULL DEFAULT 'programado', -- programado | enviando | enviado | cancelado
  total INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS documentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc TEXT NOT NULL,                -- prompt | negocio
  version INTEGER NOT NULL,
  texto TEXT NOT NULL,
  nota TEXT,
  autor TEXT,                       -- inicial | panel | reporte
  reporte_id INTEGER,
  estado TEXT NOT NULL,             -- produccion | borrador | archivada
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS reportes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  origen TEXT NOT NULL,             -- chat | prueba | general
  conversation_id TEXT,
  message_id INTEGER,
  respuesta_ia TEXT,                -- la respuesta de Sofía que se reporta
  contexto TEXT,                    -- JSON: la conversación hasta ese momento (por si se borra la prueba)
  que_fallo TEXT NOT NULL,
  que_esperaba TEXT,
  texto_exacto TEXT,                -- si quieren que diga exactamente esto
  estado TEXT NOT NULL DEFAULT 'recibido', -- recibido | analizando | duda | propuesto | aplicado | sin_cambio | no_prompt | fallido | descartado | error
  clasificacion TEXT,
  explicacion TEXT,
  pregunta TEXT,
  respuesta_usuario TEXT,
  propuesta TEXT,                   -- JSON: { doc, cambios: [{ buscar, reemplazar }], resumen, version_base }
  comprobacion TEXT,                -- JSON: { antes, despues, arreglado, motivo, intentos }
  version_aplicada INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ajustes (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL,              -- JSON
  actualizado TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  migrar(db);
  sembrarReglas(db);
  sembrarDocumentos(db);
  return db;
}

/** Columnas añadidas después de crear la base: se añaden si faltan. */
const COLUMNAS_NUEVAS = {
  conversations: {
    analisis: 'TEXT',             // lo que Sofía ha entendido del lead (último turno)
    siguiente_paso: 'TEXT',       // qué busca conseguir en el siguiente mensaje
    ultimo_turno: 'TEXT',         // JSON: herramientas usadas y efectos del último turno
    simulacion: 'TEXT',           // JSON (solo chats de prueba): teléfono y fecha simulados
    retomar: 'TEXT',              // JSON: { fecha, motivo, at } cuando el lead lo deja para más adelante
    prueba_fecha: 'TEXT',         // instante de la clase de prueba pedida (para los recordatorios)
  },
  messages: {
    adjunto: 'TEXT',              // imagen | audio | video | documento
    media_ruta: 'TEXT',           // archivo guardado (relativo a data/media)
    media_mime: 'TEXT',
    transcripcion: 'TEXT',        // texto de la nota de voz (Whisper local)
    media_error: 'TEXT',
  },
  conv_etiquetas: { ghl_sync: 'INTEGER NOT NULL DEFAULT 0' }, // 1 = confirmada en GHL
  scheduled: {
    tipo: 'TEXT',                  // silencio | etiqueta | cita | largo-plazo | manual | lanzamiento
    texto_previsto: 'TEXT',        // texto que Sofía tiene preparado ('' = decidió no enviarlo)
    previsto_msg: 'INTEGER',       // último mensaje del chat cuando se preparó (si cambia, se vuelve a redactar)
    previsto_at: 'TEXT',
    contexto: 'TEXT',              // JSON (largo plazo): { fecha, motivo }
  },
};

function migrar(db) {
  for (const [tabla, cols] of Object.entries(COLUMNAS_NUEVAS)) {
    const existen = new Set(db.prepare(`PRAGMA table_info(${tabla})`).all().map((c) => c.name));
    for (const [col, tipo] of Object.entries(cols)) if (!existen.has(col)) db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${col} ${tipo}`);
  }
  db.exec(`UPDATE scheduled SET tipo = CASE WHEN regla_id LIKE 'largo-plazo%' THEN 'largo-plazo' ELSE 'silencio' END WHERE tipo IS NULL`);
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
        return db.prepare(`INSERT INTO messages (conversation_id, external_id, autor, texto, tipo, enviado, adjunto, media_ruta, media_mime, transcripcion, media_error, created_at)
          VALUES (@conversation_id, @external_id, @autor, @texto, @tipo, @enviado, @adjunto, @media_ruta, @media_mime, @transcripcion, @media_error, @created_at)`)
          .run({ external_id: null, tipo: 'texto', enviado: 1, adjunto: null, media_ruta: null, media_mime: null, transcripcion: null, media_error: null, created_at: now(), ...m });
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) return null; // duplicado: GHL reintenta webhooks
        throw e;
      }
    },
    updateMessage(id, patch) {
      const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
      if (keys.length) db.prepare(`UPDATE messages SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @__id`).run({ ...Object.fromEntries(keys.map((k) => [k, patch[k]])), __id: id });
    },
    history: (convId, limit = 40) =>
      db.prepare('SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? AND enviado = 1 ORDER BY id DESC LIMIT ?) ORDER BY id ASC').all(convId, limit),
    schedule: (convId, reglaId, dueAt, contexto = null, tipo = null, texto = null) => {
      const t = tipo || (String(reglaId).startsWith('largo-plazo') ? 'largo-plazo' : 'silencio');
      return db.prepare('INSERT INTO scheduled (conversation_id, regla_id, due_at, contexto, tipo, texto_previsto) VALUES (?, ?, ?, ?, ?, ?)')
        .run(convId, reglaId, dueAt, contexto ? JSON.stringify(contexto) : null, t, texto);
    },
    /**
     * Cancela los pendientes de un chat. Por defecto los que dependen de que Sofía esté al mando
     * (silencio y largo plazo); los de etiqueta, cita, manuales y lanzamientos siguen. `tipos` para elegir.
     * `soloCortos`: solo los de silencio (el lead escribió: los de largo plazo los revisa Sofía antes de enviar).
     */
    cancelScheduled: (convId, motivo, { soloCortos = false, tipos = null, reglaIds = null } = {}) => {
      const t = tipos || (soloCortos ? ['silencio'] : ['silencio', 'largo-plazo']);
      const filtroRegla = reglaIds ? `AND regla_id IN (${reglaIds.map(() => '?').join(',') || "''"})` : '';
      return db.prepare(`UPDATE scheduled SET estado = 'cancelado', detalle = ? WHERE conversation_id = ? AND estado = 'pendiente'
        AND IFNULL(tipo, 'silencio') IN (${t.map(() => '?').join(',')}) ${filtroRegla}`).run(motivo, convId, ...t, ...(reglaIds || []));
    },
    guardarPrevisto: (id, texto, msgId) =>
      db.prepare("UPDATE scheduled SET texto_previsto = ?, previsto_msg = ?, previsto_at = datetime('now') WHERE id = ?").run(texto, msgId, id),
    ultimoMensajeId: (convId) => db.prepare('SELECT max(id) m FROM messages WHERE conversation_id = ? AND enviado = 1').get(convId)?.m ?? 0,
    dueResponses: (at) => db.prepare('SELECT * FROM conversations WHERE respond_at IS NOT NULL AND respond_at <= ? ORDER BY respond_at').all(at),
    dueScheduled: (at) => db.prepare(`SELECT * FROM scheduled WHERE estado = 'pendiente' AND due_at <= ? ORDER BY due_at`).all(at),
    finishScheduled: (id, estado, detalle = null) =>
      db.prepare('UPDATE scheduled SET estado = ?, detalle = ? WHERE id = ?').run(estado, detalle, id),
    logRun: (r) =>
      db.prepare(`INSERT INTO ai_runs (conversation_id, motivo, modelo, tokens_in, tokens_cache_read, tokens_cache_write, tokens_out, ms, error)
        VALUES (@conversation_id, @motivo, @modelo, @tokens_in, @tokens_cache_read, @tokens_cache_write, @tokens_out, @ms, @error)`)
        .run({ tokens_in: 0, tokens_cache_read: 0, tokens_cache_write: 0, tokens_out: 0, ms: 0, error: null, ...r }),
    reemplazarSocios: db.transaction((sede, filas) => {
      db.prepare('DELETE FROM socios WHERE sede = ?').run(sede);
      const ins = db.prepare('INSERT INTO socios (telefono, sede, aimharder_id, nombre, activo, tarifa) VALUES (@telefono, @sede, @aimharder_id, @nombre, @activo, @tarifa)');
      for (const f of filas) ins.run(f);
    }),
    ajustesGuardados: () => Object.fromEntries(db.prepare('SELECT clave, valor FROM ajustes').all().map((r) => [r.clave, JSON.parse(r.valor)])),
    guardarAjuste: (clave, valor) =>
      db.prepare(`INSERT INTO ajustes (clave, valor, actualizado) VALUES (?, ?, datetime('now'))
        ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado = excluded.actualizado`).run(clave, JSON.stringify(valor)),
    sociosPorTelefono: (tel) => db.prepare('SELECT * FROM socios WHERE telefono = ?').all(tel),
    addAlta: (convId, datos, estado, detalle = null) =>
      db.prepare('INSERT INTO altas (conversation_id, datos, estado, detalle) VALUES (?, ?, ?, ?)').run(convId, JSON.stringify(datos), estado, detalle),
    costes: (dias = 7) =>
      db.prepare(`SELECT date(created_at) AS dia, count(*) AS llamadas, sum(tokens_in) AS entrada, sum(tokens_cache_read) AS cache,
        sum(tokens_out) AS salida FROM ai_runs WHERE created_at >= datetime('now', ?) GROUP BY dia ORDER BY dia`).all(`-${dias} days`),
  };
}
