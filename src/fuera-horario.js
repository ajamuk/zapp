// Aviso automático fuera de horario: cuando un lead escribe y Sofía no está en su franja, le llega al momento un
// mensaje fijo («ahora mismo no estamos atendiendo…»). Sofía le contesta de verdad en la siguiente apertura.
// Se configura en Ajustes del panel: activarlo, el texto y en qué canales sale.
import { config } from './config.js';
import { siguienteApertura, diaLocal, hoyLocal } from './horario.js';

export const MENSAJE_FUERA_HORARIO = '¡Hola! Ahora mismo no estamos atendiendo el WhatsApp. En cuanto lo leamos te contestamos y te ayudamos con todo lo que necesites 😊';
export const TIPO_AVISO = 'fuera_horario';

const DIA_TXT = { lunes: 'el lunes', martes: 'el martes', miercoles: 'el miércoles', jueves: 'el jueves', viernes: 'el viernes', sabado: 'el sábado', domingo: 'el domingo' };

/** «hoy a las 8:00», «mañana a las 9:00», «el lunes a las 8:00»: cuándo vuelve Sofía, para `{apertura}`. */
export function textoApertura(ahora = new Date(), apertura = siguienteApertura(ahora), tz = config.tz) {
  const hora = new Intl.DateTimeFormat('es-ES', { hour: 'numeric', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(apertura);
  const hoy = hoyLocal(ahora, tz).iso;
  const dia = hoyLocal(apertura, tz).iso;
  const manana = hoyLocal(new Date(ahora.getTime() + 24 * 3600e3), tz).iso;
  const cuando = dia === hoy ? 'hoy' : dia === manana ? 'mañana' : DIA_TXT[diaLocal(apertura, tz)];
  return `${cuando} a las ${hora}`;
}

/** Texto final del aviso: sustituye `{apertura}` y `{nombre}` (el nombre de pila del perfil, si lo hay). */
export function textoAviso(plantilla, { ahora = new Date(), nombre = null } = {}) {
  const pila = String(nombre || '').trim().split(/\s+/)[0] || '';
  return String(plantilla || MENSAJE_FUERA_HORARIO)
    .replace(/\{apertura\}/g, () => textoApertura(ahora))
    .replace(/\{nombre\}/g, pila)
    // Sin nombre: «¡Hola {nombre}!» queda «¡Hola!», sin el hueco
    .replace(/[ \t]+([,.!?])/g, '$1').replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * ¿Ya se le mandó el aviso en este mismo cierre? Un aviso por cada vez que Sofía está fuera de horario: si escribe
 * tres mensajes por la noche, solo recibe uno; si vuelve a escribir la noche siguiente, recibe otro.
 */
export function avisadoEnEsteCierre(avisoAt, ahora = new Date()) {
  if (!avisoAt) return false;
  return siguienteApertura(new Date(avisoAt)).getTime() === siguienteApertura(ahora).getTime();
}

/** Ajustes con sus valores por defecto (activo en WhatsApp, apagado en Instagram). */
export function ajustesFueraHorario(g = {}) {
  return {
    activo: g.activo ?? true,
    mensaje: typeof g.mensaje === 'string' && g.mensaje.trim() ? g.mensaje : MENSAJE_FUERA_HORARIO,
    canales: { whatsapp: g.canales?.whatsapp ?? true, instagram: g.canales?.instagram ?? false },
  };
}

/** Valida el cambio que llega del panel. Lanza un error legible. */
export function validarFueraHorario(actual, cambio = {}) {
  const n = { ...actual, ...cambio, canales: { ...actual.canales, ...(cambio.canales || {}) } };
  if (typeof n.activo !== 'boolean') throw new Error('Aviso fuera de horario: activo debe ser sí o no');
  n.mensaje = String(n.mensaje ?? '').trim();
  if (!n.mensaje) throw new Error('Aviso fuera de horario: escribe el mensaje');
  if (n.mensaje.length > 1000) throw new Error('Aviso fuera de horario: el mensaje no puede pasar de 1000 letras');
  n.canales = { whatsapp: Boolean(n.canales.whatsapp), instagram: Boolean(n.canales.instagram) };
  return n;
}
