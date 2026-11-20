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

/**
 * Procesa los seguimientos vencidos. Para cada uno, la IA decide si la condición se cumple
 * (si no, devuelve cero mensajes) y redacta el texto.
 */
export async function procesarSeguimientos(setter) {
  const { repo } = setter;
  const ahora = setter.now();
  const ajustes = leerAjustes(repo);
  for (const s of repo.dueScheduled(ahora.toISOString())) {
    const regla = knowledge.followups.reglas.find((r) => r.id === s.regla_id);
    const conv = repo.getConv(s.conversation_id);
    if (!regla || !conv) { repo.finishScheduled(s.id, 'omitido', 'regla o conversación desconocida'); continue; }
    if (!ajustes.ia_activa || !ajustes.canales[conv.channel]) { repo.finishScheduled(s.id, 'omitido', 'Sofía desactivada desde el panel'); continue; }
    if (!ajustes.seguimientos[regla.id]) { repo.finishScheduled(s.id, 'omitido', 'seguimiento desactivado desde el panel'); continue; }
    if (conv.ai_paused || conv.derivado) { repo.finishScheduled(s.id, 'omitido', 'IA pausada o derivada'); continue; }
    if (conv.alta_estado === 'pendiente') { repo.finishScheduled(s.id, 'omitido', 'alta pendiente'); continue; }
    if (!dentroDeHorario(ahora)) {
      repo.finishScheduled(s.id, 'cancelado', 'fuera de horario: reprogramado');
      repo.schedule(conv.id, regla.id, siguienteApertura(ahora).toISOString());
      continue;
    }

    const fueraVentana = !conv.last_inbound_at || ahora - new Date(conv.last_inbound_at) > VENTANA_MS;
    if (fueraVentana && !(conv.channel === 'whatsapp' && regla.plantillaWhatsapp)) {
      repo.finishScheduled(s.id, 'omitido', 'fuera de la ventana de 24 h y sin plantilla');
      continue;
    }

    const extra = contextoSeguimiento(regla);

    try {
      if (fueraVentana) {
        // Fuera de la ventana de WhatsApp solo vale una plantilla aprobada: la IA redacta la variable.
        const r = await setter.responder(conv.id, { extraContexto: `${extra}\nEl texto irá dentro de una plantilla aprobada: una sola frase.`, motivo: 'followup-plantilla', plantilla: regla.plantillaWhatsapp });
        if (!r?.mensajes?.length) { repo.finishScheduled(s.id, 'omitido', 'la IA decidió no enviar'); continue; }
        repo.finishScheduled(s.id, 'enviado', 'plantilla');
      } else {
        const r = await setter.responder(conv.id, { extraContexto: extra, motivo: 'followup' });
        repo.finishScheduled(s.id, r?.mensajes?.length ? 'enviado' : 'omitido', r?.mensajes?.length ? null : 'la IA decidió no enviar');
      }
    } catch (e) {
      repo.finishScheduled(s.id, 'error', e.message);
    }
  }
}
