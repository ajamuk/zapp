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
 * `live` (MODE=live): enviar de verdad EXIGE el aislamiento. Sin configurar, en live queda inválido y el servicio no
 * actúa; en modo prueba (shadow) sigue «apagado», como siempre. Los simuladores no pasan por aquí.
 */
export function estadoAislamiento({ numero = config.aislamiento?.numero, locationId = config.aislamiento?.locationId, locationCliente = config.ghl.locationId, live = config.mode === 'live',
  adoptar = config.aislamiento?.adoptar, plantillas = config.aislamiento?.plantillas, instagram = config.aislamiento?.instagram } = {}) {
  const n = String(numero || '').trim(); const loc = String(locationId || '').trim();
  if (!n && !loc) return live ? { modo: 'invalido', motivos: ['MODE=live exige el aislamiento en un número propio (SOFIA_WA_NUMERO y SOFIA_WA_LOCATION_ID); sin él solo se puede usar MODE=shadow'] } : { modo: 'apagado' };
  const motivos = [];
  if (!n) motivos.push('falta SOFIA_WA_NUMERO');
  else if (!E164.test(n)) motivos.push('SOFIA_WA_NUMERO no está en formato internacional (+34…, solo cifras, sin espacios)');
  if (!loc) motivos.push('falta SOFIA_WA_LOCATION_ID');
  else if (loc !== String(locationCliente || '').trim()) motivos.push('SOFIA_WA_LOCATION_ID no coincide con GHL_LOCATION_ID (el token y las consultas irían a otra subcuenta)');
  const ig = String(instagram || '').trim();
  if (ig && !/^\d{5,25}$/.test(ig)) motivos.push('SOFIA_IG_PAGE_ID no es un id de página de Instagram (solo cifras)');
  if (motivos.length) return { modo: 'invalido', motivos };
  // adoptar: los chats que ya había pueden pasar a verificados si GHL confirma que son de esta línea.
  // plantillas: quien configura declara que el workflow de plantilla de esta subcuenta envía desde el número propio.
  // instagram: id de la página de Instagram que también atiende (null = solo WhatsApp)
  return { modo: 'activo', numero: n, digitos: soloDigitos(n), locationId: loc, clave: `${loc}:${soloDigitos(n)}`, adoptar: adoptar === true, plantillas: plantillas === true, instagram: ig || null };
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
  if (String(m.tipo || '') === 'TYPE_INSTAGRAM') return evaluarInstagram(aisl, m, esperado);
  if (String(m.tipo || '') !== 'TYPE_WHATSAPP') return { ok: false, motivo: 'no es WhatsApp' };
  if (esperado.conversationId && m.conversationId && m.conversationId !== esperado.conversationId) return { ok: false, motivo: 'el mensaje es de otra conversación' };
  if (esperado.contactId && m.contactId && m.contactId !== esperado.contactId) return { ok: false, motivo: 'el mensaje es de otro contacto' };
  const para = destinatarios(m.para);
  if (!para.length) return { ok: false, motivo: 'GHL no indica a qué número se envió' };
  // Tiene que coincidir el número entero (con prefijo de país) y ser el único destinatario
  if (para.length !== 1 || para[0] !== aisl.digitos) return { ok: false, motivo: 'dirigido a otro número' };
  return { ok: true };
}

/** Instagram: solo si está configurada la cuenta y GHL confirma que el mensaje entró a esa página. */
function evaluarInstagram(aisl, m, esperado) {
  if (!aisl.instagram) return { ok: false, motivo: 'no es WhatsApp' };
  if (esperado.conversationId && m.conversationId && m.conversationId !== esperado.conversationId) return { ok: false, motivo: 'el mensaje es de otra conversación' };
  if (esperado.contactId && m.contactId && m.contactId !== esperado.contactId) return { ok: false, motivo: 'el mensaje es de otro contacto' };
  if (!m.pagina) return { ok: false, motivo: 'GHL no indica a qué cuenta de Instagram se escribió' };
  if (String(m.pagina) !== aisl.instagram) return { ok: false, motivo: 'dirigido a otra cuenta de Instagram' };
  return { ok: true };
}

/** Cuenta de Instagram por la que fue un mensaje (null si no es Instagram o GHL no lo indica). */
const paginaDe = (m) => (String(m?.tipo || '') === 'TYPE_INSTAGRAM' && m.pagina ? String(m.pagina) : null);

/**
 * Línea de WhatsApp por la que fue un mensaje, en cifras: en un entrante, a qué número se escribió (`to`); en un
 * saliente, desde qué número salió (`from`). null si no es WhatsApp o GHL no lo indica; 'varias' si indica más de una.
 */
export function lineaDe(m) {
  if (String(m?.tipo || '') !== 'TYPE_WHATSAPP') return null;
  const l = destinatarios(String(m.direccion || '').toLowerCase() === 'inbound' ? m.para : m.de);
  return l.length === 1 ? l[0] : l.length ? 'varias' : null;
}

/** ¿Consta que este mensaje fue por una línea de WhatsApp que no es la propia? */
export const esDeOtraLinea = (aisl, m) => {
  if (aisl?.modo !== 'activo') return false;
  const l = lineaDe(m); if (l) return l !== aisl.digitos;
  // Instagram de otra cuenta en la misma conversación (solo cuenta si Sofía atiende Instagram)
  const pg = paginaDe(m); return Boolean(aisl.instagram && pg && pg !== aisl.instagram);
};

/**
 * ¿Demuestra este saliente, tal como lo devuelve GHL, que salió por WhatsApp desde el número propio? Solo esos cuentan
 * como «el equipo ha escrito» o como un envío de Sofía confirmado. Los de otra línea, los de un conector y los que
 * no dicen su emisor no cambian nada.
 */
export function salienteVerificado(aisl, m) {
  return aisl?.modo === 'activo' && Boolean(m?.id) && m.locationId === aisl.locationId
    && String(m.direccion || '').toLowerCase() === 'outbound'
    && (lineaDe(m) === aisl.digitos || Boolean(aisl.instagram && paginaDe(m) === aisl.instagram));
}

/** ¿Está este chat verificado para el número y la subcuenta actuales? (lo marca su primer entrante, que pasó el control) */
/** ¿Se pueden enviar plantillas (por el workflow de GHL)? Sin aislamiento, como siempre; con él, solo si se ha declarado. */
export const plantillasPermitidas = (aisl) => !aisl || aisl.modo === 'apagado' || (aisl.modo === 'activo' && aisl.plantillas === true);

export const chatVerificado = (aisl, conv) => aisl?.modo === 'activo' && Boolean(conv?.aislado_num) && conv.aislado_num === aisl.clave && !conv.aislado_bloqueo;

/** ¿Puede Sofía hacer algo en este chat? Sin aislamiento, siempre; mal configurado, nunca; activo, solo los verificados. */
export function chatPermitido(aisl, conv) {
  if (!aisl || aisl.modo === 'apagado') return true;
  return chatVerificado(aisl, conv);
}

/**
 * Cola heredada de antes del aislamiento (chats del número anterior): se quitan sus respuestas pendientes y se cancelan
 * sus seguimientos. Se puede repetir sin problema; se llama al arrancar. No toca GHL ni borra chats.
 * Con la configuración inválida no se cancela nada (una errata no vacía la cola): basta con que nada puede salir.
 */
export function cuarentena(db, aisl) {
  if (aisl?.modo !== 'activo') return { respuestas: 0, seguimientos: 0 };
  const clave = aisl.clave;
  // Con adopción, la cola de los chats que había se conserva (se comprueba cada uno en GHL antes de escribirle);
  // solo se cancela la de los bloqueados
  const fuera = aisl.adoptar ? "id NOT LIKE 'prueba-%' AND (aislado_bloqueo IS NOT NULL OR ? IS NULL)"
    : "id NOT LIKE 'prueba-%' AND (IFNULL(aislado_num, '') != ? OR aislado_bloqueo IS NOT NULL)";
  const respuestas = db.prepare(`UPDATE conversations SET respond_at = NULL, respondiendo_desde = NULL, reintentos = 0
    WHERE (respond_at IS NOT NULL OR respondiendo_desde IS NOT NULL) AND ${fuera}`).run(clave).changes;
  const seguimientos = db.prepare(`UPDATE scheduled SET estado = 'cancelado', detalle = 'aislamiento: chat no verificado para el número propio'
    WHERE estado IN ('pendiente', 'enviando') AND conversation_id IN (SELECT id FROM conversations WHERE ${fuera})`).run(clave).changes;
  return { respuestas, seguimientos };
}
