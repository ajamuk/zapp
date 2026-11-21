// Batería de pruebas del prompt: casos que Sofía tiene que resolver bien, para medir cada versión de sus
// instrucciones antes de ponerla en producción y saber si un cambio mejora o estropea algo.
//
// Casos (tabla casos_prueba):
//   - momento: una conversación hasta un punto; Sofía contesta una vez (los 32 reales de Zapp, y uno por cada
//     reporte aplicado, para que un arreglo no se deshaga después).
//   - escenario: un lead simulado por IA (perfil + primer mensaje) habla con Sofía varios turnos.
// Cada caso se pasa `repeticiones` veces (Sofía no contesta siempre igual). Pasa si no hay fallos automáticos
// (estilo, horas que no existen, precios donde no toca…) y un juez (IA) da por cumplidos todos sus criterios de sí/no.
// Grupo «reserva»: casos que no se usan para ajustar el prompt; sirven para comprobar que la mejora es real.
// Todo corre en bases temporales en memoria: no toca chats, GHL, AimHarder ni Meta.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { openDb, repo as crearRepo } from './db.js';
import { Setter } from './setter.js';
import { Etiquetador } from './etiquetas.js';
import { pedirJSON, pedirTexto } from './llm.js';
import * as docs from './documentos.js';
import { costeRun } from './panel.js';
import { comprobar, horasValidas } from '../scripts/evaluar.js';
import { normalizarSede } from './knowledge.js';

const json = (t, d) => { try { return t ? JSON.parse(t) : d; } catch { return d; } };
const fila = (c) => c && ({ ...c, contexto: json(c.contexto, []), criterios: json(c.criterios, []), activo: Boolean(c.activo), socio: Boolean(c.socio) });
const anonimo = (t) => String(t || '').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]').replace(/(\+?\d[\d\s-]{7,}\d)/g, '[teléfono]');
/** Reparto estable: uno de cada cuatro casos va a «reserva». */
export const grupoDe = (id) => (parseInt(crypto.createHash('md5').update(String(id)).digest('hex').slice(0, 4), 16) % 4 === 0 ? 'reserva' : 'ajuste');

// ---------- Casos ----------

const CRITERIOS_ZAPP = [
  'Responde a lo que el lead pregunta o pide en su último mensaje (no lo ignora ni cambia de tema)',
  'No inventa datos: precios, horarios y condiciones coinciden con lo que consultó o con la base de conocimiento',
  'Hace avanzar la conversación con una sola pregunta o un siguiente paso claro, sin pedir datos que no hacen falta todavía',
];

/** Carga los casos reales de Zapp y los escenarios del repo la primera vez (o los que falten). */
export function sembrarCasos(db, raiz = config.root) {
  const ins = db.prepare(`INSERT OR IGNORE INTO casos_prueba (id, nombre, tipo, canal, tema, contexto, perfil, apertura, turnos, socio, criterios, referencia, grupo, origen)
    VALUES (@id, @nombre, @tipo, @canal, @tema, @contexto, @perfil, @apertura, @turnos, @socio, @criterios, @referencia, @grupo, @origen)`);
  const base = { contexto: null, perfil: null, apertura: null, turnos: 5, socio: 0, referencia: null };
  let n = 0;
  db.transaction(() => {
    try {
      for (const l of fs.readFileSync(path.join(raiz, 'eval', 'casos-zapp.jsonl'), 'utf8').trim().split('\n')) {
        const c = JSON.parse(l);
        const ultimo = [...c.contexto].reverse().find(([r]) => r === 'lead')?.[1] || '';
        n += ins.run({ ...base, id: `zapp-${c.id}`, nombre: `${c.tema}: «${anonimo(ultimo).slice(0, 60)}»`, tipo: 'momento', canal: c.canal || 'whatsapp', tema: c.tema,
          contexto: JSON.stringify(c.contexto.map(([r, t]) => [r, anonimo(t)])), criterios: JSON.stringify(CRITERIOS_ZAPP), referencia: anonimo((c.zapp || []).join('\n')), grupo: grupoDe(c.id), origen: 'zapp' }).changes;
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    try {
      for (const e of JSON.parse(fs.readFileSync(path.join(raiz, 'eval', 'escenarios.json'), 'utf8'))) {
        n += ins.run({ ...base, id: `esc-${e.id}`, nombre: e.nombre, tipo: 'escenario', canal: e.canal || 'whatsapp', tema: e.tema, perfil: e.perfil, apertura: e.apertura, turnos: e.turnos || 5,
          socio: e.socio ? 1 : 0, criterios: JSON.stringify(e.criterios), grupo: e.grupo || grupoDe(e.id), origen: 'escenario' }).changes;
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  })();
  return n;
}

export const listarCasos = (db) => db.prepare('SELECT * FROM casos_prueba ORDER BY origen, tema, id').all().map(fila);
export const obtenerCaso = (db, id) => fila(db.prepare('SELECT * FROM casos_prueba WHERE id = ?').get(id));

export function validarCaso(d = {}) {
  const nombre = String(d.nombre || '').trim().slice(0, 120);
  if (!nombre) throw new Error('Ponle un nombre al caso.');
  const tipo = d.tipo === 'momento' ? 'momento' : 'escenario';
  const criterios = (Array.isArray(d.criterios) ? d.criterios : String(d.criterios || '').split('\n')).map((x) => String(x).trim()).filter(Boolean).slice(0, 8);
  if (!criterios.length) throw new Error('Escribe al menos un criterio (una frase que se pueda contestar con sí o no).');
  const out = { nombre, tipo, canal: d.canal === 'instagram' ? 'instagram' : 'whatsapp', tema: String(d.tema || 'otro').trim().slice(0, 30), criterios: JSON.stringify(criterios),
    grupo: d.grupo === 'reserva' ? 'reserva' : 'ajuste', activo: d.activo === false ? 0 : 1, socio: d.socio ? 1 : 0, turnos: Math.max(1, Math.min(8, Number(d.turnos) || 5)),
    contexto: null, perfil: null, apertura: null, referencia: String(d.referencia || '').trim().slice(0, 2000) || null };
  if (tipo === 'escenario') {
    out.perfil = String(d.perfil || '').trim().slice(0, 1500); out.apertura = String(d.apertura || '').trim().slice(0, 500);
    if (!out.perfil || !out.apertura) throw new Error('Un escenario necesita quién es el lead y su primer mensaje.');
  } else {
    const ctx = (Array.isArray(d.contexto) ? d.contexto : []).filter((x) => Array.isArray(x) && ['lead', 'ia', 'humano'].includes(x[0]) && x[1]);
    if (!ctx.some(([r]) => r === 'lead')) throw new Error('El caso necesita al menos un mensaje del lead.');
    out.contexto = JSON.stringify(ctx);
  }
  return out;
}

export function guardarCaso(db, d, id = null, origen = 'panel') {
  const c = validarCaso(id ? { ...obtenerCaso(db, id), ...d } : d);
  if (id) {
    db.prepare(`UPDATE casos_prueba SET nombre=@nombre, tipo=@tipo, canal=@canal, tema=@tema, contexto=@contexto, perfil=@perfil, apertura=@apertura, turnos=@turnos, socio=@socio,
      criterios=@criterios, referencia=@referencia, grupo=@grupo, activo=@activo WHERE id=@id`).run({ ...c, id });
    return obtenerCaso(db, id);
  }
  const nuevo = `${origen}-${crypto.randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO casos_prueba (id, nombre, tipo, canal, tema, contexto, perfil, apertura, turnos, socio, criterios, referencia, grupo, origen, activo)
    VALUES (@id, @nombre, @tipo, @canal, @tema, @contexto, @perfil, @apertura, @turnos, @socio, @criterios, @referencia, @grupo, @origen, @activo)`).run({ ...c, id: nuevo, origen });
  return obtenerCaso(db, nuevo);
}

export const borrarCaso = (db, id) => db.prepare('DELETE FROM casos_prueba WHERE id = ?').run(id).changes > 0;

/** Un reporte aplicado se convierte en caso: la misma conversación debe salir bien a partir de ahora. */
export function casoDesdeReporte(db, r) {
  const msgs = (r.contexto?.mensajes || []).filter((m) => ['lead', 'ia', 'humano'].includes(m.autor));
  while (msgs.length && msgs.at(-1).autor === 'ia') msgs.pop(); // sin la respuesta que se reportó
  if (!msgs.some((m) => m.autor === 'lead')) return null;
  const id = `reporte-${r.id}`;
  if (obtenerCaso(db, id)) return obtenerCaso(db, id);
  const criterios = [r.que_esperaba ? `Hace lo que pidió el equipo: ${r.que_esperaba}` : `No repite este fallo: ${r.que_fallo}`];
  if (r.que_esperaba) criterios.push(`No repite este fallo: ${r.que_fallo}`);
  db.prepare(`INSERT INTO casos_prueba (id, nombre, tipo, canal, tema, contexto, criterios, referencia, grupo, origen)
    VALUES (?, ?, 'momento', ?, 'reporte', ?, ?, ?, 'ajuste', 'reporte')`).run(id, `Reporte #${r.id}: ${r.que_fallo}`.slice(0, 120), r.contexto?.meta?.channel || 'whatsapp',
    JSON.stringify(msgs.map((m) => [m.autor, anonimo(m.adjunto === 'audio' && m.transcripcion ? m.transcripcion : m.texto)])), JSON.stringify(criterios), r.texto_exacto || null);
  return obtenerCaso(db, id);
}

// ---------- Ejecutar un caso ----------

const SISTEMA_LEAD = (c) => `Eres una persona real que escribe por ${c.canal === 'instagram' ? 'Instagram' : 'WhatsApp'} a un box de CrossFit de Madrid. Vas a hablar con la persona que atiende (se llama Sofía).

Quién eres y qué quieres:
${c.perfil}

Cómo escribes: como un cliente normal por chat, en español de España, mensajes cortos (una o dos frases), a veces sin tildes ni signos de apertura. Contestas a lo que te preguntan con lo que diría tu personaje (inventa datos coherentes si te los piden: nombre, email, fecha de nacimiento…). No eres un asistente: no ayudas, no das las gracias de más, no explicas que es una simulación. Sigue tu objetivo aunque te cambien de tema.

Cuando ya tengas lo que querías, cuando te digan que te escribirá una persona del equipo, o si la conversación ya no da más de sí, contesta solo con: [FIN]`;

const SISTEMA_JUEZ = `Evalúas una conversación entre Sofía (la setter por chat de CrossFit MetroPolitano, una IA) y un lead. Para cada criterio, decide si SE CUMPLE (true) o NO (false) mirando solo lo que hizo Sofía en la conversación y en la ficha técnica (herramientas que usó, etiquetas, estado del chat).
Reglas: sé estricto pero justo. Un criterio se cumple si Sofía hizo lo que dice, aunque lo exprese con otras palabras. Si el criterio habla de algo que no llegó a ocurrir porque la conversación no dio lugar a ello y no fue culpa de Sofía, márcalo como cumplido y dilo en el motivo. La «referencia» (si la hay) es orientativa: no hace falta que se parezca. Motivo: una frase corta en español, citando lo que dijo Sofía si ayuda.`;

const ESQUEMA_JUEZ = {
  type: 'object', additionalProperties: false, required: ['criterios'],
  properties: { criterios: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['n', 'cumple', 'motivo'], properties: { n: { type: 'integer' }, cumple: { type: 'boolean' }, motivo: { type: 'string' } } } } },
};

// Comprobaciones del script antiguo que dan falsos fallos (dependen del contexto): eso lo valora el juez
const NO_AUTOMATICOS = /preguntó el precio|habla de prueba fuera de Parla/;
const QUIEN = { lead: 'LEAD', ia: 'SOFÍA', humano: 'EQUIPO' };

/**
 * Pasa un caso una vez. Devuelve { pasa, fallosAuto, criterios, conversacion, estado, usd }.
 * `borradores`: { prompt: id, negocio: id } para probar versiones que no están en producción.
 */
export async function ejecutarCaso(db, caso, { complete, completeLead, completeJSON, borradores = null } = {}) {
  const tmp = crearRepo(openDb(':memory:'));
  const id = 'prueba-bateria';
  let usd = 0;
  const sumar = (u, modelo) => { usd += costeRun({ modelo, tokens_in: u.input_tokens, tokens_out: u.output_tokens, tokens_cache_read: u.cache_read_input_tokens, tokens_cache_write: u.cache_creation_input_tokens }); };
  const avisos = [];
  const ghl = { sendMessage: async () => ({ messageId: null }), enviarAdjunto: async () => ({}), enviarPorPlantilla: async () => ({}), addTags: async () => {}, removeTags: async () => {}, assign: async () => {}, addNote: async () => {}, getContact: async () => ({ contact: {} }) };
  const etiquetas = new Etiquetador({ repo: tmp, catalogo: db, enviarMeta: async () => null }); // sin GHL ni Meta
  const setter = new Setter({
    repo: tmp, catalogo: db, borradores, complete, ghl, etiquetas, live: true, sleep: async () => {}, avisar: async (t) => avisos.push(t),
    aimharder: {
      buscarSocioPorTelefono: async () => ({ esSocio: caso.socio, sede: caso.socio ? 'Getafe' : null }),
      prepararAlta: async (d) => ({ estado: 'preparada', pendiente: 22.67, tarifa: d.tarifa, detalle: 'alta simulada (batería de pruebas)' }),
      fichaEnSede: async () => null,
    },
  });
  tmp.upsertConv({ id, contact_id: id, channel: caso.canal, telefono: '+34600000000' });
  const turnosSofia = []; const herramientas = [];
  const responder = async () => {
    const antes = tmp.ultimoMensajeId(id);
    const r = await setter.responder(id);
    herramientas.push(...(r?.turno?.herramientas || []).map((h) => h.nombre));
    const nuevos = tmp.db.prepare("SELECT texto FROM messages WHERE conversation_id = ? AND autor = 'ia' AND id > ? ORDER BY id").all(id, antes).map((m) => m.texto);
    turnosSofia.push(nuevos);
    return nuevos;
  };

  if (caso.tipo === 'momento') {
    tmp.updateConv(id, { tipo: 'captacion' });
    for (const [autor, texto] of caso.contexto) tmp.addMessage({ conversation_id: id, autor, texto });
    await responder();
  } else {
    let entrada = caso.apertura;
    for (let t = 0; t < caso.turnos && entrada; t++) {
      const r1 = await setter.onInbound({ conversationId: id, contactId: id, canal: caso.canal, texto: entrada, messageId: crypto.randomUUID(), telefono: '+34600000000' });
      if (r1?.socio) break; // socio: Sofía no contesta
      const c = tmp.getConv(id);
      if (c.ai_paused || c.derivado) break;
      tmp.updateConv(id, { respond_at: null });
      await responder();
      if (tmp.getConv(id).derivado || t === caso.turnos - 1) break;
      // El lead simulado ve la conversación con los papeles cambiados
      const hist = tmp.db.prepare("SELECT autor, texto FROM messages WHERE conversation_id = ? AND autor IN ('lead', 'ia') ORDER BY id").all(id);
      const msgs = [];
      for (const m of hist) { const role = m.autor === 'lead' ? 'assistant' : 'user'; if (msgs.at(-1)?.role === role) msgs.at(-1).content += `\n${m.texto}`; else msgs.push({ role, content: m.texto }); }
      if (msgs[0]?.role === 'assistant') msgs.unshift({ role: 'user', content: '(empieza tú la conversación)' });
      const sig = await pedirTexto({ system: SISTEMA_LEAD(caso), messages: msgs, complete: completeLead, onUsage: sumar });
      entrada = /\[FIN\]/i.test(sig) ? null : sig.replace(/\[FIN\]/gi, '').trim();
    }
  }

  const c = tmp.getConv(id);
  const conversacion = tmp.db.prepare("SELECT autor, texto FROM messages WHERE conversation_id = ? AND autor != 'sistema' ORDER BY id").all(id);
  const etqs = tmp.db.prepare('SELECT etiqueta_id FROM conv_etiquetas WHERE conversation_id = ?').all(id).map((e) => db.prepare('SELECT nombre FROM etiquetas WHERE id = ?').get(e.etiqueta_id)?.nombre).filter(Boolean);
  const estado = { tipo: c.tipo, fase: c.fase, sede: c.sede, derivado: Boolean(c.derivado), pausada: Boolean(c.ai_paused), motivo_pausa: c.pause_reason, prueba_pedida: Boolean(c.prueba_reservada), alta: c.alta_estado, lo_deja_para: json(c.retomar, null)?.fecha || null,
    herramientas, etiquetas: etqs, avisos_al_equipo: avisos.length, seguimientos_programados: tmp.db.prepare("SELECT regla_id FROM scheduled WHERE estado = 'pendiente'").all().map((s) => s.regla_id) };
  for (const x of tmp.db.prepare('SELECT * FROM ai_runs').all()) usd += costeRun(x);

  // Comprobaciones automáticas, turno a turno de Sofía
  // La sede es la que quedó en la ficha del chat o, si no, la que nombró el lead: nunca la que Sofía enumera al preguntar.
  const sedeCaso = sedeDe(c.sede, conversacion);
  const fallosAuto = new Set();
  let visto = 0; const ctx = [];
  for (const m of conversacion) {
    if (m.autor === 'ia' && turnosSofia[visto]?.[0] === m.texto) { for (const f of comprobar({ contexto: ctx.length ? ctx : [['lead', '']], sede: sedeCaso }, turnosSofia[visto])) if (!NO_AUTOMATICOS.test(f)) fallosAuto.add(f); visto++; }
    ctx.push([m.autor, m.texto]);
  }
  if (caso.tipo === 'momento' && !turnosSofia[0]?.length) fallosAuto.add('Sofía no contestó nada');

  // Juez
  const j = await pedirJSON({
    system: SISTEMA_JUEZ, schema: ESQUEMA_JUEZ, complete: completeJSON, onUsage: sumar,
    contenido: `<conversacion canal="${caso.canal}">\n${conversacion.map((m) => `${QUIEN[m.autor] || m.autor}: ${m.texto}`).join('\n')}${caso.tipo === 'escenario' && c.tipo === 'socio' ? '\n(Sofía no contestó: el sistema detectó que es socio, la pausó y avisó al equipo)' : ''}\n</conversacion>\n\n<ficha_tecnica>\n${JSON.stringify(estado, null, 1)}\n</ficha_tecnica>${caso.referencia ? `\n\n<referencia>\n${caso.referencia}\n</referencia>` : ''}\n\n<criterios>\n${caso.criterios.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n</criterios>`,
  });
  const criterios = caso.criterios.map((t, i) => { const r = (j.criterios || []).find((x) => x.n === i + 1); return { criterio: t, cumple: Boolean(r?.cumple), motivo: r?.motivo || 'el juez no lo valoró' }; });
  return { pasa: fallosAuto.size === 0 && criterios.every((x) => x.cumple), fallosAuto: [...fallosAuto], criterios, conversacion, estado, usd };
}

export const sedeDe = (sedeFicha, conversacion) => sedeFicha || normalizarSede(conversacion.filter((m) => m.autor === 'lead').map((m) => m.texto).join('\n')) || null;

/**
 * Repasa los resultados guardados con la sede bien calculada: quita los avisos de «horas que no existen» que
 * salieron por mirar la sede equivocada y recuenta las pasadas. Se puede ejecutar las veces que haga falta.
 */
export function recalcularHoras(db) {
  let cambiados = 0;
  for (const r of db.prepare("SELECT * FROM bateria_resultados WHERE fallos_auto LIKE '%horas que no existen%'").all()) {
    const sede = sedeDe(json(r.estado, {}).sede, json(r.conversacion, []));
    const validas = sede && sede !== 'el_canaveral' ? horasValidas(sede) : null;
    const malas = new Set();
    const resto = json(r.fallos_auto, []).filter((f) => {
      const m = f.match(/^horas que no existen en \S+: (.+)$/); if (!m) return true;
      if (validas) for (const h of m[1].split(', ')) if (!validas.has(h)) malas.add(h);
      return false;
    });
    if (malas.size) resto.push(`horas que no existen en ${sede}: ${[...malas].join(', ')}`);
    const pasa = resto.length === 0 && json(r.criterios, []).every((x) => x.cumple) && !r.error ? 1 : 0;
    if (JSON.stringify(resto) !== r.fallos_auto || pasa !== r.pasa) { db.prepare('UPDATE bateria_resultados SET fallos_auto = ?, pasa = ? WHERE id = ?').run(JSON.stringify(resto), pasa, r.id); cambiados++; }
  }
  db.prepare('UPDATE bateria_pasadas SET pasan = (SELECT IFNULL(sum(pasa), 0) FROM bateria_resultados WHERE pasada_id = bateria_pasadas.id)').run();
  return cambiados;
}

// ---------- Pasadas ----------

export const SIN_SERVICIO = /credit balance|usage limits?|authentication_error|permission_error|invalid x-api-key|\b40[13]\b/i;
const enMarcha = new Map(); // pasada → { cancelar }

/** Casos que entran en una pasada según el filtro { grupo, tema, ids }. */
export function casosDePasada(db, filtro = {}) {
  return listarCasos(db).filter((c) => c.activo && (!filtro.grupo || c.grupo === filtro.grupo) && (!filtro.tema || c.tema === filtro.tema) && (!filtro.ids?.length || filtro.ids.includes(c.id)));
}

/** Crea la pasada y la ejecuta en segundo plano (3 casos a la vez). Devuelve su id al momento. */
export function lanzarPasada(db, { borradores = null, repeticiones = 2, filtro = {}, complete, completeLead, completeJSON, alTerminar } = {}) {
  const casos = casosDePasada(db, filtro);
  if (!casos.length) throw new Error('No hay casos activos con ese filtro.');
  const reps = Math.max(1, Math.min(5, Number(repeticiones) || 2));
  const bor = {}; for (const d of Object.keys(docs.DOCS)) { const v = borradores?.[d] ? docs.obtener(db, Number(borradores[d])) : null; if (v && v.doc === d && v.estado !== 'produccion') bor[d] = v.id; }
  const v = docs.versionesActivas(db, bor);
  const id = Number(db.prepare('INSERT INTO bateria_pasadas (prompt_v, negocio_v, borradores, repeticiones, filtro, total) VALUES (?, ?, ?, ?, ?, ?)')
    .run(v.prompt, v.negocio, Object.keys(bor).length ? JSON.stringify(bor) : null, reps, JSON.stringify(filtro), casos.length * reps).lastInsertRowid);
  const cola = casos.flatMap((c) => Array.from({ length: reps }, (_, i) => [c, i + 1]));
  const ctl = { cancelada: false }; enMarcha.set(id, ctl);
  const ins = db.prepare('INSERT INTO bateria_resultados (pasada_id, caso_id, repeticion, pasa, fallos_auto, criterios, conversacion, estado, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const obrero = async () => {
    for (let t; !ctl.cancelada && (t = cola.shift());) {
      const [caso, rep] = t; let r = null; let error = null;
      try { r = await ejecutarCaso(db, caso, { complete, completeLead, completeJSON, borradores: Object.keys(bor).length ? bor : null }); } catch (e) { error = e.message; }
      // Sin saldo o sin permiso en la API no hay nada que medir: se para la pasada en vez de apuntar fallos que no son de Sofía.
      if (error && SIN_SERVICIO.test(error)) { ctl.cancelada = true; ctl.error = 'La IA no está disponible (saldo agotado, límite mensual de gasto alcanzado o clave sin permiso). La pasada se ha parado: los casos que faltan no cuentan.'; return; }
      ins.run(id, caso.id, rep, r?.pasa ? 1 : 0, JSON.stringify(r?.fallosAuto || []), JSON.stringify(r?.criterios || []), JSON.stringify(r?.conversacion || []), JSON.stringify(r?.estado || {}), error);
      db.prepare('UPDATE bateria_pasadas SET hechos = hechos + 1, pasan = pasan + ?, usd = usd + ? WHERE id = ?').run(r?.pasa ? 1 : 0, r?.usd || 0, id);
    }
  };
  const fin = Promise.all([obrero(), obrero(), obrero()]).then(() => {
    db.prepare("UPDATE bateria_pasadas SET estado = ?, terminado_at = datetime('now') WHERE id = ?").run(ctl.error ? 'error' : ctl.cancelada ? 'cancelada' : 'terminada', id);
    if (ctl.error) db.prepare('UPDATE bateria_pasadas SET error = ? WHERE id = ?').run(ctl.error, id);
  }).catch((e) => {
    db.prepare("UPDATE bateria_pasadas SET estado = 'error', error = ?, terminado_at = datetime('now') WHERE id = ?").run(e.message, id);
  }).finally(() => { enMarcha.delete(id); alTerminar?.(id); });
  return { id, total: casos.length * reps, fin };
}

export function cancelarPasada(db, id) {
  const c = enMarcha.get(id);
  if (c) { c.cancelada = true; return true; }
  return db.prepare("UPDATE bateria_pasadas SET estado = 'cancelada' WHERE id = ? AND estado = 'en_curso'").run(id).changes > 0;
}

export const listarPasadas = (db, limite = 30) => db.prepare('SELECT * FROM bateria_pasadas ORDER BY id DESC LIMIT ?').all(limite).map((p) => ({ ...p, borradores: json(p.borradores, null), filtro: json(p.filtro, {}) }));

/** Resultado de una pasada por caso (cuántas repeticiones pasó) y por grupo y tema. */
export function resumenPasada(db, id) {
  const p = db.prepare('SELECT * FROM bateria_pasadas WHERE id = ?').get(id);
  if (!p) return null;
  const casos = Object.fromEntries(listarCasos(db).map((c) => [c.id, c]));
  const porCaso = {};
  for (const r of db.prepare('SELECT * FROM bateria_resultados WHERE pasada_id = ? ORDER BY caso_id, repeticion').all(id)) {
    const c = (porCaso[r.caso_id] ??= { id: r.caso_id, nombre: casos[r.caso_id]?.nombre || r.caso_id, tema: casos[r.caso_id]?.tema || '', grupo: casos[r.caso_id]?.grupo || 'ajuste', tipo: casos[r.caso_id]?.tipo, pasan: 0, total: 0, repeticiones: [] });
    c.total++; c.pasan += r.pasa;
    c.repeticiones.push({ n: r.repeticion, pasa: Boolean(r.pasa), fallos_auto: json(r.fallos_auto, []), criterios: json(r.criterios, []), conversacion: json(r.conversacion, []), estado: json(r.estado, {}), error: r.error });
  }
  const lista = Object.values(porCaso).sort((a, b) => a.pasan / a.total - b.pasan / b.total || a.nombre.localeCompare(b.nombre));
  const agrupar = (k) => Object.values(lista.reduce((o, c) => { const g = (o[c[k]] ??= { nombre: c[k], pasan: 0, total: 0 }); g.pasan += c.pasan; g.total += c.total; return o; }, {})).sort((a, b) => a.nombre.localeCompare(b.nombre));
  return { pasada: { ...p, borradores: json(p.borradores, null), filtro: json(p.filtro, {}) }, casos: lista, porGrupo: agrupar('grupo'), porTema: agrupar('tema') };
}

/** Compara dos pasadas caso a caso: qué mejora y qué empeora (solo casos presentes en las dos). */
export function comparar(db, idA, idB) {
  const a = resumenPasada(db, idA); const b = resumenPasada(db, idB);
  if (!a || !b) return null;
  const mapa = Object.fromEntries(a.casos.map((c) => [c.id, c]));
  const mejoran = []; const empeoran = [];
  for (const c of b.casos) {
    const x = mapa[c.id]; if (!x) continue;
    const d = c.pasan / c.total - x.pasan / x.total;
    if (d > 0) mejoran.push({ id: c.id, nombre: c.nombre, antes: `${x.pasan}/${x.total}`, ahora: `${c.pasan}/${c.total}` });
    if (d < 0) empeoran.push({ id: c.id, nombre: c.nombre, antes: `${x.pasan}/${x.total}`, ahora: `${c.pasan}/${c.total}` });
  }
  const pct = (r) => (r.pasada.hechos ? r.pasada.pasan / r.pasada.hechos : 0);
  return { antes: { id: idA, pct: pct(a), prompt_v: a.pasada.prompt_v }, ahora: { id: idB, pct: pct(b), prompt_v: b.pasada.prompt_v }, mejoran, empeoran };
}

/** Pasadas que quedaron a medias por un reinicio. */
export const recuperarPasadas = (db) => db.prepare("UPDATE bateria_pasadas SET estado = 'error', error = 'interrumpida por un reinicio del servicio', terminado_at = datetime('now') WHERE estado = 'en_curso'").run().changes;
