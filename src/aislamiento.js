// Aislamiento de Sofía en un número de WhatsApp propio (ver docs/aislamiento-whatsapp.md).
//
// Con SOFIA_WA_NUMERO y SOFIA_WA_LOCATION_ID puestos, Sofía solo atiende los WhatsApp que entran a ESE número de ESA
// subcuenta de GoHighLevel, y todo lo que envía sale con ese número como emisor. Lo que no se pueda demostrar con
// datos leídos de la API de GHL (no con lo que diga el webhook) se descarta sin tocar nada del contacto.
// Sin esas variables, este módulo no cambia nada: el servicio se comporta como antes.
import { config } from './config.js';

const soloDigitos = (v) => String(v ?? '').replace(/\D/g, '');
/** Número en formato internacional: «+» y de 8 a 15 cifras (E.164). No se aceptan espacios ni prefijos «00». */
const E164 = /^\+[1-9]\d{7,14}$/;

/** Para los registros y el panel: solo las cuatro últimas cifras. */
export const enmascarar = (numero) => { const d = soloDigitos(numero); return d ? `…${d.slice(-4)}` : '(vacío)'; };

/**
 * Estado del aislamiento según la configuración:
 *  - { modo: 'apagado' }: no se ha configurado nada; comportamiento de siempre.
 *  - { modo: 'activo', numero, digitos, locationId, clave }: se aplica.
 *  - { modo: 'invalido', motivos }: está a medias o es incoherente. Se bloquea todo (entrada y salida) hasta arreglarlo:
 *    una errata en el número no puede dejar a Sofía atendiendo el número de otro.
 */
export function estadoAislamiento({ numero = config.aislamiento?.numero, locationId = config.aislamiento?.locationId, locationCliente = config.ghl.locationId } = {}) {
  const n = String(numero || '').trim(); const loc = String(locationId || '').trim();
  if (!n && !loc) return { modo: 'apagado' };
  const motivos = [];
  if (!n) motivos.push('falta SOFIA_WA_NUMERO');
  else if (!E164.test(n)) motivos.push('SOFIA_WA_NUMERO no está en formato internacional (+34…, solo cifras, sin espacios)');
  if (!loc) motivos.push('falta SOFIA_WA_LOCATION_ID');
  else if (loc !== String(locationCliente || '').trim()) motivos.push('SOFIA_WA_LOCATION_ID no coincide con GHL_LOCATION_ID (el token y las consultas irían a otra subcuenta)');
  if (motivos.length) return { modo: 'invalido', motivos };
  return { modo: 'activo', numero: n, digitos: soloDigitos(n), locationId: loc, clave: `${loc}:${soloDigitos(n)}` };
}

export const APAGADO = Object.freeze({ modo: 'apagado' });

/** Destinatarios que declara GHL en un mensaje (`to` puede venir como texto o como lista). Nunca el teléfono del contacto. */
function destinatarios(para) {
  const lista = Array.isArray(para) ? para : para == null || para === '' ? [] : [para];
  return lista.map(soloDigitos).filter(Boolean);
}

/**
 * ¿Demuestra este mensaje, tal como lo devuelve la API de GHL, que es un WhatsApp entrante al número propio?
 * `m`: { id, locationId, direccion, tipo (messageType), para (to), conversationId?, contactId? }.
 * `esperado`: { conversationId, contactId } del aviso, para que no se pueda emparejar un id de mensaje bueno con otro chat.
 * Devuelve { ok: true } o { ok: false, motivo } (el motivo no lleva teléfonos ni textos).
 */
export function evaluarEntrante(aisl, m, esperado = {}) {
  if (aisl?.modo !== 'activo') return { ok: false, motivo: 'aislamiento mal configurado' };
  if (!m || !m.id) return { ok: false, motivo: 'sin el mensaje leído de GHL' };
  if (!m.locationId) return { ok: false, motivo: 'GHL no indica la subcuenta del mensaje' };
  if (m.locationId !== aisl.locationId) return { ok: false, motivo: 'mensaje de otra subcuenta' };
  if (String(m.direccion || '').toLowerCase() !== 'inbound') return { ok: false, motivo: 'no es un mensaje entrante' };
  if (String(m.tipo || '') !== 'TYPE_WHATSAPP') return { ok: false, motivo: 'no es WhatsApp' };
  if (esperado.conversationId && m.conversationId && m.conversationId !== esperado.conversationId) return { ok: false, motivo: 'el mensaje es de otra conversación' };
  if (esperado.contactId && m.contactId && m.contactId !== esperado.contactId) return { ok: false, motivo: 'el mensaje es de otro contacto' };
  const para = destinatarios(m.para);
  if (!para.length) return { ok: false, motivo: 'GHL no indica a qué número se envió' };
  // Tiene que coincidir el número entero (con prefijo de país) y ser el único destinatario
  if (para.length !== 1 || para[0] !== aisl.digitos) return { ok: false, motivo: 'dirigido a otro número' };
  return { ok: true };
}

/** ¿Está este chat verificado para el número y la subcuenta actuales? (lo marca el último entrante que pasó el control) */
export const chatVerificado = (aisl, conv) => aisl?.modo === 'activo' && Boolean(conv?.aislado_num) && conv.aislado_num === aisl.clave;

/** ¿Puede Sofía hacer algo en este chat? Sin aislamiento, siempre; mal configurado, nunca; activo, solo los verificados. */
export function chatPermitido(aisl, conv) {
  if (!aisl || aisl.modo === 'apagado') return true;
  if (String(conv?.id || '').startsWith('prueba-')) return true; // chats del simulador del panel: no salen a GHL
  return chatVerificado(aisl, conv);
}

/**
 * Cola heredada de antes del aislamiento (chats del número anterior): se quitan sus respuestas pendientes y se cancelan
 * sus seguimientos. Se puede repetir sin problema; se llama al arrancar. No toca GHL ni borra chats.
 */
export function cuarentena(db, aisl) {
  if (!aisl || aisl.modo === 'apagado') return { respuestas: 0, seguimientos: 0 };
  // Mal configurado: ningún chat cuenta como verificado
  const clave = aisl.modo === 'activo' ? aisl.clave : '\u0000';
  const fuera = "id NOT LIKE 'prueba-%' AND IFNULL(aislado_num, '') != ?";
  const respuestas = db.prepare(`UPDATE conversations SET respond_at = NULL, respondiendo_desde = NULL, reintentos = 0
    WHERE (respond_at IS NOT NULL OR respondiendo_desde IS NOT NULL) AND ${fuera}`).run(clave).changes;
  const seguimientos = db.prepare(`UPDATE scheduled SET estado = 'cancelado', detalle = 'aislamiento: chat no verificado para el número propio'
    WHERE estado IN ('pendiente', 'enviando') AND conversation_id IN (SELECT id FROM conversations WHERE ${fuera})`).run(clave).changes;
  return { respuestas, seguimientos };
}
