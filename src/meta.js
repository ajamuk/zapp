// Eventos de conversión a Meta (API de Conversiones), como el «Avisa a Meta» de las etiquetas de Zapp: cuando se
// pone una etiqueta con esa acción, se manda el evento (Lead, Schedule, Purchase…) con el teléfono cifrado, para
// que los anuncios aprendan qué leads acaban reservando o dándose de alta. Configuración: META_PIXEL_ID y
// META_CAPI_TOKEN (y META_TEST_EVENT_CODE para probar en el Administrador de eventos). En modo prueba no se envía.
import crypto from 'node:crypto';
import { config } from './config.js';

export const EVENTOS = [['Lead', 'Lead (interesado)'], ['Contact', 'Contacto'], ['Schedule', 'Reserva (clase de prueba)'], ['SubmitApplication', 'Solicitud enviada'], ['CompleteRegistration', 'Registro completado'], ['Purchase', 'Compra (alta)']];
const sha = (t) => crypto.createHash('sha256').update(String(t).trim().toLowerCase()).digest('hex');

/** Teléfono en formato E.164 sin «+» (España por defecto si vienen 9 cifras). */
export function telefonoMeta(t) {
  const d = String(t || '').replace(/\D/g, '').replace(/^00/, '');
  if (!d) return null;
  return d.length === 9 ? `34${d}` : d;
}

export const configurado = () => Boolean(config.meta.pixelId && config.meta.token);

/** Valida la acción «avisar a Meta» de una etiqueta. */
export function validarAccion(m) {
  if (!m || !m.evento) return null;
  const evento = String(m.evento).trim().slice(0, 40);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(evento)) throw new Error('El nombre del evento de Meta solo puede llevar letras, números y _.');
  const valor = m.valor === '' || m.valor == null ? null : Number(m.valor);
  if (valor != null && !(valor >= 0 && valor < 100000)) throw new Error('El valor del evento debe ser un número.');
  if (evento === 'Purchase' && valor == null && !m.valorAlta) throw new Error('Una compra necesita un valor (o «usar el primer recibo del alta»).');
  return { evento, valor, valorAlta: Boolean(m.valorAlta), moneda: 'EUR' };
}

/**
 * Envía (o registra) un evento. Se manda una sola vez por chat y evento. Devuelve la fila guardada.
 * `live`: en modo prueba no se envía nada (queda «simulado»).
 */
export async function enviarEvento(db, conv, accion, { live = config.mode === 'live', fetchImpl = fetch, ahora = new Date() } = {}) {
  const eventId = `${conv.id}:${accion.evento}`;
  const ya = db.prepare("SELECT * FROM meta_eventos WHERE event_id = ? AND estado IN ('enviado', 'simulado')").get(eventId);
  if (ya) return ya;
  let valor = accion.valor;
  if (accion.valorAlta) {
    const alta = db.prepare("SELECT datos FROM altas WHERE conversation_id = ? ORDER BY id DESC LIMIT 1").get(conv.id);
    try { valor = Number(JSON.parse(alta?.datos || '{}').primer_recibo) || valor; } catch { /* sin alta */ }
  }
  const guardar = (estado, respuesta) => {
    const r = db.prepare('INSERT INTO meta_eventos (conversation_id, event_id, evento, valor, moneda, estado, respuesta) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(conv.id, eventId, accion.evento, valor ?? null, accion.moneda || 'EUR', estado, String(respuesta || '').slice(0, 500));
    return db.prepare('SELECT * FROM meta_eventos WHERE id = ?').get(r.lastInsertRowid);
  };
  if (String(conv.id).startsWith('prueba-')) return guardar('simulado', 'chat de pruebas');
  if (!live) return guardar('simulado', 'modo prueba: no se envía a Meta');
  if (!configurado()) return guardar('sin_configurar', 'Falta META_PIXEL_ID o META_CAPI_TOKEN');
  const tel = telefonoMeta(conv.telefono);
  const body = {
    data: [{
      event_name: accion.evento, event_time: Math.floor(ahora.getTime() / 1000), event_id: eventId, action_source: 'chat',
      user_data: { ...(tel ? { ph: [sha(tel)] } : {}), external_id: [sha(conv.contact_id || conv.id)] },
      ...(valor != null ? { custom_data: { value: valor, currency: accion.moneda || 'EUR' } } : {}),
    }],
    ...(config.meta.testCode ? { test_event_code: config.meta.testCode } : {}),
  };
  try {
    const r = await fetchImpl(`https://graph.facebook.com/${config.meta.version}/${config.meta.pixelId}/events?access_token=${encodeURIComponent(config.meta.token)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    const t = await r.text();
    return guardar(r.ok ? 'enviado' : 'error', t);
  } catch (e) { return guardar('error', e.message); }
}

export const recientes = (db, limite = 50) => db.prepare(`SELECT m.*, c.nombre FROM meta_eventos m LEFT JOIN conversations c ON c.id = m.conversation_id
  WHERE m.conversation_id NOT LIKE 'prueba-%' ORDER BY m.id DESC LIMIT ?`).all(limite);
