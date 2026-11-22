import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { sembrarReglas } from './reglas.js';
import { sembrarDocumentos } from './documentos.js';
import { crearTabla as tablaPruebasClase } from './clase-prueba.js';
import { crearTabla as tablaPreguntas } from './preguntas.js';

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
CREATE TABLE IF NOT EXISTS alertas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clave TEXT NOT NULL,              -- un problema concreto (se agrupan las repeticiones)
  tipo TEXT NOT NULL,               -- ghl | aimharder | ia | cola | seguimientos | medios | servidor | …
  nivel TEXT NOT NULL DEFAULT 'error', -- error | aviso
  titulo TEXT NOT NULL,
  detalle TEXT,
  veces INTEGER NOT NULL DEFAULT 1,
  primera TEXT NOT NULL DEFAULT (datetime('now')),
  ultima TEXT NOT NULL DEFAULT (datetime('now')),
  resuelta_at TEXT,
  resolucion TEXT
);
CREATE INDEX IF NOT EXISTS alertas_abiertas ON alertas(clave, resuelta_at);
CREATE TABLE IF NOT EXISTS recursos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE COLLATE NOCASE,
  descripcion TEXT NOT NULL,        -- cuándo enviarlo (lo lee Sofía)
  tipo TEXT NOT NULL,               -- imagen | video | documento | audio
  media_ruta TEXT NOT NULL,
  mime TEXT,
  tamano INTEGER,
  token TEXT NOT NULL UNIQUE,       -- para la URL pública /r/<token>
  activo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS meta_eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,           -- chat:evento (una vez por chat y evento)
  evento TEXT NOT NULL,
  valor REAL,
  moneda TEXT,
  estado TEXT NOT NULL,             -- enviado | simulado | sin_configurar | error
  respuesta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS actividad (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  quien TEXT NOT NULL,
  accion TEXT NOT NULL,
  ruta TEXT
);
CREATE TABLE IF NOT EXISTS casos_prueba (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL,               -- momento (Sofía contesta a un punto de una conversación) | escenario (lead simulado, varios turnos)
  canal TEXT NOT NULL DEFAULT 'whatsapp',
  tema TEXT,
  contexto TEXT,                    -- momento: JSON [[quien, texto], …]
  perfil TEXT,                      -- escenario: quién es el lead y qué quiere
  apertura TEXT,                    -- escenario: su primer mensaje
  turnos INTEGER NOT NULL DEFAULT 5,
  socio INTEGER NOT NULL DEFAULT 0, -- escenario: su teléfono es de un socio
  criterios TEXT NOT NULL DEFAULT '[]', -- JSON: frases de sí o no que debe cumplir
  referencia TEXT,                  -- lo que contestó Zapp o lo que pidió el equipo (orientativo para el juez)
  grupo TEXT NOT NULL DEFAULT 'ajuste', -- ajuste | reserva (no se usa para ajustar el prompt: comprueba que la mejora es real)
  origen TEXT NOT NULL DEFAULT 'panel', -- zapp | escenario | reporte | panel
  activo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bateria_pasadas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_v INTEGER, negocio_v INTEGER,
  borradores TEXT,                  -- JSON { prompt: id, negocio: id } si se probó un borrador
  repeticiones INTEGER NOT NULL DEFAULT 2,
  filtro TEXT,                      -- JSON { grupo, tema, ids }
  estado TEXT NOT NULL DEFAULT 'en_curso', -- en_curso | terminada | error | cancelada
  total INTEGER NOT NULL DEFAULT 0, hechos INTEGER NOT NULL DEFAULT 0, pasan INTEGER NOT NULL DEFAULT 0,
  usd REAL NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  terminado_at TEXT
);
CREATE TABLE IF NOT EXISTS bateria_resultados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pasada_id INTEGER NOT NULL,
  caso_id TEXT NOT NULL,
  repeticion INTEGER NOT NULL,
  pasa INTEGER NOT NULL,
  fallos_auto TEXT,                 -- JSON [texto]
  criterios TEXT,                   -- JSON [{ criterio, cumple, motivo }]
  conversacion TEXT,                -- JSON [{ autor, texto }]
  estado TEXT,                      -- JSON: fase, sede, herramientas, etiquetas…
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS bateria_res_pasada ON bateria_resultados(pasada_id, caso_id);
CREATE TABLE IF NOT EXISTS ajustes (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL,              -- JSON
  actualizado TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// Índices para las consultas del panel y de los bucles (se crean después de migrar: usan columnas nuevas)
const INDICES = `
CREATE INDEX IF NOT EXISTS conversations_contact ON conversations(contact_id);
CREATE INDEX IF NOT EXISTS conversations_created ON conversations(created_at);
CREATE INDEX IF NOT EXISTS messages_autor_fecha ON messages(autor, created_at);
CREATE INDEX IF NOT EXISTS messages_fecha ON messages(created_at);
CREATE INDEX IF NOT EXISTS scheduled_conv ON scheduled(conversation_id, estado);
CREATE INDEX IF NOT EXISTS scheduled_regla ON scheduled(regla_id, estado);
CREATE INDEX IF NOT EXISTS ai_runs_fecha ON ai_runs(created_at);
CREATE INDEX IF NOT EXISTS ai_runs_conv ON ai_runs(conversation_id);
CREATE INDEX IF NOT EXISTS altas_conv ON altas(conversation_id);
CREATE INDEX IF NOT EXISTS meta_eventos_id ON meta_eventos(event_id);
`;

/**
 * Copia de seguridad en caliente a `<carpeta>/backups/<nombre>-AAAA-MM-DD.db` (una al día; se guardan `dias`).
 * Devuelve la ruta, o null si ya existía la de hoy o la base está en memoria.
 */
export async function copiaSeguridad(db, dbPath, { dias = 14, ahora = new Date() } = {}) {
  if (!dbPath || dbPath === ':memory:') return null;
  const dir = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = path.basename(dbPath, '.db');
  const destino = path.join(dir, `${base}-${ahora.toISOString().slice(0, 10)}.db`);
  if (fs.existsSync(destino)) return null;
  const tmp = `${destino}.tmp`;
  await db.backup(tmp);
  fs.renameSync(tmp, destino);
  fs.chmodSync(destino, 0o600);
  const viejas = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}-`) && f.endsWith('.db')).sort().slice(0, -dias);
  for (const f of viejas) fs.rmSync(path.join(dir, f), { force: true });
  return destino;
}

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');   // si otro proceso tiene la base ocupada, espera en vez de fallar
  db.pragma('synchronous = NORMAL');  // seguro con WAL y bastante más rápido al escribir
  db.exec(SCHEMA);
  migrar(db);
  db.exec(INDICES);
  tablaPruebasClase(db);
  tablaPreguntas(db);
  sembrarReglas(db);
  sembrarDocumentos(db);
  return db;
}

/** Columnas añadidas después de crear la base: se añaden si faltan. */
const COLUMNAS_NUEVAS = {
  conversations: {
    ghl_sync_at: 'TEXT',           // fecha del último mensaje de GHL ya revisado (Setter.sincronizar)
    ghl_sync_suelo: 'TEXT',        // no se mira GHL antes de esta fecha (conversación de prueba reiniciada)
    analisis: 'TEXT',             // lo que Sofía ha entendido del lead (último turno)
    siguiente_paso: 'TEXT',       // qué busca conseguir en el siguiente mensaje
    ultimo_turno: 'TEXT',         // JSON: herramientas usadas y efectos del último turno
    simulacion: 'TEXT',           // JSON (solo chats de prueba): teléfono y fecha simulados
    retomar: 'TEXT',              // JSON: { fecha, motivo, at } cuando el lead lo deja para más adelante
    prueba_fecha: 'TEXT',         // instante de la clase de prueba pedida (para los recordatorios)
    prompt_v: 'INTEGER',          // versión del prompt con la que Sofía empezó este chat (rendimiento por versión)
    respondiendo_desde: 'TEXT',   // Sofía está contestando (si hay un reinicio a mitad, se vuelve a poner en cola)
    reintentos: 'INTEGER NOT NULL DEFAULT 0', // respuestas fallidas seguidas (IA o GHL caídos)
    valoracion: 'INTEGER',        // nota del lead (1-10) que pone Sofía: probabilidad de que se apunte
    valoracion_motivo: 'TEXT',
    resumen: 'TEXT',              // resumen de toda la conversación (lo escribe Sofía en cada turno)
    nota_ghl_id: 'TEXT',          // nota de la ficha de GHL con la valoración y el resumen (se actualiza)
    nota_ghl_texto: 'TEXT',       // último texto enviado a esa nota (para no repetir la llamada si no cambia)
  },
  messages: {
    adjunto: 'TEXT',              // imagen | audio | video | documento
    media_ruta: 'TEXT',           // archivo guardado (relativo a data/media)
    media_mime: 'TEXT',
    transcripcion: 'TEXT',        // texto de la nota de voz (Whisper local)
    media_error: 'TEXT',
  },
  conv_etiquetas: { ghl_sync: 'INTEGER NOT NULL DEFAULT 0' }, // 1 = confirmada en GHL
  reglas_seguimiento: { recurso_id: 'INTEGER' },
  documentos: { resumen: 'TEXT', resumen_negocio_v: 'INTEGER' }, // resumen legible del prompt (Mi Setter IA)
  ai_runs: {
    prompt_v: 'INTEGER', negocio_v: 'INTEGER',
    tokens_cache_write_1h: 'INTEGER NOT NULL DEFAULT 0', // escritura de caché de 1 hora (se cobra al doble que la entrada)
    coste_usd: 'REAL',            // coste calculado al hacer la llamada, con el modelo que respondió (NULL en filas antiguas)
    respaldo: 'INTEGER NOT NULL DEFAULT 0', // 1 = respondió el modelo de respaldo porque el principal se negó
  },  // archivo que se adjunta al enviarlo
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

/** Apunta una llamada a la IA (o un fallo) en ai_runs. */
export function apuntarUso(db, r) {
  return db.prepare(`INSERT INTO ai_runs (conversation_id, motivo, modelo, tokens_in, tokens_cache_read, tokens_cache_write, tokens_cache_write_1h, tokens_out, coste_usd, respaldo, ms, error, prompt_v, negocio_v)
    VALUES (@conversation_id, @motivo, @modelo, @tokens_in, @tokens_cache_read, @tokens_cache_write, @tokens_cache_write_1h, @tokens_out, @coste_usd, @respaldo, @ms, @error, @prompt_v, @negocio_v)`)
    .run({ conversation_id: null, motivo: null, modelo: null, tokens_in: 0, tokens_cache_read: 0, tokens_cache_write: 0, tokens_cache_write_1h: 0, tokens_out: 0, coste_usd: null, respaldo: 0, ms: 0, error: null, prompt_v: null, negocio_v: null, ...r });
}

/**
 * Repositorio sobre una base. `espejo`: { db, campos } para bases de pruebas: cada llamada a la IA se copia
 * también en la base real (con `campos` sobrescritos, p. ej. otro motivo), para que Consumo cuadre con la factura.
 */
export function repo(db, { espejo = null } = {}) {
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
    /** Borra un chat entero (mensajes, seguimientos, etiquetas, altas…). El consumo de IA (ai_runs) se conserva. */
    borrarConversacion: db.transaction((id) => {
      const tablas = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name)
        .filter((t) => t !== 'conversations' && t !== 'ai_runs' && db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'conversation_id'));
      for (const t of tablas) db.prepare(`DELETE FROM ${t} WHERE conversation_id = ?`).run(id);
      return db.prepare('DELETE FROM conversations WHERE id = ?').run(id).changes;
    }),
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
      db.prepare("SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? AND enviado = 1 AND autor != 'sistema' ORDER BY id DESC LIMIT ?) ORDER BY id ASC").all(convId, limit),
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
      // También los que se están preparando ahora mismo ('enviando'): el envío lo comprueba antes de salir
      return db.prepare(`UPDATE scheduled SET estado = 'cancelado', detalle = ? WHERE conversation_id = ? AND estado IN ('pendiente', 'enviando')
        AND IFNULL(tipo, 'silencio') IN (${t.map(() => '?').join(',')}) ${filtroRegla}`).run(motivo, convId, ...t, ...(reglaIds || []));
    },
    guardarPrevisto: (id, texto, msgId) =>
      db.prepare("UPDATE scheduled SET texto_previsto = ?, previsto_msg = ?, previsto_at = datetime('now') WHERE id = ?").run(texto, msgId, id),
    ultimoMensajeId: (convId) => db.prepare('SELECT max(id) m FROM messages WHERE conversation_id = ? AND enviado = 1').get(convId)?.m ?? 0,
    dueResponses: (at) => db.prepare('SELECT * FROM conversations WHERE respond_at IS NOT NULL AND respond_at <= ? ORDER BY respond_at').all(at),
    dueScheduled: (at) => db.prepare(`SELECT * FROM scheduled WHERE estado = 'pendiente' AND due_at <= ? ORDER BY due_at`).all(at),
    finishScheduled: (id, estado, detalle = null) =>
      db.prepare('UPDATE scheduled SET estado = ?, detalle = ? WHERE id = ?').run(estado, detalle, id),
    logRun: (r) => {
      apuntarUso(db, r);
      // Bases de pruebas (Probar IA, batería, comprobación de reportes): lo que se gasta también cuenta en Consumo
      if (espejo && (r.coste_usd || r.tokens_in || r.tokens_out)) apuntarUso(espejo.db, { ...r, ...espejo.campos, error: null });
    },
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
