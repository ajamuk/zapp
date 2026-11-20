import { config } from './config.js';

const CANAL_A_TIPO = { whatsapp: 'WhatsApp', instagram: 'IG', messenger: 'FB' };

export function canalDesdeTipo(t) {
  const s = String(t ?? '').toLowerCase().trim();
  if (s.includes('whatsapp')) return 'whatsapp';
  if (s === 'ig' || s.includes('instagram')) return 'instagram';
  if (s === 'fb' || s.includes('facebook') || s.includes('messenger')) return 'messenger';
  if (s === 'sms' || s === 'type_sms') return 'sms';
  if (s.includes('email')) return 'email';
  // Los tipos numéricos de GHL o vacíos no se adivinan: el setter pregunta a GHL por la conversación.
  return 'desconocido';
}

/** Etiquetas como lista: GHL las manda como array (eventos de la app) o como texto separado por comas (workflows). */
export function listaEtiquetas(v) {
  if (v == null || v === '') return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return arr.map((t) => String(typeof t === 'object' && t ? t.name ?? '' : t).trim().toLowerCase()).filter(Boolean);
}

const primero = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');

/**
 * Normaliza el webhook de GHL. Admite:
 * - eventos InboundMessage / OutboundMessage de la app de GHL (campos en camelCase en la raíz),
 * - la acción «Webhook» de un workflow (contact_id, full_name, phone, tags en texto, message.body…),
 *   con los campos extra que se añadan en «Custom Data» (llegan en customData o en la raíz).
 */
export function parseWebhook(b = {}) {
  const cd = (b.customData && typeof b.customData === 'object') ? b.customData : {};
  const msg = (b.message && typeof b.message === 'object') ? b.message : {};
  const contact = (b.contact && typeof b.contact === 'object') ? b.contact : {};
  const tipoEvento = String(primero(cd.type, b.type, b.event) || '');
  const direction = String(primero(cd.direction, b.direction, msg.direction) || (tipoEvento.includes('Outbound') ? 'outbound' : 'inbound')).toLowerCase();
  const nombreCompuesto = [b.first_name, b.last_name].filter(Boolean).join(' ') || null;
  const adjuntos = primero(cd.attachments, b.attachments, msg.attachments) || [];
  return {
    evento: direction === 'outbound' ? 'outbound' : 'inbound',
    conversationId: primero(cd.conversationId, cd.conversation_id, b.conversationId, b.conversation_id, msg.conversationId, msg.conversation_id) || null,
    contactId: primero(cd.contactId, cd.contact_id, b.contactId, b.contact_id, msg.contactId, contact.id) || null,
    canal: canalDesdeTipo(primero(cd.messageType, cd.channel, b.messageType, msg.messageType, msg.type, b.channel)),
    texto: String(primero(cd.body, cd.message, b.body, msg.body, typeof b.message === 'string' ? b.message : undefined, b.text) ?? ''),
    messageId: primero(cd.messageId, b.messageId, msg.id, msg.messageId, b.id) || null,
    userId: primero(cd.userId, b.userId, msg.userId) || null, // presente cuando escribe una persona del equipo desde GHL
    source: primero(cd.source, b.source, msg.source) || null,
    adjuntos: Array.isArray(adjuntos) ? adjuntos : [adjuntos],
    nombre: primero(cd.contactName, b.contactName, b.full_name, nombreCompuesto, contact.name) || null,
    telefono: primero(cd.phone, b.phone, contact.phone) || null,
    tags: listaEtiquetas(primero(cd.tags, b.tags, contact.tags)),
    fecha: primero(b.dateAdded, msg.dateAdded) || new Date().toISOString(),
  };
}

export class Ghl {
  constructor({ token = config.ghl.token, baseUrl = config.ghl.baseUrl, locationId = config.ghl.locationId, fetchImpl = fetch } = {}) {
    this.token = token;
    this.locationId = locationId;
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
  }

  async req(method, path, body) {
    const r = await this.fetch(this.baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Version: '2021-07-28',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) throw new Error(`GHL ${method} ${path} → ${r.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    return data;
  }

  sendMessage({ contactId, canal, texto }) {
    const type = CANAL_A_TIPO[canal];
    if (!type) throw new Error(`Canal no soportado: ${canal}`);
    return this.req('POST', '/conversations/messages', { type, contactId, message: texto });
  }

  sendTemplate({ contactId, plantilla, variables = [] }) {
    // Plantilla aprobada de WhatsApp para escribir fuera de la ventana de 24 h.
    return this.req('POST', '/conversations/messages', {
      type: 'WhatsApp', contactId, templateId: plantilla, templateParams: variables,
    });
  }

  /** Conversación de un contacto (para webhooks de workflow que no traen conversationId ni canal). */
  async buscarConversacion(contactId) {
    const q = new URLSearchParams({ locationId: this.locationId, contactId, limit: '5' });
    const r = await this.req('GET', `/conversations/search?${q}`);
    const lista = (r?.conversations || []).filter((c) => !c.contactId || c.contactId === contactId);
    lista.sort((a, b) => Number(b.lastMessageDate || 0) - Number(a.lastMessageDate || 0));
    const c = lista[0];
    return c ? { id: c.id, canal: canalDesdeTipo(c.lastMessageType || c.type) } : null;
  }

  getContact(contactId) { return this.req('GET', `/contacts/${contactId}`); }
  addTags(contactId, tags) { return tags.length ? this.req('POST', `/contacts/${contactId}/tags`, { tags }) : null; }
  removeTags(contactId, tags) { return tags.length ? this.req('DELETE', `/contacts/${contactId}/tags`, { tags }) : null; }
  assign(contactId, userId) { return userId ? this.req('PUT', `/contacts/${contactId}`, { assignedTo: userId }) : null; }
  addNote(contactId, body) { return this.req('POST', `/contacts/${contactId}/notes`, { body }); }
}
