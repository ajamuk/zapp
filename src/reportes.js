// Reportes (como en Zapp): el equipo reporta una respuesta de Sofía que no le gusta y el optimizador lo convierte
// en un cambio de sus instrucciones, comprobado antes de aplicarlo.
//
//   1. Diagnóstico (modelo optimizador): ¿hay que cambiar las instrucciones, ya lo decían, no es cosa del prompt,
//      o falta un dato (pregunta al equipo)? Si hay que cambiar, propone cambios mínimos «buscar → reemplazar».
//   2. Comprobación: repite la conversación hasta ese punto con las instrucciones cambiadas y otro análisis juzga
//      si la nueva respuesta arregla lo reportado sin estropear nada. Si no, un segundo intento con lo aprendido.
//   3. Aplicar (un clic en el panel): nueva versión del prompt o de la base de conocimiento en producción.
import { openDb, repo as crearRepo } from './db.js';
import { Setter } from './setter.js';
import { pedirJSON } from './llm.js';
import * as docs from './documentos.js';

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

const SISTEMA_JUEZ = `Comparas dos respuestas de Sofía (setter de CrossFit MetroPolitano) en la misma conversación: la que el equipo reportó y la nueva, generada con las instrucciones corregidas. Decide si la NUEVA resuelve lo que pide el reporte sin introducir problemas nuevos (datos inventados, tono distinto al de Sofía, reglas rotas). No exijas que sea idéntica a lo que pidió el equipo: basta con que haga lo que se pedía. Responde en español.`;

const ESQUEMA_JUEZ = {
  type: 'object', additionalProperties: false, required: ['arreglado', 'motivo', 'problemas_nuevos'],
  properties: { arreglado: { type: 'boolean' }, motivo: { type: 'string' }, problemas_nuevos: { type: 'string', description: 'Vacío si no hay.' } },
};

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

/**
 * Repite la conversación hasta justo antes de la respuesta reportada con otras instrucciones y devuelve lo que
 * Sofía contestaría ahora. Corre en una base temporal en memoria: no toca ningún chat.
 */
export async function repetir(r, textos, { complete, catalogo }) {
  const tmp = crearRepo(openDb(':memory:'));
  const meta = r.contexto.meta || {};
  tmp.upsertConv({ id: 'reporte', contact_id: 'reporte', channel: meta.channel || 'whatsapp', nombre: meta.nombre || null });
  tmp.updateConv('reporte', { sede: meta.sede || null, tipo: meta.tipo || 'captacion', fase: meta.fase || null });
  const msgs = r.contexto.mensajes || [];
  const previos = r.respuesta_ia && msgs.at(-1)?.autor === 'ia' ? msgs.slice(0, -1) : msgs;
  // Si Sofía contestó en varias burbujas seguidas, se quitan todas las de ese turno
  while (previos.length && previos.at(-1).autor === 'ia') previos.pop();
  for (const m of previos) tmp.addMessage({ conversation_id: 'reporte', autor: m.autor, texto: m.texto, adjunto: m.adjunto || null, transcripcion: m.transcripcion || null });
  const setter = new Setter({ repo: tmp, catalogo, complete, live: true, sleep: async () => {}, ghl: {}, aimharder: {} });
  return setter.redactar('reporte', '', { docs: textos });
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
      let d = await pedirJSON({ system: SISTEMA_DIAGNOSTICO, contenido: contenidoDiagnostico(r, base, previo), schema: ESQUEMA_DIAGNOSTICO, complete: completeJSON });
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
        d = await pedirJSON({ system: SISTEMA_DIAGNOSTICO, contenido: `${contenidoDiagnostico(r, base, previo)}\n\n<error_de_tu_propuesta>${e.message} Copia «buscar» literalmente del documento.</error_de_tu_propuesta>`, schema: ESQUEMA_DIAGNOSTICO, complete: completeJSON });
        if (d.clasificacion !== 'cambiar' || !d.cambios?.length) throw new Error('No se ha podido preparar un cambio que encaje en las instrucciones.');
        nuevo = docs.aplicarCambios(base[d.documento], d.cambios); // si vuelve a fallar, el error se guarda en el reporte
      }
      if (!d.cambios?.length) throw new Error('El optimizador no ha propuesto ningún cambio.');
      const propuesta = { doc: d.documento, cambios: d.cambios, resumen: d.resumen, version_base: versionBase[d.documento] };
      actualizar(db, id, { clasificacion: 'cambiar', explicacion: d.explicacion, propuesta });
      // Comprobación
      const despues = await repetir(r, { ...base, [d.documento]: nuevo }, { complete, catalogo: db });
      const juicio = await pedirJSON({
        system: SISTEMA_JUEZ, schema: ESQUEMA_JUEZ, complete: completeJSON,
        contenido: `<conversacion>\n${conversacionTexto((r.contexto.mensajes || []).slice(0, -1))}\n</conversacion>\n<reporte>\nQué falló: ${r.que_fallo}\n${r.que_esperaba ? `Qué esperaban: ${r.que_esperaba}\n` : ''}${r.texto_exacto ? `Texto exacto: «${r.texto_exacto}»\n` : ''}${r.respuesta_usuario ? `Aclaración: ${r.respuesta_usuario}\n` : ''}</reporte>\n<respuesta_reportada>\n${r.respuesta_ia || ''}\n</respuesta_reportada>\n<respuesta_nueva>\n${despues || '(no envía nada)'}\n</respuesta_nueva>`,
      });
      const comprobacion = { antes: r.respuesta_ia || '', despues, arreglado: Boolean(juicio.arreglado && !juicio.problemas_nuevos), motivo: juicio.motivo, problemas_nuevos: juicio.problemas_nuevos, intentos: intento };
      actualizar(db, id, { comprobacion });
      if (comprobacion.arreglado) { actualizar(db, id, { estado: 'propuesto' }); return obtener(db, id); }
      previo = { documento: d.documento, cambios: d.cambios, motivo: [juicio.motivo, juicio.problemas_nuevos].filter(Boolean).join(' '), despues };
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
  return v;
}

export function descartar(db, id) { actualizar(db, id, { estado: 'descartado' }); }
