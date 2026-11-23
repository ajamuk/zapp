// Captación por nivel de conciencia (ver docs/captacion.md).
//
// Un «estratega» aparte de Sofía: cuando un chat se enfría sin alta y los seguimientos normales ya han terminado,
// diagnostica al lead (nivel de conciencia 1-5, motivo y freno), le asigna grupo (tratamiento o control) y planifica
// los toques de contenido según su nivel. SOLO MODO PRUEBA: los toques, al vencer, quedan como borradores en sus
// propias tablas y se ven en el panel. Este módulo no tiene ninguna ruta de envío: no usa GHL, no escribe en la
// cola `scheduled` (la que sí envía) y no toca ni el prompt ni las conversaciones de Sofía.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { pedirJSON } from './llm.js';
import { horaMadrid } from './followups.js';
import * as recursos from './recursos.js';

export const MODO = 'prueba'; // no hay otro: pasar a real exige escribir (y revisar) el envío en un cambio aparte

export const NIVELES = {
  1: 'No consciente',
  2: 'Consciente del problema',
  3: 'Consciente de la solución',
  4: 'Consciente del producto',
  5: 'Totalmente consciente',
};
export const MOTIVOS = ['forma', 'peso', 'fuerza', 'comunidad', 'hyrox', 'salud', 'otro', 'desconocido'];
export const FRENOS = ['precio', 'horario', 'miedo', 'momento', 'prueba', 'distancia', 'ninguno', 'desconocido'];
export const RUTAS = ['academy', 'crossfit', 'hyrox', 'desconocida'];
const PARADAS_DEFINITIVAS = ['socio', 'alta', 'oposición'];

const DIA = 864e5;
const json = (t, d = null) => { try { return t ? JSON.parse(t) : d; } catch { return d; } };
/** Fechas de la base: ISO (las que escribe el servicio) o «AAAA-MM-DD HH:MM:SS» en UTC (las de SQLite). */
export const instante = (s) => (s ? new Date(/T/.test(s) ? s : `${String(s).replace(' ', 'T')}Z`) : null);

// ---------- Configuración ----------

let cfgCache;
export function cargarConfig(ruta = path.join(config.root, 'config', 'captacion.json')) {
  if (cfgCache?.ruta === ruta) return cfgCache.cfg;
  const cfg = validarConfig(JSON.parse(fs.readFileSync(ruta, 'utf8')));
  cfgCache = { ruta, cfg };
  return cfg;
}

export function validarConfig(c) {
  const entero = (v, min, max, nombre) => { if (!Number.isInteger(v) || v < min || v > max) throw new Error(`captacion.json: ${nombre} debe ser un entero entre ${min} y ${max}`); };
  entero(c.control_pct, 0, 100, 'control_pct');
  entero(c.diagnostico_dias, 1, 60, 'diagnostico_dias');
  entero(c.max_sin_respuesta, 1, 10, 'max_sin_respuesta');
  for (const [k, dias] of Object.entries(c.cadencias || {})) {
    if (!Array.isArray(dias) || !dias.length || dias.some((d, i) => !Number.isInteger(d) || d <= (dias[i - 1] ?? 0))) throw new Error(`captacion.json: la cadencia «${k}» debe ser una lista de días creciente`);
    // Sin solapamiento con los seguimientos de Sofía: el primer toque nunca antes de que termine el «cierre a 4 días»
    if (dias[0] <= c.diagnostico_dias) throw new Error(`captacion.json: la cadencia «${k}» empieza antes de terminar los seguimientos normales`);
  }
  if (!c.cadencias?.caliente || !c.cadencias?.frio) throw new Error('captacion.json: faltan las cadencias «caliente» y «frio»');
  if (!/^\d{2}:\d{2}$/.test(c.hora_envio || '')) throw new Error('captacion.json: hora_envio con formato HH:MM');
  const ids = new Set();
  for (const p of c.piezas || []) {
    if (!p.id || ids.has(p.id)) throw new Error(`captacion.json: pieza sin id o repetida (${p.id})`);
    ids.add(p.id);
    if (!Array.isArray(p.niveles) || p.niveles.some((n) => !NIVELES[n] || n === 1)) throw new Error(`captacion.json: la pieza ${p.id} necesita niveles de 2 a 5`);
    if (!String(p.texto || '').trim() || /\n/.test(p.texto)) throw new Error(`captacion.json: la pieza ${p.id} necesita un texto de una sola línea`);
    if ((p.frenos || []).some((f) => !FRENOS.includes(f))) throw new Error(`captacion.json: freno desconocido en la pieza ${p.id}`);
    if (p.material && !c.material?.[p.material]) throw new Error(`captacion.json: la pieza ${p.id} pide un material sin describir (${p.material})`);
  }
  return c;
}

// ---------- Tablas ----------

export function crearTablas(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS captacion_perfiles (
  conversation_id TEXT PRIMARY KEY,
  nivel INTEGER NOT NULL,            -- 1-5 (último diagnóstico)
  nivel_inicial INTEGER NOT NULL,    -- el del primer diagnóstico (para medir si sube)
  motivo TEXT NOT NULL,
  freno TEXT NOT NULL,
  ruta TEXT NOT NULL,                -- academy | crossfit | hyrox | desconocida
  evidencia TEXT,                    -- en qué se basa (sin datos personales)
  origen TEXT NOT NULL,              -- ia | heuristico
  grupo TEXT NOT NULL,               -- tratamiento | control
  estado TEXT NOT NULL,              -- activo | control | sin_plan | conversando | pausado | dormido | parado
  detalle TEXT,                      -- por qué está en ese estado
  toques_sin_respuesta INTEGER NOT NULL DEFAULT 0,
  diagnosticado_msg INTEGER NOT NULL DEFAULT 0, -- último mensaje del chat cuando se diagnosticó
  respondio_at TEXT,                 -- primera vez que el lead escribió después de un diagnóstico
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS captacion_diagnosticos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  nivel INTEGER NOT NULL, motivo TEXT NOT NULL, freno TEXT NOT NULL, ruta TEXT NOT NULL,
  origen TEXT NOT NULL, evidencia TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS captacion_diag_conv ON captacion_diagnosticos(conversation_id, id);
CREATE TABLE IF NOT EXISTS captacion_toques (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  orden INTEGER NOT NULL,
  pieza TEXT NOT NULL,               -- id de la pieza de config/captacion.json
  nivel INTEGER NOT NULL, freno TEXT NOT NULL,
  due_at TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'previsto', -- previsto | borrador | omitido | cancelado (nunca «enviado»: solo modo prueba)
  texto TEXT,                        -- el borrador
  detalle TEXT,
  material_falta TEXT,               -- material real que la pieza necesita y aún no está en Recursos
  created_at TEXT NOT NULL,
  resuelto_at TEXT
);
CREATE INDEX IF NOT EXISTS captacion_toques_due ON captacion_toques(estado, due_at);
CREATE INDEX IF NOT EXISTS captacion_toques_conv ON captacion_toques(conversation_id, estado);
`);
}

// ---------- Diagnóstico ----------

/** Minúsculas y sin tildes, para las reglas de texto. */
const plano = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** Quita emails y teléfonos de un texto antes de sacarlo del servidor. */
export function anonimizar(t) {
  return String(t || '')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/\+\d(?:[\s.-]?\d){8,14}(?!\d)|(?<!\d)(?:0034[\s.-]?)?[6-9](?:[\s.-]?\d){8}(?!\d)/g, '[teléfono]');
}

const RE = {
  oposicion: /\b(no me (escrib|mand|envi)\w* mas|dej(a|ad|en|e) de (escribir|mandar|enviar)|no quiero (recibir|que me escrib|mas mensajes)|no me interesa|no estoy interesad|borra(d|r|me)? mi (numero|telefono|contacto)|dadme de baja|no (me )?molest)|^\s*(stop|baja)\s*$/,
  alta: /\b(me apunto|quiero apuntarme|me quiero apuntar|apuntame|quiero darme de alta|como me (apunto|doy de alta)|quiero empezar ya)\b/,
  aplaza: /\b(mes que viene|proximo mes|semana que viene|cuando cobre|a primeros de mes|despues de (las |el |los )?(vacaciones|verano|navidad(es)?|fiestas|puente|reyes)|mas adelante|(en|para|hasta) (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)|lo pienso|me lo pienso|lo voy a pensar|tengo que pensarlo|ya te digo|te digo algo|lo hablo con|lo consulto)\b/,
  producto: /\b(precios?|tarifas?|cuanto (cuesta|vale|es|sale|seria|se paga|cobrais)|cuotas?|horarios?|a que hora|direccion|donde estais|parla|getafe|las rosas|canaveral|academy|clase de prueba|matricula|permanencia|bono|open box|wellhub)\b/,
  solucion: /\b(crossfit|cross fit|hyrox|wod|box|entrenamiento funcional|halterofilia|clases dirigidas)\b/,
  problema: /\b(ponerme en forma|coger forma|estar en forma|perder peso|adelgazar|bajar (de )?peso|kilos|hacer (algo de )?(deporte|ejercicio)|moverme|sedentari\w*|empezar a entrenar|cuidarme|tonificar|ponerme fuerte|ganar (fuerza|musculo))\b/,
  precioDado: /\d+(?:[.,]\d+)?\s?(?:€|euros?\b)/,
};
const RE_FRENO = [
  ['precio', /\b(car[oa]s?|carill[oa]|mucho dinero|no me llega|no puedo pagar|no me lo puedo permitir|se me va de (precio|presupuesto)|justo de dinero|es mucho)\b/],
  ['horario', /horarios?.{0,40}(no me|imposible|complicad|dificil|mal)|no me (cuadran?|encajan?|vienen? bien|van? bien).{0,30}(hora|horario)|trabajo a turnos|turnos rotativos|no tengo tiempo|no llego a (esa|ninguna)/],
  ['miedo', /no estoy en forma|me da (un poco de |algo de |mucho )?(respeto|miedo|cosa|verguenza|apuro)|no se si (podre|voy a poder|aguantare|sere capaz|valgo)|nunca he hecho (nada|deporte|ejercicio)|estoy (muy )?(oxidad|fuera de forma|en baja forma)|a mi edad|(soy|estoy) muy mayor/],
  ['prueba', /clase de prueba|dia de prueba|sesion de prueba|probar (una|un dia|primero|antes|alguna)|(puedo|se puede) probar/],
  ['distancia', /me (pilla|queda|coge) (un poco |muy |algo )?lejos|esta (muy |un poco )?lejos|no me pilla (bien|cerca)/],
];
const RE_MOTIVO = [
  ['peso', /perder peso|adelgazar|bajar (de )?peso|kilos/],
  ['fuerza', /fuerza|musculo|ponerme fuerte|tonificar/],
  ['hyrox', /hyrox/],
  ['salud', /\b(salud|medico|espalda|estres|ansiedad)\b/],
  ['comunidad', /conocer gente|ambiente|en grupo|comunidad|con (una|un|mi) amig|motivacion|me aburro (en el|del) gimnasio/],
  ['forma', /ponerme en forma|coger forma|estar en forma|moverme|hacer (algo de )?(deporte|ejercicio)|sedentari|cuidarme|empezar a entrenar/],
];
const RE_EXPERIENCIA = /llevo .{0,25}(haciendo|en|con) (crossfit|hyrox)|(he hecho|hice|hacia|ya hago|ya entreno|vengo de) .{0,20}(crossfit|hyrox|otro box)|otro box|tengo experiencia/;
const RE_DE_CERO = /nunca he hecho|desde cero|de cero|principiante|no he hecho|soy nuev|primera vez|empezar a entrenar|hace (anos|mucho|bastante)/;

/**
 * Diagnóstico por reglas de texto, sin IA ni red. Es el respaldo cuando no hay modelo y el modo por defecto del
 * diagnóstico histórico. `mensajes`: [{ autor: lead|ia|humano, texto }] en orden; solo los que el lead llegó a ver.
 */
export function diagnosticoHeuristico(conv = {}, mensajes = []) {
  const delLead = mensajes.filter((m) => m.autor === 'lead').map((m) => plano(m.texto)).filter((t) => t && !/^\[story_mention\]$/.test(t));
  const nuestro = mensajes.filter((m) => m.autor !== 'lead').map((m) => plano(m.texto)).join('\n');
  const lead = delLead.join('\n');
  const senales = [];
  const oposicion = delLead.some((t) => RE.oposicion.test(t));
  const precioDado = RE.precioDado.test(nuestro);
  const aplaza = RE.aplaza.test(lead) || Boolean(conv.retomar);
  const quiereAlta = RE.alta.test(lead);
  let nivel = 1;
  if (quiereAlta || (precioDado && (aplaza || conv.fase === 'f5 cierre'))) nivel = 5;
  else if (precioDado || RE.producto.test(lead)) nivel = 4;
  else if (RE.solucion.test(lead)) nivel = 3;
  else if (RE.problema.test(lead)) nivel = 2;
  if (!lead) senales.push('no ha escrito nada con contenido');
  if (RE.problema.test(lead)) senales.push('cuenta lo que quiere conseguir');
  if (RE.solucion.test(lead)) senales.push('habla de CrossFit/HYROX');
  if (RE.producto.test(lead)) senales.push('pregunta por precio, horarios, sede o Academy');
  if (precioDado) senales.push('ya se le dio un precio');
  if (aplaza) senales.push('lo deja para más adelante');
  if (quiereAlta) senales.push('dice que se quiere apuntar');

  // Freno: el último concreto que haya dicho; «momento» solo si no hay otro
  let freno = null;
  for (const t of delLead) for (const [f, re] of RE_FRENO) if (re.test(t) && !(f === 'prueba' && conv.prueba_reservada)) freno = f;
  if (!freno) freno = aplaza ? 'momento' : 'desconocido';
  if (freno !== 'desconocido') senales.push(`freno: ${freno}`);

  const motivo = RE_MOTIVO.find(([, re]) => re.test(lead))?.[0] || 'desconocido';
  let ruta = 'desconocida';
  if (RE_DE_CERO.test(lead)) ruta = 'academy';
  else if (RE_EXPERIENCIA.test(lead)) ruta = /hyrox/.test(lead) ? 'hyrox' : 'crossfit';
  if (oposicion) senales.push('pide que no se le escriba o dice que no le interesa');
  return { nivel, motivo, freno, ruta, oposicion, evidencia: senales.join('; ') || 'solo un saludo o una petición de información', origen: 'heuristico' };
}

const ESQUEMA_IA = {
  type: 'object', additionalProperties: false,
  properties: {
    nivel: { type: 'integer', enum: [1, 2, 3, 4, 5] },
    motivo: { type: 'string', enum: MOTIVOS },
    freno: { type: 'string', enum: FRENOS },
    ruta: { type: 'string', enum: RUTAS },
    oposicion: { type: 'boolean' },
    evidencia: { type: 'string' },
  },
  required: ['nivel', 'motivo', 'freno', 'ruta', 'oposicion', 'evidencia'],
};

const SISTEMA_IA = `Eres analista de captación de CrossFit MetroPolitano (boxes de CrossFit en Madrid). Lees la conversación de WhatsApp o Instagram entre un lead y el equipo y devuelves un diagnóstico. No escribes al lead.

Nivel de conciencia (lo que el lead ya sabe, no lo interesado que está):
1. No consciente: solo saluda, pide «info» sin más o menciona una historia; no se sabe qué busca.
2. Consciente del problema: cuenta lo que quiere conseguir (ponerse en forma, perder peso, moverse) pero no sabe si el CrossFit es para él.
3. Consciente de la solución: quiere entrenar CrossFit, HYROX o algo así y compara opciones (gimnasio, otros boxes); aún no ha entrado en lo concreto de este centro.
4. Consciente del producto: ha preguntado o ya sabe lo concreto de este centro (sede, horarios, Academy, precio) y se quedó con una duda sin resolver.
5. Totalmente consciente: conoce su cuota y cómo se empieza; solo le falta el momento o el empujón («el mes que viene», «cuando cobre») o ya dijo que se apunta.

Freno principal (el que de verdad le impide apuntarse; el último que haya expresado manda): precio, horario, miedo (a no estar en forma o no poder seguir el ritmo), momento (lo deja para más adelante), prueba (quiere probar antes y no puede o no lo ha hecho), distancia, ninguno (no hay freno: está decidido) o desconocido.
Motivo (para qué quiere entrenar): forma (ponerse en forma en general), peso, fuerza, comunidad (ambiente, gente, motivación), hyrox, salud, otro o desconocido.
Ruta: academy (empieza desde cero o lleva mucho sin entrenar), crossfit u hyrox (ya tiene experiencia), o desconocida.
oposicion: true solo si el lead ha pedido que no se le escriba más o ha dicho claramente que no le interesa.
evidencia: una o dos frases que expliquen el diagnóstico, sin nombres, teléfonos ni emails.

Si la conversación no da para saber algo, usa «desconocido» / «desconocida»: no lo supongas.`;

/** Texto que se manda al modelo: datos del chat y transcripción sin emails ni teléfonos (y sin el nombre del lead). */
export function contenidoIA(conv = {}, mensajes = []) {
  const retomar = json(conv.retomar);
  const ficha = [
    `Canal: ${conv.channel || 'desconocido'}`, `Sede: ${conv.sede || 'desconocida'}`, `Fase del embudo: ${conv.fase || 'desconocida'}`,
    conv.valoracion != null ? `Valoración del equipo (1-10): ${conv.valoracion}` : '',
    retomar?.motivo ? `Dijo que lo dejaba para más adelante: ${anonimizar(retomar.motivo)}` : '',
    conv.prueba_reservada ? 'Tiene o tuvo una clase de prueba reservada' : '',
  ].filter(Boolean).join('\n');
  const quien = { lead: 'LEAD', ia: 'EQUIPO', humano: 'EQUIPO' };
  const hilo = mensajes.slice(-60).map((m) => `${quien[m.autor] || 'EQUIPO'}: ${anonimizar(String(m.texto || '').slice(0, 500))}`).join('\n');
  return `${ficha}\n\nConversación:\n${hilo || '(sin mensajes)'}`;
}

/**
 * Diagnóstico con el modelo (el mismo proveedor que ya usa Sofía; no se manda a ningún servicio nuevo). Si el
 * modelo falla o devuelve algo que no vale, se usa el de reglas. `complete` se puede sustituir en tests.
 */
export async function diagnosticar(conv, mensajes, { ia = false, complete = null, modelo = config.captacion?.modelo || config.ai.model, onUsage = null } = {}) {
  const base = diagnosticoHeuristico(conv, mensajes);
  if (!ia && !complete) return base;
  try {
    const r = await pedirJSON({ system: SISTEMA_IA, contenido: contenidoIA(conv, mensajes), schema: ESQUEMA_IA, modelo, complete, maxTokens: 2000, onUsage });
    if (!NIVELES[r?.nivel] || !MOTIVOS.includes(r.motivo) || !FRENOS.includes(r.freno) || !RUTAS.includes(r.ruta)) throw new Error('diagnóstico con valores fuera de la lista');
    // La oposición nunca se pierde: basta con que la vea el modelo o las reglas
    return { nivel: r.nivel, motivo: r.motivo, freno: r.freno, ruta: r.ruta, oposicion: Boolean(r.oposicion) || base.oposicion, evidencia: anonimizar(String(r.evidencia || '')).slice(0, 400), origen: 'ia' };
  } catch (e) {
    return { ...base, evidencia: `${base.evidencia} (la IA no pudo diagnosticar: ${String(e.message).slice(0, 120)})` };
  }
}

// ---------- Grupo de control ----------

/** Reparto fijo por contacto (no cambia entre vueltas ni al volver a diagnosticar). */
export function grupoDe(contactId, pct) {
  const n = crypto.createHash('sha256').update(`captacion:${contactId}`).digest().readUInt32BE(0) % 100;
  return n < pct ? 'control' : 'tratamiento';
}

// ---------- Paradas ----------

const telefono9 = (t) => { const d = String(t || '').replace(/\D/g, '').replace(/^(0034|34)(?=\d{9}$)/, ''); return d.length >= 9 ? d.slice(-9) : null; };

/**
 * ¿Hay que dejar de escribir a este lead? Devuelve { motivo, definitiva } o null.
 * Definitivas: socio, alta y oposición. Temporales (se puede retomar si cambian): derivación y chat en pausa.
 */
export function motivoParada(db, conv) {
  if (conv.tipo === 'socio') return { motivo: 'socio', definitiva: true };
  const tel = telefono9(conv.telefono);
  if (tel && db.prepare('SELECT 1 FROM socios WHERE telefono = ? AND activo = 1 LIMIT 1').get(tel)) return { motivo: 'socio', definitiva: true };
  if (['pendiente', 'preparada'].includes(conv.alta_estado)) return { motivo: 'alta', definitiva: true };
  if (/^el lead escribió/.test(conv.pause_reason || '')) return { motivo: 'oposición', definitiva: true };
  const dice = db.prepare("SELECT texto, transcripcion FROM messages WHERE conversation_id = ? AND autor = 'lead'").all(conv.id);
  if (dice.some((m) => RE.oposicion.test(plano(m.texto || m.transcripcion)))) return { motivo: 'oposición', definitiva: true };
  if (conv.derivado) return { motivo: 'derivación', definitiva: false };
  if (conv.ai_paused) return { motivo: 'chat en pausa (lo lleva el equipo)', definitiva: false };
  return null;
}

// ---------- Planificación ----------

/** Piezas que encajan con el perfil, las de su freno primero. `usadas`: ids que ya se le prepararon. */
export function piezasPara(perfil, conv, cfg, usadas = []) {
  // «Momento» es el freno del nivel 5: quien conoce el producto y solo lo aplaza recibe los disparadores reales
  const nivel = perfil.nivel === 4 && perfil.freno === 'momento' ? 5 : perfil.nivel;
  const vale = (p) => p.niveles.includes(nivel) && !usadas.includes(p.id)
    && (!p.sedes || p.sedes.includes(conv.sede)) && !(p.excluir_sedes || []).includes(conv.sede)
    && (!p.rutas || p.rutas.includes(perfil.ruta)) && (!p.frenos || p.frenos.includes(perfil.freno));
  const ok = cfg.piezas.filter(vale);
  // Lo específico antes que lo genérico: su sede, su freno, y dentro de eso el orden del fichero
  const peso = (p) => (p.frenos ? 2 : 0) + (p.sedes ? 1 : 0);
  return ok.map((p, i) => ({ p, i })).sort((a, b) => peso(b.p) - peso(a.p) || a.i - b.i).map((x) => x.p);
}

const fechaMadrid = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(d);

/**
 * Toques de un lead: [{ orden, pieza, due_at }]. Los días cuentan desde su última actividad; si ese día ya pasó
 * (lead antiguo), el primero es mañana y los demás conservan la distancia. Siempre a `hora_envio` de Madrid.
 */
export function planificar(perfil, conv, ultimaActividad, ahora, cfg, usadas = []) {
  if (perfil.nivel <= 1 || conv.channel !== 'whatsapp') return [];
  const caliente = perfil.nivel >= 4 && (conv.valoracion == null || conv.valoracion >= cfg.valoracion_caliente);
  const dias = cfg.cadencias[caliente ? 'caliente' : 'frio'];
  // WhatsApp cobra cada plantilla: menos toques a quien menos probable es que se apunte
  const porValoracion = conv.valoracion == null ? cfg.toques_sin_valoracion
    : (cfg.toques_por_valoracion.find((t) => conv.valoracion <= t.hasta)?.toques ?? dias.length);
  const piezas = piezasPara(perfil, conv, cfg, usadas);
  const n = Math.max(0, Math.min(dias.length, porValoracion, cfg.max_sin_respuesta - (perfil.toques_sin_respuesta || 0), piezas.length));
  if (!n) return [];
  const manana = new Date(ahora.getTime() + DIA);
  const atrasado = new Date(ultimaActividad.getTime() + dias[0] * DIA) < manana;
  return piezas.slice(0, n).map((p, i) => {
    const dia = atrasado ? new Date(manana.getTime() + (dias[i] - dias[0]) * DIA) : new Date(ultimaActividad.getTime() + dias[i] * DIA);
    return { orden: i + 1, pieza: p.id, due_at: horaMadrid(`${fechaMadrid(dia)} ${cfg.hora_envio}`).toISOString() };
  });
}

// ---------- Ciclo ----------

const mensajesVistos = (db, convId) => db.prepare("SELECT autor, IFNULL(texto, transcripcion) texto FROM messages WHERE conversation_id = ? AND enviado = 1 AND autor != 'sistema' ORDER BY id").all(convId);
const ultimoMsg = (db, convId) => db.prepare("SELECT max(id) id, max(created_at) at FROM messages WHERE conversation_id = ? AND autor != 'sistema'").get(convId);
const seguimientoPendiente = (db, convId) => db.prepare("SELECT max(due_at) due FROM scheduled WHERE conversation_id = ? AND estado IN ('pendiente', 'enviando')").get(convId)?.due || null;

function cancelarToques(db, convId, motivo, ahora) {
  return db.prepare("UPDATE captacion_toques SET estado = 'cancelado', detalle = ?, resuelto_at = ? WHERE conversation_id = ? AND estado = 'previsto'").run(motivo, ahora.toISOString(), convId).changes;
}
function ponerEstado(db, convId, estado, detalle, ahora, extra = {}) {
  const campos = { estado, detalle, updated_at: ahora.toISOString(), ...extra };
  db.prepare(`UPDATE captacion_perfiles SET ${Object.keys(campos).map((k) => `${k} = @${k}`).join(', ')} WHERE conversation_id = @id`).run({ ...campos, id: convId });
}

/** 1) Paradas: respuesta del lead, alta, socio, derivación, oposición o chat en pausa. Cancelan los toques previstos. */
function revisarParadas(db, ahora, r) {
  for (const p of db.prepare("SELECT * FROM captacion_perfiles WHERE estado != 'parado'").all()) {
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(p.conversation_id);
    if (!conv) { db.prepare('DELETE FROM captacion_perfiles WHERE conversation_id = ?').run(p.conversation_id); cancelarToques(db, p.conversation_id, 'el chat ya no existe', ahora); continue; }
    const nuevoLead = db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND autor = 'lead' AND id > ? LIMIT 1").get(conv.id, p.diagnosticado_msg);
    const extra = nuevoLead && !p.respondio_at ? { respondio_at: ahora.toISOString() } : {};
    const parada = motivoParada(db, conv);
    if (parada) {
      const estado = parada.definitiva ? 'parado' : 'pausado';
      if (p.estado !== estado || p.detalle !== parada.motivo || extra.respondio_at) { ponerEstado(db, conv.id, estado, parada.motivo, ahora, extra); r.paradas += cancelarToques(db, conv.id, `parado: ${parada.motivo}`, ahora) ? 1 : 0; }
      continue;
    }
    const nuevoEquipo = db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND autor = 'humano' AND id > ? LIMIT 1").get(conv.id, p.diagnosticado_msg);
    if ((nuevoLead || nuevoEquipo) && p.estado !== 'conversando') {
      // Vuelve a manos de Sofía (o del equipo): el plan se corta y, si se enfría otra vez, se diagnostica de nuevo
      ponerEstado(db, conv.id, 'conversando', nuevoLead ? 'el lead respondió' : 'el equipo escribió', ahora, { ...extra, ...(nuevoLead ? { toques_sin_respuesta: 0 } : {}) });
      cancelarToques(db, conv.id, nuevoLead ? 'el lead respondió' : 'el equipo escribió', ahora);
      if (nuevoLead) r.respuestas++;
    }
  }
}

/** Instrucciones para que Sofía adapte el texto de una pieza (opcional; por defecto sale el texto de la pieza). */
export function contextoBorrador(pieza, perfil, estilo = '') {
  return [
    `# Tarea: mensaje de captación «${pieza.nombre}»`,
    'El lead lleva días sin escribir y los seguimientos normales ya terminaron. Decide si enviar este mensaje.',
    `Diagnóstico del lead: nivel de conciencia ${perfil.nivel} (${NIVELES[perfil.nivel]}), freno principal: ${perfil.freno}, motivo: ${perfil.motivo}.`,
    `Objetivo del mensaje: ${pieza.objetivo}`,
    `Texto base: «${pieza.texto}». Adáptalo a lo que te contó (su motivo, su duda), sin añadir datos, precios ni promesas que no estén en tu información.`,
    'Si NO tiene sentido con la conversación delante (ya se apuntó, pidió no recibir mensajes, ya se le dijo esto mismo), llama a `responder` con `mensajes` vacío.',
    'El texto irá dentro de una plantilla aprobada de WhatsApp: una sola frase, sin saltos de línea.',
    estilo ? `Estilo: ${estilo}` : '',
  ].filter(Boolean).join('\n');
}

/** 2) Toques vencidos: se prepara el borrador (no se envía nada) y se cuenta como un toque sin respuesta. */
async function prepararBorradores(db, ahora, cfg, r, { redactar = null } = {}) {
  const piezas = Object.fromEntries(cfg.piezas.map((p) => [p.id, p]));
  for (const t of db.prepare("SELECT * FROM captacion_toques WHERE estado = 'previsto' AND due_at <= ? ORDER BY due_at, id").all(ahora.toISOString())) {
    const fin = (estado, detalle, extra = {}) => db.prepare('UPDATE captacion_toques SET estado = ?, detalle = ?, texto = ?, material_falta = ?, resuelto_at = ? WHERE id = ?')
      .run(estado, detalle, extra.texto ?? null, extra.material_falta ?? null, ahora.toISOString(), t.id);
    try {
      if (db.prepare('SELECT estado FROM captacion_toques WHERE id = ?').get(t.id)?.estado !== 'previsto') continue; // cancelado o movido en esta misma vuelta
      const p = db.prepare('SELECT * FROM captacion_perfiles WHERE conversation_id = ?').get(t.conversation_id);
      const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(t.conversation_id);
      if (!p || !conv || p.estado !== 'activo') { fin('cancelado', 'el lead ya no tiene un plan activo'); continue; }
      // Sin solapamiento: si Sofía (o el equipo) tiene algo programado para este chat, el plan entero se retrasa
      const pendiente = seguimientoPendiente(db, conv.id);
      if (pendiente) {
        const delta = new Date(pendiente).getTime() + cfg.separacion_dias * DIA - new Date(t.due_at).getTime();
        for (const x of db.prepare("SELECT id, due_at FROM captacion_toques WHERE conversation_id = ? AND estado = 'previsto'").all(conv.id)) {
          db.prepare('UPDATE captacion_toques SET due_at = ?, detalle = ? WHERE id = ?').run(new Date(new Date(x.due_at).getTime() + delta).toISOString(), 'retrasado: hay un seguimiento de Sofía programado', x.id);
        }
        r.aplazados++; continue;
      }
      const pieza = piezas[t.pieza];
      let omitir = !pieza ? 'la pieza ya no existe en config/captacion.json' : null;
      if (pieza?.omitir_si_ya) {
        const dicho = db.prepare("SELECT texto FROM messages WHERE conversation_id = ? AND autor IN ('ia', 'humano') AND enviado = 1").all(conv.id).some((m) => plano(m.texto).includes(plano(pieza.omitir_si_ya)));
        if (dicho) omitir = `ya se habló de «${pieza.omitir_si_ya}» en el chat`;
      }
      let texto = '';
      if (!omitir) {
        texto = pieza.texto;
        if (redactar) texto = String(await redactar(conv.id, contextoBorrador(pieza, p)) || '').split('\n')[0].trim();
        if (!texto) omitir = 'Sofía decidió no enviarlo con la conversación delante';
      }
      if (omitir) fin('omitido', omitir);
      else {
        // Fuera de las 24 h solo cabe texto (plantilla): el material va como enlace público del recurso, si existe
        const rec = pieza.material ? recursos.porNombre(db, pieza.material) : null;
        fin('borrador', 'borrador (modo prueba): no se ha enviado', { texto: rec ? `${texto} ${recursos.urlPublica(rec)}` : texto, material_falta: pieza.material && !rec ? pieza.material : null });
        r.borradores++;
      }
      const sin = p.toques_sin_respuesta + (omitir ? 0 : 1);
      const quedan = db.prepare("SELECT count(*) n FROM captacion_toques WHERE conversation_id = ? AND estado = 'previsto'").get(conv.id).n;
      if (sin >= cfg.max_sin_respuesta || !quedan) {
        ponerEstado(db, conv.id, 'dormido', sin >= cfg.max_sin_respuesta ? `${sin} toques sin respuesta: solo lanzamientos` : 'plan terminado sin respuesta: solo lanzamientos', ahora, { toques_sin_respuesta: sin });
        cancelarToques(db, conv.id, 'lead dormido', ahora);
      } else ponerEstado(db, conv.id, p.estado, p.detalle, ahora, { toques_sin_respuesta: sin });
    } catch (e) {
      fin('omitido', `error al preparar el borrador: ${String(e.message).slice(0, 200)}`);
    }
  }
}

/** Chats fríos que toca diagnosticar: sin perfil (o que volvieron a enfriarse) y sin nada de Sofía pendiente. */
export function candidatos(db, ahora, cfg) {
  const filas = db.prepare(`SELECT c.*, p.estado perfil_estado,
      (SELECT max(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.autor != 'sistema') ultima
    FROM conversations c LEFT JOIN captacion_perfiles p ON p.conversation_id = c.id
    WHERE c.id NOT LIKE 'prueba-%' AND IFNULL(c.tipo, '') != 'socio' AND c.derivado = 0 AND c.ai_paused = 0
      AND IFNULL(c.alta_estado, '') NOT IN ('pendiente', 'preparada')
      AND (p.conversation_id IS NULL OR p.estado IN ('conversando', 'pausado'))
      AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.autor = 'lead')
      AND NOT EXISTS (SELECT 1 FROM scheduled s WHERE s.conversation_id = c.id AND s.estado IN ('pendiente', 'enviando'))`).all();
  return filas.map((c) => ({ ...c, ultima: instante(c.ultima) }))
    .filter((c) => c.ultima && ahora - c.ultima >= cfg.diagnostico_dias * DIA && ahora - c.ultima <= cfg.antiguedad_max_dias * DIA)
    // Con una clase de prueba por delante o recién hecha mandan sus recordatorios y el seguimiento de después
    .filter((c) => !(c.prueba_fecha && ahora - new Date(c.prueba_fecha) < cfg.diagnostico_dias * DIA))
    .sort((a, b) => b.ultima - a.ultima);
}

/** 3) Diagnóstico y plan de los chats fríos. */
async function diagnosticarFrios(repo, ahora, cfg, r, { ia = false, complete = null, limite = cfg.max_diagnosticos_por_vuelta } = {}) {
  const { db } = repo;
  for (const conv of candidatos(db, ahora, cfg).slice(0, limite)) {
    const parada = motivoParada(db, conv);
    const d = parada ? null : await diagnosticar(conv, mensajesVistos(db, conv.id), {
      ia, complete, onUsage: (uso) => repo.logRun({ conversation_id: conv.id, motivo: 'captacion-diagnostico', ...uso }),
    });
    // Sin perfil previo y con parada: no hay nada que diagnosticar ni que guardar (no se manda nada al modelo)
    const previo = db.prepare('SELECT * FROM captacion_perfiles WHERE conversation_id = ?').get(conv.id);
    if (parada && !previo) continue;
    if (parada) { ponerEstado(db, conv.id, parada.definitiva ? 'parado' : 'pausado', parada.motivo, ahora); continue; }
    guardarDiagnostico(db, conv, d, previo, ahora, cfg, r);
  }
}

function guardarDiagnostico(db, conv, d, previo, ahora, cfg, r) {
  const at = ahora.toISOString();
  const grupo = previo?.grupo || grupoDe(conv.contact_id, cfg.control_pct);
  const perfil = { nivel: d.nivel, motivo: d.motivo, freno: d.freno, ruta: d.ruta, toques_sin_respuesta: previo?.toques_sin_respuesta || 0 };
  const usadas = db.prepare("SELECT pieza FROM captacion_toques WHERE conversation_id = ? AND estado = 'borrador'").all(conv.id).map((x) => x.pieza);
  let estado; let detalle = null; let plan = [];
  if (d.oposicion) { estado = 'parado'; detalle = 'oposición'; }
  else if (grupo === 'control') { estado = 'control'; detalle = 'grupo de control: solo los seguimientos de siempre'; }
  else if (d.nivel === 1) { estado = 'sin_plan'; detalle = 'nivel 1: solo lanzamientos'; }
  else if (conv.channel !== 'whatsapp') { estado = 'sin_plan'; detalle = 'Instagram no deja escribir pasados unos días'; }
  else {
    plan = planificar(perfil, conv, conv.ultima, ahora, cfg, usadas);
    if (plan.length) estado = 'activo';
    else { estado = perfil.toques_sin_respuesta >= cfg.max_sin_respuesta ? 'dormido' : 'sin_plan'; detalle = estado === 'dormido' ? 'ya recibió el máximo de toques sin responder' : 'no hay piezas para su perfil'; }
  }
  const msg = db.prepare("SELECT max(id) id FROM messages WHERE conversation_id = ? AND autor != 'sistema'").get(conv.id).id || 0;
  db.transaction(() => {
    db.prepare(`INSERT INTO captacion_perfiles (conversation_id, nivel, nivel_inicial, motivo, freno, ruta, evidencia, origen, grupo, estado, detalle, toques_sin_respuesta, diagnosticado_msg, created_at, updated_at)
      VALUES (@id, @nivel, @nivel, @motivo, @freno, @ruta, @evidencia, @origen, @grupo, @estado, @detalle, @sin, @msg, @at, @at)
      ON CONFLICT(conversation_id) DO UPDATE SET nivel = excluded.nivel, motivo = excluded.motivo, freno = excluded.freno, ruta = excluded.ruta, evidencia = excluded.evidencia,
        origen = excluded.origen, estado = excluded.estado, detalle = excluded.detalle, diagnosticado_msg = excluded.diagnosticado_msg, updated_at = excluded.updated_at`)
      .run({ id: conv.id, ...perfil, evidencia: d.evidencia, origen: d.origen, grupo, estado, detalle, sin: perfil.toques_sin_respuesta, msg, at });
    db.prepare('INSERT INTO captacion_diagnosticos (conversation_id, nivel, motivo, freno, ruta, origen, evidencia, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(conv.id, d.nivel, d.motivo, d.freno, d.ruta, d.origen, d.evidencia, at);
    cancelarToques(db, conv.id, 'nuevo diagnóstico', ahora);
    const ins = db.prepare('INSERT INTO captacion_toques (conversation_id, orden, pieza, nivel, freno, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const t of plan) ins.run(conv.id, t.orden, t.pieza, d.nivel, d.freno, t.due_at, at);
  })();
  r.diagnosticados++; if (plan.length) r.planes++;
}

/**
 * Una vuelta completa: paradas, borradores de los toques vencidos y diagnóstico de los chats fríos.
 * `ia`: diagnosticar con el modelo (si no, por reglas). `redactar(convId, contexto)`: opcional, para que Sofía
 * adapte el texto de cada pieza. No envía nada a ningún lead ni escribe en GHL.
 */
export async function ciclo({ repo, ahora = new Date(), cfg = cargarConfig(), ia = false, complete = null, redactar = null, limite } = {}) {
  const r = { modo: MODO, paradas: 0, respuestas: 0, borradores: 0, aplazados: 0, diagnosticados: 0, planes: 0 };
  revisarParadas(repo.db, ahora, r);
  await prepararBorradores(repo.db, ahora, cfg, r, { redactar });
  await diagnosticarFrios(repo, ahora, cfg, r, { ia, complete, limite });
  return r;
}

// ---------- Panel ----------

/** Material real que piden las piezas y si ya está subido en Recursos (con ese mismo nombre). */
export function materialPendiente(db, cfg = cargarConfig()) {
  return Object.entries(cfg.material || {}).map(([clave, m]) => ({
    clave, ...m, disponible: Boolean(recursos.porNombre(db, clave)),
    piezas: cfg.piezas.filter((p) => p.material === clave).map((p) => p.nombre),
    borradores: db.prepare("SELECT count(*) n FROM captacion_toques WHERE material_falta = ? AND estado = 'borrador'").get(clave).n,
  }));
}

/** Todo lo que enseña la pestaña Captación. */
export function datosPanel(db, { cfg = cargarConfig(), activa = Boolean(config.captacion?.activa) } = {}) {
  const todos = (sql, ...p) => db.prepare(sql).all(...p);
  const nombres = Object.fromEntries(cfg.piezas.map((p) => [p.id, p.nombre]));
  const porGrupo = Object.fromEntries(['tratamiento', 'control'].map((g) => [g, { leads: 0, respondieron: 0, altas: 0, suben: 0 }]));
  for (const f of todos(`SELECT grupo, count(*) leads, sum(respondio_at IS NOT NULL) respondieron, sum(estado = 'parado' AND detalle = 'alta') altas, sum(nivel > nivel_inicial) suben
      FROM captacion_perfiles GROUP BY grupo`)) porGrupo[f.grupo] = f;
  const toque = (t) => ({ ...t, pieza_nombre: nombres[t.pieza] || t.pieza });
  const conLead = `SELECT t.*, c.nombre, c.channel, c.sede, p.motivo FROM captacion_toques t
    LEFT JOIN conversations c ON c.id = t.conversation_id LEFT JOIN captacion_perfiles p ON p.conversation_id = t.conversation_id`;
  return {
    modo: MODO, activa,
    parametros: { control_pct: cfg.control_pct, diagnostico_dias: cfg.diagnostico_dias, max_sin_respuesta: cfg.max_sin_respuesta, cadencias: cfg.cadencias, antiguedad_max_dias: cfg.antiguedad_max_dias },
    total: db.prepare('SELECT count(*) n FROM captacion_perfiles').get().n,
    niveles: Object.keys(NIVELES).map(Number).map((n) => ({
      nivel: n, nombre: NIVELES[n],
      tratamiento: db.prepare("SELECT count(*) n FROM captacion_perfiles WHERE nivel = ? AND grupo = 'tratamiento'").get(n).n,
      control: db.prepare("SELECT count(*) n FROM captacion_perfiles WHERE nivel = ? AND grupo = 'control'").get(n).n,
    })),
    frenos: todos('SELECT freno, count(*) n FROM captacion_perfiles GROUP BY freno ORDER BY n DESC'),
    motivos: todos('SELECT motivo, count(*) n FROM captacion_perfiles GROUP BY motivo ORDER BY n DESC'),
    estados: Object.fromEntries(todos('SELECT estado, count(*) n FROM captacion_perfiles GROUP BY estado').map((x) => [x.estado, x.n])),
    grupos: porGrupo,
    borradores: todos(`${conLead} WHERE t.estado = 'borrador' ORDER BY t.resuelto_at DESC, t.id DESC LIMIT 100`).map(toque),
    proximos: todos(`${conLead} WHERE t.estado = 'previsto' ORDER BY t.due_at, t.id LIMIT 100`).map(toque),
    perfiles: todos(`SELECT p.*, c.nombre, c.channel, c.sede, c.valoracion FROM captacion_perfiles p LEFT JOIN conversations c ON c.id = p.conversation_id ORDER BY p.updated_at DESC LIMIT 200`),
    material: materialPendiente(db, cfg),
  };
}
