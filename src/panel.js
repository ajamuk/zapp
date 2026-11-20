import { knowledge } from './knowledge.js';
import { deChats } from './etiquetas.js';
import * as reglasSeg from './reglas.js';

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
    seguimientos: (() => {
      const ultimo = db.prepare('SELECT max(id) m FROM messages WHERE conversation_id = ? AND enviado = 1').get(id)?.m ?? 0;
      return db.prepare('SELECT * FROM scheduled WHERE conversation_id = ? ORDER BY id DESC LIMIT 20').all(id)
        .map((x) => ({ ...x, nombre: x.tipo === 'manual' ? 'Mensaje programado' : x.tipo === 'lanzamiento' ? 'Lanzamiento' : reglasSeg.obtener(db, x.regla_id)?.nombre || x.regla_id, contexto: x.contexto ? JSON.parse(x.contexto) : null, vigente: x.texto_previsto != null && x.previsto_msg === ultimo }));
    })(),
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
  const reglas = reglasSeg.listar(db).map((r) => ({
    ...r, etiqueta: r.etiquetaId ? db.prepare('SELECT nombre, color FROM etiquetas WHERE id = ?').get(r.etiquetaId) : null,
    ...Object.fromEntries(['enviado', 'omitido', 'cancelado', 'error', 'pendiente'].map((e) => [e,
      db.prepare(`SELECT count(*) n FROM scheduled WHERE regla_id = ? AND estado = ? AND conversation_id NOT LIKE 'prueba-%' AND datetime(created_at) >= datetime('now', '-7 days')`).get(r.id, e).n])),
  }));
  const proximos = db.prepare(`SELECT s.*, c.nombre, c.channel, c.sede,
      (s.texto_previsto IS NOT NULL AND s.previsto_msg = (SELECT max(id) FROM messages m WHERE m.conversation_id = s.conversation_id AND m.enviado = 1)) vigente
    FROM scheduled s LEFT JOIN conversations c ON c.id = s.conversation_id
    WHERE s.estado = 'pendiente' AND s.conversation_id NOT LIKE 'prueba-%' AND IFNULL(s.tipo, '') != 'lanzamiento' ORDER BY s.due_at LIMIT 100`).all()
    .map((x) => ({ ...x, contexto: x.contexto ? JSON.parse(x.contexto) : null, vigente: Boolean(x.vigente) || x.tipo === 'manual',
      regla_nombre: x.tipo === 'manual' ? 'Mensaje programado' : reglasSeg.obtener(db, x.regla_id)?.nombre || x.regla_id }));
  const lanzamientos = db.prepare('SELECT * FROM lanzamientos ORDER BY programado_at DESC LIMIT 50').all().map((l) => ({
    ...l, canales: JSON.parse(l.canales), excluir_etiquetas: JSON.parse(l.excluir_etiquetas), solo_etiquetas: JSON.parse(l.solo_etiquetas),
    ...Object.fromEntries(['enviado', 'omitido', 'error', 'pendiente', 'cancelado'].map((e) => [e, db.prepare('SELECT count(*) n FROM scheduled WHERE regla_id = ? AND estado = ?').get(`lanzamiento-${l.id}`, e).n])),
  }));
  return { reglas, proximos, lanzamientos };
}

/**
 * Rendimiento por versión del prompt: de los leads cuyo chat empezó con cada versión, cuántos contestaron a Sofía,
 * pidieron clase de prueba, dejaron el alta (hecha o para el equipo), fueron derivados o lo dejaron para más adelante.
 */
export function rendimiento(db, dias = 90) {
  const filas = db.prepare(`SELECT c.prompt_v v, count(*) chats,
      sum(EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.autor = 'lead'
        AND m.id > (SELECT min(id) FROM messages x WHERE x.conversation_id = c.id AND x.autor = 'ia'))) contestan,
      sum(c.prueba_reservada = 1) prueba, sum(IFNULL(c.alta_estado, '') IN ('preparada', 'pendiente')) alta, sum(c.derivado = 1) derivados,
      sum(c.retomar IS NOT NULL) mas_adelante,
      min(c.created_at) desde, max(c.created_at) hasta
    FROM conversations c WHERE c.prompt_v IS NOT NULL AND c.id NOT LIKE 'prueba-%' AND IFNULL(c.tipo, '') != 'socio'
      AND datetime(c.created_at) >= datetime('now', ?) GROUP BY c.prompt_v ORDER BY c.prompt_v DESC`).all(`-${Math.max(1, Math.min(365, Number(dias) || 90))} days`);
  const notas = Object.fromEntries(db.prepare("SELECT version, nota FROM documentos WHERE doc = 'prompt'").all().map((d) => [d.version, d.nota]));
  return filas.map((f) => ({ ...f, nota: notas[f.v] || '', errores: db.prepare("SELECT count(*) n FROM ai_runs WHERE prompt_v = ? AND error IS NOT NULL").get(f.v).n }));
}

// ---------- Estadísticas ----------
const DIAS_SEM = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const enMadrid = (iso) => {
  const d = new Date(/Z$|T/.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', weekday: 'short', hour: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).map((x) => [x.type, x.value]));
  return { dia: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday), hora: Number(p.hour), fecha: `${p.year}-${p.month}-${p.day}` };
};

/**
 * Estadísticas de los chats nuevos (leads, sin socios) en los últimos `dias`: por día y canal, mapa de cuándo
 * entran (día de la semana × hora), embudo, por canal y sede, y etiquetas más puestas.
 */
export function estadisticas(db, { dias = 30, sede = '', canal = '' } = {}) {
  const d = Math.max(1, Math.min(365, Number(dias) || 30));
  const filtro = [PRUEBAS, "IFNULL(c.tipo, '') != 'socio'", `datetime(c.created_at) >= datetime('now', '-${d} days')`];
  const p = {};
  if (sede) { filtro.push(sede === 'sin_sede' ? 'c.sede IS NULL' : 'c.sede = @sede'); p.sede = sede; }
  if (canal) { filtro.push('c.channel = @canal'); p.canal = canal; }
  const chats = db.prepare(`SELECT c.id, c.created_at, c.channel, c.sede, c.fase, c.prueba_reservada, c.alta_estado, c.derivado, c.retomar,
      EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.autor = 'ia') atendido,
      EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.autor = 'lead' AND m.id > (SELECT min(id) FROM messages x WHERE x.conversation_id = c.id AND x.autor = 'ia')) contesta
    FROM conversations c WHERE ${filtro.join(' AND ')}`).all(p);
  const porDia = {}; const mapa = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const c of chats) {
    const t = enMadrid(c.created_at);
    porDia[t.fecha] ??= { whatsapp: 0, instagram: 0 };
    porDia[t.fecha][c.channel] = (porDia[t.fecha][c.channel] || 0) + 1;
    mapa[t.dia][t.hora]++;
  }
  const ORDEN = ['f1 apertura', 'f2 diagnóstico', 'f3 presentación', 'f4 objeciones', 'f5 cierre', 'cerrada'];
  const llego = (c, f) => ORDEN.indexOf(c.fase) >= ORDEN.indexOf(f) || c.prueba_reservada || c.alta_estado;
  const embudo = [
    ['Chats nuevos', chats.length], ['Sofía contestó', chats.filter((c) => c.atendido).length], ['El lead siguió hablando', chats.filter((c) => c.contesta).length],
    ['Llegó a presentación', chats.filter((c) => llego(c, 'f3 presentación')).length], ['Llegó a cierre', chats.filter((c) => llego(c, 'f5 cierre')).length],
    ['Pidió clase de prueba', chats.filter((c) => c.prueba_reservada).length], ['Alta (hecha o para el equipo)', chats.filter((c) => ['preparada', 'pendiente'].includes(c.alta_estado)).length],
  ];
  const grupo = (k) => Object.values(chats.reduce((o, c) => { const g = c[k] || 'sin_' + k; (o[g] ??= { grupo: g, chats: 0, prueba: 0, alta: 0, derivados: 0, mas_adelante: 0 }); const x = o[g]; x.chats++; x.prueba += c.prueba_reservada ? 1 : 0; x.alta += ['preparada', 'pendiente'].includes(c.alta_estado) ? 1 : 0; x.derivados += c.derivado ? 1 : 0; x.mas_adelante += c.retomar ? 1 : 0; return o; }, {})).sort((a, b) => b.chats - a.chats);
  const etiquetas = chats.length ? db.prepare(`SELECT e.nombre, e.color, count(*) n FROM conv_etiquetas ce JOIN etiquetas e ON e.id = ce.etiqueta_id
    WHERE ce.conversation_id IN (${chats.map(() => '?').join(',')}) GROUP BY e.id ORDER BY n DESC LIMIT 12`).all(...chats.map((c) => c.id)) : [];
  return { dias: d, total: chats.length, porDia: Object.entries(porDia).sort().map(([fecha, v]) => ({ fecha, ...v })), mapa, diasSemana: DIAS_SEM, embudo, porCanal: grupo('channel'), porSede: grupo('sede'), etiquetas };
}

// ---------- Consumo de la IA ----------
// Precios por millón de tokens en dólares (la API cobra en USD): entrada, salida, lectura de caché, escritura de caché
export const PRECIOS = {
  'claude-sonnet-5-5': [2, 10, 0.10, 2.5], 'claude-opus-5-5': [4, 20, 0.20, 5], 'claude-haiku-5-5': [0.10, 0.50, 0.01, 0.125],
  'claude-sonnet-5': [2, 10, 0.20, 2.5], 'claude-opus-5': [5, 25, 0.50, 6.25], 'claude-fable-5-2': [8, 40, 0.20, 10],
};
const MOTIVOS = { 'resumen-instrucciones': 'Resumen de las instrucciones', respuesta: 'Respuestas a leads', outbound: 'Sofía inicia', followup: 'Seguimientos', 'followup-plantilla': 'Seguimientos', 'redactar-seguimiento': 'Textos previstos de seguimientos', reporte: 'Reportes (análisis)', 'reporte-comprobacion': 'Reportes (comprobación)' };

export function costeRun(r) {
  const p = PRECIOS[r.modelo] || PRECIOS['claude-sonnet-5-5'];
  return ((r.tokens_in || 0) * p[0] + (r.tokens_out || 0) * p[1] + (r.tokens_cache_read || 0) * p[2] + (r.tokens_cache_write || 0) * p[3]) / 1e6;
}

/** Consumo por mes y por para qué se usó (respuestas, seguimientos, reportes…), en dólares y euros aproximados. */
export function consumo(db, { meses = 6, eurPorUsd = Number(process.env.EUR_POR_USD) || 0.92 } = {}) {
  const runs = db.prepare(`SELECT strftime('%Y-%m', created_at) mes, motivo, modelo, conversation_id, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write
    FROM ai_runs WHERE datetime(created_at) >= datetime('now', 'start of month', ?)`).all(`-${Math.max(0, Math.min(24, Number(meses) || 6) - 1)} months`);
  const out = {};
  for (const r of runs) {
    const pruebas = String(r.conversation_id || '').startsWith('prueba-');
    const motivo = pruebas ? 'Probar IA' : MOTIVOS[r.motivo] || r.motivo || 'Otros';
    const m = (out[r.mes] ??= { mes: r.mes, usd: 0, llamadas: 0, motivos: {} });
    const c = costeRun(r);
    m.usd += c; m.llamadas++;
    (m.motivos[motivo] ??= { usd: 0, llamadas: 0 }); m.motivos[motivo].usd += c; m.motivos[motivo].llamadas++;
  }
  const lista = Object.values(out).sort((a, b) => b.mes.localeCompare(a.mes)).map((m) => ({ ...m, eur: m.usd * eurPorUsd, motivos: Object.entries(m.motivos).map(([k, v]) => ({ motivo: k, ...v, eur: v.usd * eurPorUsd })).sort((a, b) => b.usd - a.usd) }));
  const chatsMes = Object.fromEntries(db.prepare(`SELECT strftime('%Y-%m', created_at) mes, count(*) n FROM conversations WHERE id NOT LIKE 'prueba-%' GROUP BY mes`).all().map((x) => [x.mes, x.n]));
  return { eurPorUsd, meses: lista.map((m) => ({ ...m, chats: chatsMes[m.mes] || 0, eurPorChat: chatsMes[m.mes] ? (m.usd * eurPorUsd) / chatsMes[m.mes] : null })) };
}

// ---------- Exportar ----------
const celda = (v) => { const t = v == null ? '' : String(v).replace(/\r?\n/g, ' '); return /[;"]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
const csv = (cab, filas) => `\uFEFF${[cab, ...filas].map((f) => f.map(celda).join(';')).join('\r\n')}\r\n`; // BOM + «;» para que Excel en español lo abra bien

/** CSV de los chats que cumplen los criterios: uno por fila, o todos sus mensajes (formato «mensajes»). */
export function exportar(db, { criterios, q = '', formato = 'chats' } = {}) {
  const chats = conversaciones(db, { criterios: criterios || {}, q, limite: 5000 });
  if (formato === 'mensajes') {
    const filas = [];
    const st = db.prepare("SELECT autor, texto, adjunto, transcripcion, enviado, created_at FROM messages WHERE conversation_id = ? AND autor != 'sistema' ORDER BY id");
    for (const c of chats) for (const m of st.all(c.id)) filas.push([c.id, c.nombre, c.telefono, c.channel, m.created_at, { lead: 'Lead', ia: 'Sofía', humano: 'Equipo' }[m.autor] || m.autor, m.texto, m.transcripcion || '', m.adjunto || '', m.enviado ? 'sí' : 'borrador']);
    return csv(['chat', 'nombre', 'teléfono', 'canal', 'fecha', 'quién', 'texto', 'transcripción', 'adjunto', 'enviado'], filas);
  }
  return csv(['chat', 'nombre', 'teléfono', 'canal', 'sede', 'tipo', 'fase', 'Sofía', 'etiquetas', 'clase de prueba', 'alta', 'lo deja para', 'creado', 'último mensaje', 'último texto', 'lo que ha entendido Sofía'],
    chats.map((c) => [c.id, c.nombre, c.telefono, c.channel, c.sede, c.tipo, c.fase, c.derivado ? 'derivado' : c.ai_paused ? `pausada (${c.pause_reason || ''})` : 'activa',
      c.etiquetas.map((e) => e.nombre).join(', '), c.prueba_reservada ? 'sí' : '', c.alta_estado || '', c.retomar ? JSON.parse(c.retomar).fecha : '', c.created_at, c.ultimo_at, c.ultimo_texto, c.analisis]));
}
