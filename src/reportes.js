// Reportes (como en Zapp): el equipo reporta una respuesta de Sofía que no le gusta y el optimizador lo convierte
// en un cambio de sus instrucciones, comprobado antes de aplicarlo.
//
//   1. Diagnóstico (modelo optimizador): ¿hay que cambiar las instrucciones, ya lo decían, no es cosa del prompt,
//      o falta un dato (pregunta al equipo)? Si hay que cambiar, propone cambios mínimos «buscar → reemplazar».
//   2. Comprobación: repite la conversación hasta ese punto con las instrucciones cambiadas y otro análisis juzga
//      si la nueva respuesta arregla lo reportado sin estropear nada. Si no, un segundo intento con lo aprendido.
//   3. Aplicar (un clic en el panel): nueva versión del prompt o de la base de conocimiento en producción.
import { openDb, repo as crearRepo, apuntarUso } from './db.js';
import { Setter } from './setter.js';
import { pedirJSON } from './llm.js';
import * as docs from './documentos.js';
import { casoDesdeReporte } from './bateria.js';
import { Etiquetador } from './etiquetas.js';
import { knowledge } from './knowledge.js';

/** Apunta en ai_runs lo que gasta el optimizador (para Consumo). */
const registrar = (db, id, motivo) => (uso) => apuntarUso(db, { conversation_id: `reporte-${id}`, motivo, ...uso });
const json = (t, d = null) => { try { return t ? JSON.parse(t) : d; } catch { return d; } };
export const ESTADOS = {
  recibido: 'Recibido', analizando: 'Analizando…', duda: 'Necesita un dato', propuesto: 'Cambio listo para aplicar', aplicado: 'Aplicado',
  sin_cambio: 'Ya estaba en las instrucciones', no_prompt: 'No se arregla en las instrucciones', fallido: 'Ningún cambio funcionó', descartado: 'Descartado', error: 'Error al analizar',
};

const fila = (r) => r && ({ ...r, contexto: json(r.contexto, []), propuesta: json(r.propuesta), comprobacion: json(r.comprobacion) });
export const obtener = (db, id) => fila(db.prepare('SELECT * FROM reportes WHERE id = ?').get(id));
export const listar = (db, { estado } = {}) => db.prepare(`SELECT id, origen, conversation_id, respuesta_ia, que_fallo, estado, clasificacion, version_aplicada, created_at, updated_at FROM reportes
  ${estado ? 'WHERE estado = ?' : ''} ORDER BY id DESC LIMIT 200`).all(...(estado ? [estado] : []));
const actualizar = (db, id, patch) => {
  const k = Object.keys(patch);
  db.prepare(`UPDATE reportes SET ${k.map((x) => `${x} = @${x}`).join(', ')}, updated_at = datetime('now') WHERE id = @__id`)
    .run({ ...Object.fromEntries(k.map((x) => [x, patch[x] !== null && typeof patch[x] === 'object' ? JSON.stringify(patch[x]) : patch[x]])), __id: id });
};

/**
 * Crea un reporte. `contexto`: la conversación hasta la respuesta reportada (incluida), como
 * [{ autor, texto, adjunto?, transcripcion? }], y `meta` con canal, nombre y sede.
 */
export function crear(db, d) {
  const que = String(d.que_fallo || '').trim();
  if (!que) throw new Error('Cuenta qué ha fallado.');
  const r = db.prepare(`INSERT INTO reportes (origen, conversation_id, message_id, respuesta_ia, contexto, que_fallo, que_esperaba, texto_exacto)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    ['chat', 'prueba', 'general'].includes(d.origen) ? d.origen : 'general', d.conversation_id || null, d.message_id || null,
    d.respuesta_ia || null, JSON.stringify({ meta: d.meta || {}, mensajes: d.contexto || [] }), que.slice(0, 2000),
    String(d.que_esperaba || '').trim().slice(0, 2000) || null, String(d.texto_exacto || '').trim().slice(0, 2000) || null,
  );
  return Number(r.lastInsertRowid);
}

/** La conversación de un chat hasta un mensaje (incluido), para guardarla con el reporte. */
export function instantanea(db, convId, hastaMsgId) {
  const conv = db.prepare('SELECT channel, nombre, sede, tipo, fase FROM conversations WHERE id = ?').get(convId) || {};
  const mensajes = db.prepare(`SELECT id, autor, texto, adjunto, transcripcion FROM messages WHERE conversation_id = ? AND autor != 'sistema' ${hastaMsgId ? 'AND id <= ?' : ''} ORDER BY id`)
    .all(...[convId, ...(hastaMsgId ? [hastaMsgId] : [])]);
  return { meta: conv, mensajes };
}

// ---------- Optimizador ----------

const SISTEMA_DIAGNOSTICO = `Eres el optimizador de las instrucciones de Sofía, la setter por WhatsApp e Instagram de CrossFit MetroPolitano.
Sofía funciona con dos documentos: el PROMPT (cómo se comporta: estilo, proceso de venta, reglas, cuándo derivar…) y la BASE DE CONOCIMIENTO (datos del negocio: sedes, servicios, condiciones, precios de referencia…). Los horarios y tarifas exactos los consulta con herramientas que leen AimHarder; los festivos se añaden aparte.

El equipo ha reportado una respuesta de Sofía. Tu trabajo es decidir qué hacer y, si toca, proponer el cambio MÍNIMO en las instrucciones para que no vuelva a pasar en casos parecidos (no solo en este chat).

Clasifica:
- "cambiar": hay que cambiar el prompt o la base de conocimiento. Propón 1 a 3 cambios «buscar → reemplazar»:
  · «buscar» es un trozo COPIADO LITERALMENTE del documento (con sus saltos de línea y símbolos), que aparezca una sola vez; lo bastante largo para ser único y lo más corto posible.
  · «reemplazar» es ese trozo ya corregido. Para añadir una regla nueva, reemplaza una línea cercana por esa línea + la regla nueva. «buscar» vacío = añadir al final del documento.
  · Mantén el estilo, el formato y el idioma del documento. No reescribas secciones enteras. No contradigas otras reglas: si chocan, ajusta la otra también.
  · Generaliza: escribe la regla para el tipo de situación, no para este lead en concreto (nada de nombres propios del lead).
  · Si el equipo dio un texto exacto, inclúyelo tal cual como ejemplo de cómo decirlo, en el sitio adecuado.
  · Comportamiento → "prompt"; datos del negocio → "negocio".
- "ya_cubierto": las instrucciones ya dicen claramente lo correcto y fue un fallo puntual. Explica dónde lo dicen. No propongas cambios.
- "no_prompt": no se arregla con las instrucciones (configuración del panel, seguimientos, integraciones con GHL o AimHarder, datos que vienen de las herramientas, un problema técnico). Explica qué habría que revisar.
- "duda": falta un dato imprescindible del negocio para poder escribir la regla correcta (por ejemplo, un precio o una condición que no está en ningún sitio). Haz UNA pregunta concreta y corta al equipo. No preguntes lo que puedas deducir.

Escribe "explicacion" y "resumen" en español, claros y breves, para alguien que no es técnico.`;

const ESQUEMA_DIAGNOSTICO = {
  type: 'object', additionalProperties: false,
  required: ['clasificacion', 'explicacion', 'pregunta', 'documento', 'cambios', 'resumen'],
  properties: {
    clasificacion: { type: 'string', enum: ['cambiar', 'ya_cubierto', 'no_prompt', 'duda'] },
    explicacion: { type: 'string', description: 'Por qué pasó y qué se hace (2-4 frases).' },
    pregunta: { type: 'string', description: 'Solo si es "duda"; si no, vacío.' },
    documento: { type: 'string', enum: ['prompt', 'negocio'] },
    cambios: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['buscar', 'reemplazar'], properties: { buscar: { type: 'string' }, reemplazar: { type: 'string' } } } },
    resumen: { type: 'string', description: 'El cambio en una frase (para el historial de versiones). Vacío si no hay cambio.' },
  },
};

const SISTEMA_JUEZ = `Comparas dos respuestas de Sofía (setter por chat de CrossFit MetroPolitano) en la misma conversación: la que el equipo reportó y la NUEVA, generada con las instrucciones corregidas. Decide si la NUEVA resuelve lo que pide el reporte.

Cómo juzgar:
- "arreglado": la NUEVA ya no comete el fallo reportado y hace, en lo esencial, lo que el equipo pedía. No exijas que sea idéntica ni que use sus mismas palabras (el «texto exacto», si lo hay, es un ejemplo). Juzga solo lo que se reportó: no la suspendas por detalles de estilo o por cosas que el reporte no menciona.
- Sofía contesta en varias burbujas cortas (una por línea). La respuesta reportada puede ser solo una de las burbujas de su turno; la NUEVA es el turno entero.
- Sofía también actúa con herramientas (derivar al equipo, enviar un archivo, reservar una prueba, preparar un alta…). Lo que hizo en el turno nuevo está en <acciones_nuevas>: si el reporte pedía una acción, mira ahí si la hizo. En la comprobación esas herramientas están simuladas.
- "hay_problemas_nuevos": true solo si la NUEVA introduce un problema GRAVE que la reportada no tenía: un dato falso, una regla de sus instrucciones rota o un tono claramente impropio. Para saber si un dato es correcto mira las instrucciones, la base de conocimiento y las tarifas de abajo y lo que devolvieron sus herramientas: lo que está ahí no es inventado. Diferencias menores no cuentan. Si no hay ninguno, false y "problemas_nuevos" vacío.
Responde en español, con un motivo corto para alguien que no es técnico.`;

/** Sistema del juez: sus reglas y, cacheadas, las instrucciones (ya corregidas) y las tarifas con las que contesta Sofía. */
const sistemaJuez = (textos) => [
  { type: 'text', text: SISTEMA_JUEZ },
  { type: 'text', text: `<instrucciones_de_sofia>\n${textos.prompt || '(no disponibles)'}\n</instrucciones_de_sofia>\n\n<base_de_conocimiento>\n${textos.negocio || '(no disponible)'}\n</base_de_conocimiento>\n\n<tarifas>\n${JSON.stringify(knowledge.tarifas)}\n</tarifas>`, cache_control: { type: 'ephemeral' } },
];

const ESQUEMA_JUEZ = {
  type: 'object', additionalProperties: false, required: ['arreglado', 'motivo', 'hay_problemas_nuevos', 'problemas_nuevos'],
  properties: { arreglado: { type: 'boolean' }, motivo: { type: 'string' }, hay_problemas_nuevos: { type: 'boolean' }, problemas_nuevos: { type: 'string', description: 'Vacío si no hay.' } },
};

/** «Ninguno», «No hay», «N/A»… no son un problema: el juez a veces lo escribe en vez de dejarlo vacío. */
const SIN_PROBLEMAS = /^(no|ningun[oa]s?|nada|no hay( ningun[oa])?|no se (observan?|detectan?|aprecian?)( ningun[oa])?|sin problemas?( nuevos)?|n\/?a|vac[ií]o|-+)?( problemas?)?( nuevos?)?[\s.]*$/i;
export function problemasNuevos(juicio) {
  const texto = String(juicio?.problemas_nuevos ?? '').trim();
  const hay = typeof juicio?.hay_problemas_nuevos === 'boolean' ? juicio.hay_problemas_nuevos : !SIN_PROBLEMAS.test(texto);
  return hay ? (texto || 'El juez ve un problema nuevo, pero no lo ha descrito.') : '';
}

const AUTOR = { lead: 'LEAD', ia: 'SOFÍA', humano: 'EQUIPO' };
const conversacionTexto = (mensajes) => mensajes.map((m) => {
  const extra = m.adjunto === 'audio' ? ` [nota de voz: ${m.transcripcion || 'sin transcribir'}]` : m.adjunto ? ` [${m.adjunto}]` : '';
  return `${AUTOR[m.autor] || m.autor}: ${m.texto || ''}${extra}`;
}).join('\n');

function contenidoDiagnostico(r, textos, intentoPrevio) {
  const msgs = r.contexto.mensajes || [];
  return [
    `<prompt>\n${textos.prompt}\n</prompt>`,
    `<base_de_conocimiento>\n${textos.negocio}\n</base_de_conocimiento>`,
    `<conversacion canal="${r.contexto.meta?.channel || '?'}" sede="${r.contexto.meta?.sede || 'sin sede'}">\n${conversacionTexto(msgs.slice(0, -1)) || '(sin mensajes anteriores)'}\n</conversacion>`,
    `<respuesta_reportada>\n${r.respuesta_ia || msgs.at(-1)?.texto || '(no indicada: es un reporte general)'}\n</respuesta_reportada>`,
    `<reporte>\nQué ha fallado: ${r.que_fallo}\n${r.que_esperaba ? `Qué debería haber hecho: ${r.que_esperaba}\n` : ''}${r.texto_exacto ? `Texto exacto que quieren: «${r.texto_exacto}»\n` : ''}${r.pregunta && r.respuesta_usuario ? `Preguntaste: «${r.pregunta}» y el equipo respondió: «${r.respuesta_usuario}»\n` : ''}</reporte>`,
    intentoPrevio ? `<intento_anterior>\nYa probaste estos cambios en «${intentoPrevio.documento}»:\n${JSON.stringify(intentoPrevio.cambios, null, 1)}\nNo funcionó: ${intentoPrevio.motivo}\nLa respuesta que salió fue: «${intentoPrevio.despues}»\nPropón otra solución (puede ser más explícita o en otro sitio).\n</intento_anterior>` : '',
  ].filter(Boolean).join('\n\n');
}

/** Los mensajes anteriores al turno reportado (sin las burbujas de Sofía de ese turno). */
function mensajesPrevios(r) {
  const previos = [...(r.contexto.mensajes || [])];
  // Si Sofía contestó en varias burbujas seguidas, se quitan todas las de ese turno
  while (previos.length && previos.at(-1).autor === 'ia') previos.pop();
  return previos;
}

/**
 * Repite la conversación hasta justo antes de la respuesta reportada con otras instrucciones y devuelve lo que
 * Sofía haría ahora: { texto, acciones }. Es un turno completo de Sofía, con sus herramientas simuladas (derivar,
 * enviar un archivo, reservar…), en una base temporal en memoria: no toca ningún chat, GHL ni AimHarder.
 */
export async function repetir(r, textos, { complete, catalogo }) {
  // Lo que gasta Sofía al repetir la conversación se apunta también en la base real (Consumo), aunque falle
  const tmp = crearRepo(openDb(':memory:'), { espejo: { db: catalogo, campos: { conversation_id: `reporte-${r.id}`, motivo: 'reporte-comprobacion' } } });
  const meta = r.contexto.meta || {};
  const id = 'prueba-reporte';
  tmp.upsertConv({ id, contact_id: id, channel: meta.channel || 'whatsapp', nombre: meta.nombre || null, telefono: '+34600000000' });
  tmp.updateConv(id, { sede: meta.sede || null, tipo: meta.tipo || 'captacion', fase: meta.fase || null });
  for (const m of mensajesPrevios(r)) tmp.addMessage({ conversation_id: id, autor: m.autor, texto: m.texto, adjunto: m.adjunto || null, transcripcion: m.transcripcion || null });
  const avisos = [];
  const ghl = { sendMessage: async () => ({ messageId: null }), enviarAdjunto: async () => ({}), enviarPorPlantilla: async () => ({}), addTags: async () => {}, removeTags: async () => {}, assign: async () => {}, addNote: async () => {}, getContact: async () => ({ contact: {} }) };
  const setter = new Setter({
    repo: tmp, catalogo, complete, ghl, live: true, sleep: async () => {}, avisar: async (t) => avisos.push(t),
    etiquetas: new Etiquetador({ repo: tmp, catalogo, enviarMeta: async () => null }),
    aimharder: {
      buscarSocioPorTelefono: async () => ({ esSocio: false, sede: null }),
      prepararAlta: async (d) => ({ estado: 'preparada', pendiente: d.primer_recibo ?? 22.67, tarifa: d.tarifa, detalle: 'alta simulada (comprobación de un reporte)' }),
      fichaEnSede: async () => null,
    },
  });
  // Las instrucciones con el cambio propuesto todavía no están guardadas como versión: se le pasan tal cual
  const sistema = setter.sistema.bind(setter);
  setter.sistema = (conv, extra) => sistema(conv, extra, textos);
  const antes = tmp.ultimoMensajeId(id);
  const res = await setter.responder(id, { avisarFallo: false });
  const texto = tmp.db.prepare("SELECT texto FROM messages WHERE conversation_id = ? AND autor = 'ia' AND id > ? ORDER BY id").all(id, antes).map((m) => m.texto).filter(Boolean).join('\n');
  const c = tmp.getConv(id) || {};
  const acciones = {
    herramientas: (res?.turno?.herramientas || []).map((h) => ({ nombre: h.nombre, entrada: h.entrada })),
    derivado_al_equipo: Boolean(c.derivado), prueba_pedida: Boolean(c.prueba_reservada), alta: c.alta_estado || null, avisos_al_equipo: avisos,
  };
  return { texto, acciones };
}

/** Analiza un reporte de principio a fin. Guarda cada paso en la base para que el panel lo vaya viendo. */
export async function analizar(db, id, { complete, completeJSON } = {}) {
  const r = obtener(db, id);
  if (!r) return null;
  actualizar(db, id, { estado: 'analizando', error: null });
  try {
    const base = docs.textosActivos(db);
    const versionBase = { prompt: docs.enProduccion(db, 'prompt')?.version, negocio: docs.enProduccion(db, 'negocio')?.version };
    let previo = null;
    for (let intento = 1; intento <= 2; intento++) {
      let d = await pedirJSON({ system: SISTEMA_DIAGNOSTICO, contenido: contenidoDiagnostico(r, base, previo), schema: ESQUEMA_DIAGNOSTICO, complete: completeJSON, onUsage: registrar(db, id, 'reporte') });
      if (d.clasificacion === 'duda') {
        actualizar(db, id, { estado: 'duda', clasificacion: 'duda', explicacion: d.explicacion, pregunta: d.pregunta || '¿Puedes darnos algo más de detalle?' });
        return obtener(db, id);
      }
      if (d.clasificacion === 'ya_cubierto' || d.clasificacion === 'no_prompt') {
        actualizar(db, id, { estado: d.clasificacion === 'ya_cubierto' ? 'sin_cambio' : 'no_prompt', clasificacion: d.clasificacion, explicacion: d.explicacion });
        return obtener(db, id);
      }
      // Cambios: deben poder aplicarse tal cual; si no, se le devuelve el error una vez
      let nuevo;
      try { nuevo = docs.aplicarCambios(base[d.documento], d.cambios); }
      catch (e) {
        d = await pedirJSON({ system: SISTEMA_DIAGNOSTICO, contenido: `${contenidoDiagnostico(r, base, previo)}\n\n<error_de_tu_propuesta>${e.message} Copia «buscar» literalmente del documento.</error_de_tu_propuesta>`, schema: ESQUEMA_DIAGNOSTICO, complete: completeJSON, onUsage: registrar(db, id, 'reporte') });
        if (d.clasificacion !== 'cambiar' || !d.cambios?.length) throw new Error('No se ha podido preparar un cambio que encaje en las instrucciones.');
        nuevo = docs.aplicarCambios(base[d.documento], d.cambios); // si vuelve a fallar, el error se guarda en el reporte
      }
      if (!d.cambios?.length) throw new Error('El optimizador no ha propuesto ningún cambio.');
      const propuesta = { doc: d.documento, cambios: d.cambios, resumen: d.resumen, version_base: versionBase[d.documento] };
      actualizar(db, id, { clasificacion: 'cambiar', explicacion: d.explicacion, propuesta });
      // Comprobación. Sin ningún mensaje del lead (reporte general, o de la primera burbuja de Sofía) no hay
      // conversación que repetir: el cambio queda listo para que el equipo lo revise y lo aplique.
      if (!mensajesPrevios(r).some((m) => m.autor === 'lead')) {
        actualizar(db, id, { estado: 'propuesto', comprobacion: { antes: r.respuesta_ia || '', despues: '', arreglado: null, sin_conversacion: true, motivo: 'No hay conversación que repetir para comprobarlo: revisa el cambio antes de aplicarlo.', problemas_nuevos: '', intentos: intento } });
        return obtener(db, id);
      }
      const textosNuevos = { ...base, [d.documento]: nuevo };
      const { texto: despues, acciones } = await repetir(r, textosNuevos, { complete, catalogo: db });
      const hizo = acciones.herramientas.length || acciones.derivado_al_equipo || acciones.prueba_pedida || acciones.alta;
      const juicio = await pedirJSON({
        system: sistemaJuez(textosNuevos), schema: ESQUEMA_JUEZ, complete: completeJSON, onUsage: registrar(db, id, 'reporte'),
        contenido: `<conversacion>\n${conversacionTexto(mensajesPrevios(r)) || '(sin mensajes anteriores)'}\n</conversacion>\n<reporte>\nQué falló: ${r.que_fallo}\n${r.que_esperaba ? `Qué esperaban: ${r.que_esperaba}\n` : ''}${r.texto_exacto ? `Texto exacto: «${r.texto_exacto}»\n` : ''}${r.respuesta_usuario ? `Aclaración: ${r.respuesta_usuario}\n` : ''}</reporte>\n<respuesta_reportada>\n${r.respuesta_ia || ''}\n</respuesta_reportada>\n<respuesta_nueva>\n${despues || '(no envía nada)'}\n</respuesta_nueva>\n<acciones_nuevas>\n${hizo ? JSON.stringify(acciones, null, 1) : '(ninguna: solo ha contestado)'}\n</acciones_nuevas>`,
      });
      const problemas = problemasNuevos(juicio);
      const comprobacion = { antes: r.respuesta_ia || '', despues, acciones: acciones.herramientas.map((h) => h.nombre), arreglado: Boolean(juicio.arreglado && !problemas), motivo: juicio.motivo, problemas_nuevos: problemas, intentos: intento };
      actualizar(db, id, { comprobacion });
      if (comprobacion.arreglado) { actualizar(db, id, { estado: 'propuesto' }); return obtener(db, id); }
      previo = { documento: d.documento, cambios: d.cambios, motivo: [juicio.motivo, problemas].filter(Boolean).join(' '), despues };
    }
    actualizar(db, id, { estado: 'fallido' });
    return obtener(db, id);
  } catch (e) {
    console.error(`Reporte ${id}:`, e.message);
    actualizar(db, id, { estado: 'error', error: e.message });
    return obtener(db, id);
  }
}

/** El equipo responde a la pregunta del optimizador: se vuelve a analizar con ese dato. */
export function responder(db, id, respuesta) {
  const r = obtener(db, id);
  if (!r || r.estado !== 'duda') throw new Error('Ese reporte no está esperando respuesta.');
  const t = String(respuesta || '').trim();
  if (!t) throw new Error('Escribe la respuesta.');
  actualizar(db, id, { respuesta_usuario: t.slice(0, 2000), estado: 'recibido' });
}

/** Aplica el cambio propuesto: nueva versión en producción. Falla si las instrucciones cambiaron y ya no encaja. */
export function aplicar(db, id, { aunqueFallido = false } = {}) {
  const r = obtener(db, id);
  if (!r?.propuesta) throw new Error('Ese reporte no tiene ningún cambio que aplicar.');
  if (!['propuesto', ...(aunqueFallido ? ['fallido'] : [])].includes(r.estado)) throw new Error('Ese cambio no se puede aplicar ahora.');
  const actual = docs.enProduccion(db, r.propuesta.doc);
  let texto;
  try { texto = docs.aplicarCambios(actual.texto, r.propuesta.cambios); }
  catch (e) { throw new Error(`Las instrucciones han cambiado desde que se preparó: ${e.message} Vuelve a analizarlo.`); }
  const v = docs.crearVersion(db, r.propuesta.doc, texto, { nota: `Reporte #${id}: ${r.propuesta.resumen || r.que_fallo}`.slice(0, 300), autor: 'reporte', reporteId: id, produccion: true });
  actualizar(db, id, { estado: 'aplicado', version_aplicada: v.version });
  // El reporte pasa a ser un caso de la batería: un cambio posterior no debe deshacer este arreglo
  try { casoDesdeReporte(db, r); } catch (e) { console.error('Caso desde reporte:', e.message); }
  return v;
}

export function descartar(db, id) { actualizar(db, id, { estado: 'descartado' }); }
