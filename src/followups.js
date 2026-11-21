// Seguimientos: los programa el sistema (reglas de reglas.js), el equipo a mano o un lanzamiento, y aquí se
// preparan y se envían. Cada pendiente guarda el texto previsto: si el chat no cambia, sale exactamente ese.
import { knowledge } from './knowledge.js';
import { dentroDeHorario, siguienteApertura } from './horario.js';
import { leerAjustes } from './ajustes.js';
import * as reglas from './reglas.js';
import * as recursosMod from './recursos.js';

export const VENTANA_MS = 24 * 3600 * 1000;
const json = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
const QUIEN_DEPENDE_DE_SOFIA = ['silencio', 'largo-plazo'];

/** Instrucciones para que Sofía decida y redacte un seguimiento. */
export function contextoSeguimiento(regla) {
  const fijo = regla.modo === 'fijo';
  const huecos = fijo && /\[[^\]]+\]/.test(regla.textoFijo);
  return [
    `# Tarea: seguimiento «${regla.nombre}»`,
    {
      silencio: 'El lead no ha contestado a tu último mensaje. Decide si enviar este seguimiento.',
      etiqueta: 'Este seguimiento se programó al ponerse una etiqueta en el chat. Decide si enviarlo.',
      cita: 'El lead tiene una clase de prueba próximamente. Decide si enviar este recordatorio.',
      'largo-plazo': 'El lead dijo que lo dejaba para más adelante. Decide si enviar este seguimiento.',
    }[regla.tipo] || 'Decide si enviar este seguimiento.',
    regla.condicion ? `Condición para enviarlo: ${regla.condicion}` : 'Envíalo salvo que no tenga ningún sentido con la conversación delante (por ejemplo, ya se apuntó o pidió no recibir mensajes).',
    'Si NO debe enviarse, llama a `responder` con `mensajes` vacío.',
    fijo && huecos ? `Si se envía, el mensaje es EXACTAMENTE este texto, cambiando solo lo que va entre corchetes por lo que corresponda según la conversación (sin los corchetes): «${regla.textoFijo}». Si la conversación no te da lo que piden los corchetes, no lo envíes (mensajes vacío): mejor eso que inventar.` : '',
    fijo && !huecos ? `Si se envía, el mensaje es EXACTAMENTE este texto, sin cambiar nada: «${regla.textoFijo}».` : '',
    !fijo ? `Si se envía, escribe un único mensaje. Instrucciones: ${regla.instrucciones}` : '',
    !fijo ? `Estilo: ${knowledge.followups.estiloComun}` : '',
  ].filter(Boolean).join('\n');
}

export const reglaDe = (db, id) => reglas.obtener(db, id);

/** Regla de un pendiente: la de la tabla, o la «virtual» de los manuales y lanzamientos. */
function reglaDelPendiente(db, s) {
  if (s.tipo === 'manual') return reglas.reglaFija('manual', 'Mensaje programado');
  if (s.tipo === 'lanzamiento') return reglas.reglaFija('lanzamiento', 'Lanzamiento');
  return reglas.obtener(db, s.regla_id);
}

/** Instrucciones completas para redactar un seguimiento programado (incluye el motivo si es de largo plazo). */
export function contextoTarea(regla, s, { plantilla = false, ahora = new Date() } = {}) {
  const c = json(s?.contexto);
  const futuro = s?.due_at && new Date(s.due_at) - ahora > 60000;
  const cuando = futuro ? new Date(s.due_at).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  return [
    futuro ? `IMPORTANTE: este mensaje se enviará el ${cuando} (hora de Madrid). Redáctalo como si ya fuera ese momento y el lead no hubiera vuelto a escribir desde su último mensaje; decide si se cumple la condición pensando en ese momento, no en hoy.` : '',
    contextoSeguimiento(regla),
    regla.tipo === 'largo-plazo' && c ? `Contexto: el lead lo dejó para más adelante (${c.motivo || 'sin motivo concreto'}); se programó para el ${c.fecha}.` : '',
    regla.tipo === 'cita' && c?.prueba ? `Su clase de prueba: ${c.prueba}.` : '',
    plantilla ? 'El texto irá dentro de una plantilla aprobada de WhatsApp: una sola frase, sin saltos de línea.' : '',
  ].filter(Boolean).join('\n');
}

/** ¿Saldrá fuera de la ventana de 24 h (solo plantilla)? Se mira en el momento del envío previsto. */
export function fueraDeVentana(conv, cuando) {
  return !conv.last_inbound_at || new Date(cuando) - new Date(conv.last_inbound_at) > VENTANA_MS;
}

/** El texto fijo con huecos debe conservar todo lo que no va entre corchetes. */
export function respetaPlantillaFija(textoFijo, resultado) {
  const trozos = textoFijo.split(/\[[^\]]+\]/).map((t) => t.trim()).filter(Boolean);
  let desde = 0;
  for (const t of trozos) {
    const i = resultado.indexOf(t, desde);
    if (i < 0) return false;
    desde = i + t.length;
  }
  return !/\[[^\]]+\]/.test(resultado);
}

/**
 * Prepara (o reutiliza) el texto de un seguimiento programado. Si el chat no ha cambiado desde que se preparó,
 * devuelve el mismo texto: así lo que se ve en el panel es exactamente lo que se envía.
 */
export async function textoPrevisto(setter, s, { forzar = false } = {}) {
  const { repo } = setter;
  const regla = reglaDelPendiente(setter.catalogo, s);
  const conv = repo.getConv(s.conversation_id);
  if (!regla || !conv) return { texto: '', vigente: false, error: 'regla o conversación desconocida' };
  const plantilla = fueraDeVentana(conv, s.due_at);
  // Manuales y lanzamientos: el texto lo escribió el equipo, no se toca
  if (s.tipo === 'manual' || s.tipo === 'lanzamiento') return { texto: s.texto_previsto || '', vigente: true, plantilla };
  const ultimo = repo.ultimoMensajeId(conv.id);
  if (!forzar && s.texto_previsto != null && s.previsto_msg === ultimo) return { texto: s.texto_previsto, vigente: true, plantilla };
  let texto;
  if (regla.modo === 'fijo' && !regla.condicion && !/\[[^\]]+\]/.test(regla.textoFijo)) texto = regla.textoFijo; // sin huecos ni condición: no hace falta la IA
  else {
    texto = await setter.redactar(conv.id, contextoTarea(regla, s, { plantilla, ahora: setter.now() }));
    if (regla.modo === 'fijo') texto = texto.replace(/\s*\n+\s*/g, ' ').trim();
    if (regla.modo === 'fijo' && texto && !respetaPlantillaFija(regla.textoFijo, texto)) texto = ''; // ha cambiado el texto fijo: no sale
  }
  if (plantilla) texto = texto.split('\n')[0] || ''; // la plantilla lleva una sola frase
  if (s.id) repo.guardarPrevisto(s.id, texto, ultimo);
  return { texto, vigente: true, plantilla };
}

/** ¿Por qué no debe salir ahora? (null = puede salir) */
function motivoParaNoEnviar(s, regla, conv, ajustes, ahora) {
  const deSofia = QUIEN_DEPENDE_DE_SOFIA.includes(s.tipo);
  const delEquipo = s.tipo === 'manual' || s.tipo === 'lanzamiento';
  if (s.tipo === 'manual') return null; // lo ha escrito una persona para este chat: sale siempre
  // Lanzamientos: nunca a socios, a quien ya tiene el alta, a chats derivados ni a quien pidió no recibir mensajes
  if (s.tipo === 'lanzamiento') {
    if (conv.tipo === 'socio' || conv.alta_estado === 'preparada') return 'ya es cliente';
    if (conv.derivado) return 'chat derivado al equipo';
    if (/^el lead escribió/.test(conv.pause_reason || '')) return 'pidió no recibir mensajes';
    return null;
  }
  if (!ajustes.ia_activa || !ajustes.canales[conv.channel]) return 'Sofía desactivada desde el panel';
  if (!regla.activo) return 'seguimiento desactivado desde el panel';
  if ((deSofia || regla.excluir.pausada) && (conv.ai_paused || conv.derivado)) return 'IA pausada o derivada';
  if (deSofia && conv.alta_estado === 'pendiente') return 'alta pendiente';
  if (regla.excluir.clientes && (conv.tipo === 'socio' || conv.alta_estado === 'preparada')) return 'ya es cliente';
  if (regla.excluir.calladasHoras && conv.last_inbound_at && ahora - new Date(conv.last_inbound_at) < regla.excluir.calladasHoras * 3600e3) return `escribió hace menos de ${regla.excluir.calladasHoras} h`;
  return null;
}

/**
 * Procesa los seguimientos vencidos (de cualquier tipo). La IA decide si se cumple la condición y redacta el
 * texto, o usa el que ya tenía preparado. En modo prueba el envío queda como borrador (nota en GHL).
 */
export async function procesarSeguimientos(setter) {
  const { repo } = setter;
  const ahora = setter.now();
  const ajustes = leerAjustes(repo);
  await procesarLanzamientos(setter);
  let aplazados = 0;
  const tomar = repo.db.prepare("UPDATE scheduled SET estado = 'enviando' WHERE id = ? AND estado = 'pendiente'");
  const sigueEnMarcha = repo.db.prepare("SELECT 1 FROM scheduled WHERE id = ? AND estado = 'enviando'");
  for (const s of repo.dueScheduled(ahora.toISOString())) {
   try { // un fallo en un envío nunca corta los demás
    if (setter.enCurso?.has(s.conversation_id)) continue; // Sofía está contestando en ese chat: al siguiente minuto
    // Se «toma» el envío: si otro proceso o una vuelta anterior ya lo tiene, o se canceló, se salta (nunca sale dos veces)
    if (!tomar.run(s.id).changes) continue;
    const regla = reglaDelPendiente(setter.catalogo, s);
    const conv = repo.getConv(s.conversation_id);
    if (!regla || !conv) { repo.finishScheduled(s.id, 'omitido', 'regla o conversación desconocida'); continue; }
    // ¿Se ha hecho socio desde que empezó el chat (alta en recepción)? Se mira el índice de AimHarder antes de escribirle
    if (s.tipo !== 'manual' && conv.tipo !== 'socio' && conv.telefono && setter.aimharder?.buscarSocioPorTelefono) {
      const socio = await setter.safe(() => setter.aimharder.buscarSocioPorTelefono(conv.telefono));
      if (socio?.esSocio) {
        repo.updateConv(conv.id, { tipo: 'socio', ai_paused: 1, pause_reason: 'socio' });
        repo.cancelScheduled(conv.id, 'ya es socio', { tipos: ['silencio', 'largo-plazo', 'etiqueta'] });
        repo.finishScheduled(s.id, 'omitido', 'ya es socio');
        continue;
      }
    }
    const no = motivoParaNoEnviar(s, regla, conv, ajustes, ahora);
    if (no) { repo.finishScheduled(s.id, 'omitido', no); continue; }
    // Los mensajes a mano salen a su hora exacta; el resto, dentro del horario de Sofía
    if (s.tipo !== 'manual' && !dentroDeHorario(ahora)) {
      repo.finishScheduled(s.id, 'cancelado', 'fuera de horario: reprogramado');
      // Los envíos de un lanzamiento conservan su reparto (uno cada 20 s) al pasar a la siguiente apertura
      const apertura = new Date(siguienteApertura(ahora).getTime() + (s.tipo === 'lanzamiento' ? (aplazados++) * ESPACIADO_MS : 0));
      const r = repo.schedule(conv.id, s.regla_id, apertura.toISOString(), json(s.contexto), s.tipo, s.texto_previsto);
      if (s.previsto_msg != null) repo.guardarPrevisto(r.lastInsertRowid, s.texto_previsto, s.previsto_msg);
      continue;
    }

    const plantilla = fueraDeVentana(conv, ahora);
    if (plantilla && !(conv.channel === 'whatsapp' && regla.plantilla)) {
      repo.finishScheduled(s.id, 'omitido', conv.channel === 'instagram' ? 'Instagram no deja escribir fuera de plazo' : 'fuera de la ventana de 24 h y sin plantilla');
      continue;
    }

    try {
      // El texto preparado solo vale si era para el mismo tipo de envío (normal o plantilla)
      const previsto = s.texto_previsto != null && (s.tipo === 'manual' || s.tipo === 'lanzamiento' || fueraDeVentana(conv, s.due_at) === plantilla) ? s : { ...s, texto_previsto: null };
      const { texto } = await textoPrevisto(setter, previsto);
      if (!texto) { repo.finishScheduled(s.id, 'omitido', 'la IA decidió no enviar'); continue; }
      // Mientras Sofía redactaba, el lead ha escrito o lo han cancelado o pausado: no sale
      if (!sigueEnMarcha.get(s.id)) continue;
      const fresco = repo.getConv(conv.id);
      const no2 = fresco ? motivoParaNoEnviar(s, regla, fresco, ajustes, setter.now()) : 'el chat ya no existe';
      if (no2) { repo.finishScheduled(s.id, 'omitido', no2); continue; }
      const burbujas = texto.split('\n').map((x) => x.trim()).filter(Boolean);
      await setter.enviar(conv, plantilla ? [burbujas.join(' ')] : burbujas, plantilla ? regla.plantillaWhatsapp || {} : null);
      repo.finishScheduled(s.id, 'enviado', [plantilla ? 'plantilla' : null, setter.live ? null : 'borrador (modo prueba)'].filter(Boolean).join(' · ') || null);
      if (regla.recursoId && !plantilla) { const rec = recursosMod.obtener(setter.catalogo, regla.recursoId); if (rec?.activo) await setter.enviarRecursos(conv, [rec]); }
      if (regla.ponerEtiqueta) await setter.safe(() => setter.etiquetas?.poner(conv.id, regla.ponerEtiqueta, 'regla'));
    } catch (e) {
      repo.finishScheduled(s.id, 'error', e.message);
    }
   } catch (e) {
    console.error(`Seguimiento ${s.id}:`, e.message);
    try { repo.finishScheduled(s.id, 'error', e.message); } catch { /* la base no responde: se verá en las alertas */ }
   }
  }
  marcarLanzamientosTerminados(repo.db);
}

// ---------- Programar ----------

/** Al ponerse una etiqueta: programa sus seguimientos (una vez por chat y etiqueta). */
export function programarPorEtiqueta(repo, catalogo, convId, etiquetaId, ahora = new Date()) {
  const conv = repo.getConv(convId);
  if (!conv || String(convId).startsWith('prueba-')) return 0;
  let n = 0;
  for (const r of reglas.listar(catalogo).filter((x) => x.tipo === 'etiqueta' && x.etiquetaId === etiquetaId && x.activo && x.canales.includes(conv.channel))) {
    const ya = repo.db.prepare("SELECT 1 FROM scheduled WHERE conversation_id = ? AND regla_id = ? AND estado IN ('pendiente', 'enviado')").get(convId, r.id);
    if (ya) continue;
    repo.schedule(convId, r.id, new Date(ahora.getTime() + r.minutos * 60000).toISOString(), { etiqueta: etiquetaId }, 'etiqueta');
    n++;
  }
  return n;
}

/** Al quitarse una etiqueta: se cancelan sus seguimientos pendientes. */
export function cancelarPorEtiqueta(repo, catalogo, convId, etiquetaId) {
  const ids = reglas.listar(catalogo).filter((x) => x.tipo === 'etiqueta' && x.etiquetaId === etiquetaId).map((x) => x.id);
  if (ids.length) repo.cancelScheduled(convId, 'se quitó la etiqueta', { tipos: ['etiqueta'], reglaIds: ids });
}

/** Instante UTC de «AAAA-MM-DD HH:MM» en hora de Madrid, o null. */
export function horaMadrid(texto) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(texto || ''));
  if (!m) return null;
  const [a, mes, d, h, mi] = m.slice(1).map(Number);
  const aprox = Date.UTC(a, mes - 1, d, h, mi);
  const enMadrid = Number(new Date(aprox).toLocaleString('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hourCycle: 'h23' }));
  let dif = enMadrid - h; if (dif > 12) dif -= 24; if (dif < -12) dif += 24;
  const f = new Date(aprox - dif * 3600e3);
  return Number.isNaN(f.getTime()) ? null : f;
}

/**
 * Clase de prueba pedida (fecha «AAAA-MM-DD HH:MM», hora de Madrid): programa los recordatorios «cita».
 * Si ya había una, se cancelan los anteriores. Devuelve el instante de la clase o null si la fecha no vale.
 */
export function programarCita(repo, catalogo, convId, fechaHora, ahora = new Date()) {
  const clase = horaMadrid(fechaHora);
  if (!clase) return null;
  const conv = repo.getConv(convId);
  repo.cancelScheduled(convId, 'clase de prueba cambiada', { tipos: ['cita'] });
  repo.updateConv(convId, { prueba_fecha: clase.toISOString() });
  if (!conv || String(convId).startsWith('prueba-')) return clase;
  const etiqueta = clase.toLocaleString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  for (const r of reglas.listar(catalogo).filter((x) => x.tipo === 'cita' && x.activo && x.canales.includes(conv.channel))) {
    const due = new Date(clase.getTime() - r.minutos * 60000);
    if (due > ahora) repo.schedule(convId, r.id, due.toISOString(), { prueba: etiqueta }, 'cita');
  }
  return clase;
}

export function cancelarCita(repo, convId) {
  repo.cancelScheduled(convId, 'clase de prueba anulada', { tipos: ['cita'] });
  repo.updateConv(convId, { prueba_fecha: null, prueba_reservada: 0 });
}

/** Mensaje programado a mano desde el panel (texto tal cual; por plantilla si ya no hay ventana). */
export function programarManual(repo, convId, texto, cuando, ahora = new Date()) {
  const t = String(texto || '').trim();
  if (!t) throw new Error('Escribe el mensaje.');
  if (t.length > 1000) throw new Error('El mensaje puede tener como mucho 1000 caracteres.');
  const f = new Date(cuando);
  if (Number.isNaN(f.getTime())) throw new Error('Fecha y hora no válidas.');
  if (f < ahora - 60000) throw new Error('Esa fecha ya ha pasado.');
  if (f - ahora > 2 * 365 * 864e5) throw new Error('Como mucho, dentro de 2 años.');
  if (!repo.getConv(convId)) throw new Error('El chat no existe.');
  return Number(repo.schedule(convId, 'manual', f.toISOString(), null, 'manual', t).lastInsertRowid);
}

// ---------- Lanzamientos ----------

const lista = (x) => (typeof x === 'string' ? JSON.parse(x) : x) || [];

/** Chats que recibirían un lanzamiento (activos en los últimos N días, sin las etiquetas excluidas, sin socios). */
export function destinatarios(db, { dias_actividad = 30, canales = ['whatsapp'], excluir_etiquetas = [], solo_etiquetas = [] }) {
  const can = lista(canales); const exc = lista(excluir_etiquetas).map(Number); const solo = lista(solo_etiquetas).map(Number);
  if (!can.length) return [];
  return db.prepare(`SELECT c.id, c.channel, c.nombre, c.last_inbound_at FROM conversations c
    WHERE c.id NOT LIKE 'prueba-%' AND IFNULL(c.tipo, '') != 'socio' AND c.derivado = 0
      AND IFNULL(c.alta_estado, '') != 'preparada' AND IFNULL(c.pause_reason, '') NOT LIKE 'el lead escribió%'
      AND c.channel IN (${can.map(() => '?').join(',')})
      AND datetime(c.last_inbound_at) >= datetime('now', ?)
      ${exc.length ? `AND NOT EXISTS (SELECT 1 FROM conv_etiquetas ce WHERE ce.conversation_id = c.id AND ce.etiqueta_id IN (${exc.map(() => '?').join(',')}))` : ''}
      ${solo.length ? `AND EXISTS (SELECT 1 FROM conv_etiquetas ce WHERE ce.conversation_id = c.id AND ce.etiqueta_id IN (${solo.map(() => '?').join(',')}))` : ''}
    ORDER BY c.last_inbound_at DESC`).all(...can, `-${Math.max(1, Math.min(365, Number(dias_actividad) || 30))} days`, ...exc, ...solo);
}

export function validarLanzamiento(d = {}, ahora = new Date()) {
  const nombre = String(d.nombre || '').trim().slice(0, 60);
  const texto = String(d.texto || '').trim();
  if (!nombre) throw new Error('Ponle un nombre al lanzamiento.');
  if (!texto) throw new Error('Escribe el mensaje.');
  if (texto.length > 1000) throw new Error('El mensaje puede tener como mucho 1000 caracteres.');
  const f = new Date(d.programado_at);
  if (Number.isNaN(f.getTime())) throw new Error('Fecha y hora no válidas.');
  if (f < ahora - 60000) throw new Error('La fecha ya pasó.');
  const canales = (d.canales || []).filter((c) => ['whatsapp', 'instagram'].includes(c));
  if (!canales.length) throw new Error('Elige al menos un canal.');
  const dias = Math.round(Number(d.dias_actividad));
  if (!(dias >= 1 && dias <= 365)) throw new Error('Los días de actividad van de 1 a 365.');
  const ids = (l) => [...new Set((l || []).map(Number).filter(Number.isInteger))];
  return { nombre, texto, programado_at: f.toISOString(), dias_actividad: dias, canales: JSON.stringify(canales), excluir_etiquetas: JSON.stringify(ids(d.excluir_etiquetas)), solo_etiquetas: JSON.stringify(ids(d.solo_etiquetas)) };
}

const ESPACIADO_MS = 20 * 1000; // uno cada 20 s, para no saturar a GHL ni parecer spam

/** Cuando llega la hora de un lanzamiento, se prepara un envío por destinatario, repartidos en el tiempo. */
export async function procesarLanzamientos(setter) {
  const { repo } = setter;
  const db = repo.db;
  const ahora = setter.now();
  for (const l of db.prepare("SELECT * FROM lanzamientos WHERE estado = 'programado' AND programado_at <= ?").all(ahora.toISOString())) {
    const dest = destinatarios(db, l);
    db.transaction(() => {
      dest.forEach((c, i) => repo.schedule(c.id, `lanzamiento-${l.id}`, new Date(ahora.getTime() + i * ESPACIADO_MS).toISOString(), { lanzamiento: l.id }, 'lanzamiento', l.texto));
      db.prepare("UPDATE lanzamientos SET estado = 'enviando', total = ? WHERE id = ?").run(dest.length, l.id);
    })();
  }
}

/** Lanzamientos terminados: ya no les queda ningún envío pendiente. */
function marcarLanzamientosTerminados(db) {
  db.prepare(`UPDATE lanzamientos SET estado = 'enviado' WHERE estado = 'enviando'
    AND NOT EXISTS (SELECT 1 FROM scheduled s WHERE s.regla_id = 'lanzamiento-' || lanzamientos.id AND s.estado = 'pendiente')`).run();
}

export function cancelarLanzamiento(db, id) {
  db.prepare("UPDATE scheduled SET estado = 'cancelado', detalle = 'lanzamiento cancelado' WHERE regla_id = ? AND estado = 'pendiente'").run(`lanzamiento-${id}`);
  return db.prepare("UPDATE lanzamientos SET estado = 'cancelado' WHERE id = ? AND estado IN ('programado', 'enviando')").run(id).changes > 0;
}
