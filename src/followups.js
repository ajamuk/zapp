import { knowledge } from './knowledge.js';
import { dentroDeHorario, siguienteApertura } from './horario.js';
import { leerAjustes } from './ajustes.js';

const VENTANA_MS = 24 * 3600 * 1000;

/** Instrucciones para que Sofía decida y redacte un seguimiento. */
export function contextoSeguimiento(regla) {
  return [
    `# Tarea: seguimiento «${regla.nombre}»`,
    'El lead no ha contestado a tu último mensaje. Decide si enviar este seguimiento.',
    `Condición para enviarlo: ${regla.condicion}`,
    'Si la condición NO se cumple, llama a `responder` con `mensajes` vacío.',
    `Si se cumple, escribe un único mensaje. Instrucciones: ${regla.instrucciones}`,
    `Estilo: ${knowledge.followups.estiloComun}`,
  ].join('\n');
}

export const reglaDe = (id) => knowledge.followups.reglas.find((r) => r.id === id);
const json = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };

/** Instrucciones completas para redactar un seguimiento programado (incluye el motivo si es de largo plazo). */
export function contextoTarea(regla, s, { plantilla = false } = {}) {
  const c = json(s?.contexto);
  return [
    contextoSeguimiento(regla),
    regla.tipo === 'largo-plazo' && c ? `Contexto: el lead lo dejó para más adelante (${c.motivo || 'sin motivo concreto'}); se programó para el ${c.fecha}.` : '',
    plantilla ? 'El texto irá dentro de una plantilla aprobada de WhatsApp: una sola frase, sin saltos de línea.' : '',
  ].filter(Boolean).join('\n');
}

/** ¿Saldrá fuera de la ventana de 24 h (solo plantilla)? Se mira en el momento del envío previsto. */
export function fueraDeVentana(conv, cuando) {
  return !conv.last_inbound_at || new Date(cuando) - new Date(conv.last_inbound_at) > VENTANA_MS;
}

/**
 * Prepara (o reutiliza) el texto de un seguimiento programado. Si el chat no ha cambiado desde que se preparó,
 * devuelve el mismo texto: así lo que se ve en el panel es exactamente lo que se envía.
 */
export async function textoPrevisto(setter, s, { forzar = false } = {}) {
  const { repo } = setter;
  const regla = reglaDe(s.regla_id);
  const conv = repo.getConv(s.conversation_id);
  if (!regla || !conv) return { texto: '', vigente: false, error: 'regla o conversación desconocida' };
  const ultimo = repo.ultimoMensajeId(conv.id);
  if (!forzar && s.texto_previsto != null && s.previsto_msg === ultimo) return { texto: s.texto_previsto, vigente: true, plantilla: fueraDeVentana(conv, s.due_at) };
  const plantilla = fueraDeVentana(conv, s.due_at);
  let texto = await setter.redactar(conv.id, contextoTarea(regla, s, { plantilla }));
  if (plantilla) texto = texto.split('\n')[0] || ''; // la plantilla lleva una sola frase
  if (s.id) repo.guardarPrevisto(s.id, texto, ultimo);
  return { texto, vigente: true, plantilla };
}

/**
 * Procesa los seguimientos vencidos. Para cada uno, la IA decide si la condición se cumple
 * (si no, no hay texto y no se envía) y redacta el texto, o usa el que ya tenía preparado.
 * En modo prueba el envío queda como borrador (nota en GHL).
 */
export async function procesarSeguimientos(setter) {
  const { repo } = setter;
  const ahora = setter.now();
  const ajustes = leerAjustes(repo);
  for (const s of repo.dueScheduled(ahora.toISOString())) {
    const regla = reglaDe(s.regla_id);
    const conv = repo.getConv(s.conversation_id);
    if (!regla || !conv) { repo.finishScheduled(s.id, 'omitido', 'regla o conversación desconocida'); continue; }
    if (!ajustes.ia_activa || !ajustes.canales[conv.channel]) { repo.finishScheduled(s.id, 'omitido', 'Sofía desactivada desde el panel'); continue; }
    if (!ajustes.seguimientos[regla.id]) { repo.finishScheduled(s.id, 'omitido', 'seguimiento desactivado desde el panel'); continue; }
    if (conv.ai_paused || conv.derivado) { repo.finishScheduled(s.id, 'omitido', 'IA pausada o derivada'); continue; }
    if (conv.alta_estado === 'pendiente') { repo.finishScheduled(s.id, 'omitido', 'alta pendiente'); continue; }
    if (!dentroDeHorario(ahora)) {
      repo.finishScheduled(s.id, 'cancelado', 'fuera de horario: reprogramado');
      const r = repo.schedule(conv.id, regla.id, siguienteApertura(ahora).toISOString(), json(s.contexto));
      if (s.texto_previsto != null) repo.guardarPrevisto(r.lastInsertRowid, s.texto_previsto, s.previsto_msg);
      continue;
    }

    const plantilla = fueraDeVentana(conv, ahora);
    if (plantilla && !(conv.channel === 'whatsapp' && regla.plantillaWhatsapp)) {
      repo.finishScheduled(s.id, 'omitido', conv.channel === 'instagram' ? 'Instagram no deja escribir fuera de plazo' : 'fuera de la ventana de 24 h y sin plantilla');
      continue;
    }

    try {
      // El texto preparado solo vale si era para el mismo tipo de envío (normal o plantilla)
      const previsto = s.texto_previsto != null && fueraDeVentana(conv, s.due_at) === plantilla ? s : { ...s, texto_previsto: null };
      const { texto } = await textoPrevisto(setter, previsto);
      if (!texto) { repo.finishScheduled(s.id, 'omitido', 'la IA decidió no enviar'); continue; }
      const burbujas = texto.split('\n').map((x) => x.trim()).filter(Boolean);
      await setter.enviar(conv, plantilla ? burbujas.slice(0, 1) : burbujas, plantilla ? regla.plantillaWhatsapp : null);
      repo.finishScheduled(s.id, 'enviado', [plantilla ? 'plantilla' : null, setter.live ? null : 'borrador (modo prueba)'].filter(Boolean).join(' · ') || null);
    } catch (e) {
      repo.finishScheduled(s.id, 'error', e.message);
    }
  }
}
