import { config } from './config.js';

const CANAL_A_TIPO = { whatsapp: 'WhatsApp', instagram: 'IG', messenger: 'FB' };

export function canalDesdeTipo(t) {
  const s = String(t || '').toLowerCase();
  if (s.includes('whatsapp') || s === 'type_whatsapp') return 'whatsapp';
  if (s === 'ig' || s.includes('instagram') || s === 'type_instagram') return 'instagram';
  if (s === 'fb' || s.includes('facebook') || s.includes('messenger')) return 'messenger';
  return s || 'desconocido';
}

/**
 * Normaliza el webhook de GHL (eventos InboundMessage / OutboundMessage de la app de GHL,
 * o el "Custom Webhook" de un workflow con los mismos campos).
 */
export function parseWebhook(b = {}) {
  const tipoEvento = b.type || b.event || '';
  const direction = String(b.direction || (tipoEvento.includes('Outbound') ? 'outbound' : 'inbound')).toLowerCase();
  const msg = b.message || {};
  const esTags = /ContactTag|TagUpdate|ContactUpdate/i.test(tipoEvento);
  return {
    evento: esTags ? 'tags' : direction === 'outbound' ? 'outbound' : 'inbound',
    conversationId: b.conversationId || b.conversation_id || msg.conversationId,
    contactId: b.contactId || b.contact_id || msg.contactId || (esTags ? b.id : undefined),
    canal: canalDesdeTipo(b.messageType || msg.type || b.channel),
    texto: b.body ?? msg.body ?? b.text ?? '',
    messageId: b.messageId || b.id || msg.id || null,
    userId: b.userId || msg.userId || null, // presente cuando escribe una persona del equipo desde GHL
    source: b.source || msg.source || null,
    adjuntos: b.attachments || msg.attachments || [],
    nombre: b.contactName || b.full_name || b.contact?.name || null,
    telefono: b.phone || b.contact?.phone || null,
    tags: b.tags || b.contact?.tags || null,
    fecha: b.dateAdded || new Date().toISOString(),
  };
}

export class Ghl {
  constructor({ token = config.ghl.token, baseUrl = config.ghl.baseUrl, fetchImpl = fetch } = {}) {
    this.token = token;
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

  getContact(contactId) { return this.req('GET', `/contacts/${contactId}`); }
  addTags(contactId, tags) { return tags.length ? this.req('POST', `/contacts/${contactId}/tags`, { tags }) : null; }
  removeTags(contactId, tags) { return tags.length ? this.req('DELETE', `/contacts/${contactId}/tags`, { tags }) : null; }
  assign(contactId, userId) { return userId ? this.req('PUT', `/contacts/${contactId}`, { assignedTo: userId }) : null; }
  addNote(contactId, body) { return this.req('POST', `/contacts/${contactId}/notes`, { body }); }
  // Etiquetas del location (el catálogo de tags de GHL)
  listarTags() { return this.req('GET', `/locations/${config.ghl.locationId}/tags`).then((r) => r?.tags || []); }
  crearTag(name) { return this.req('POST', `/locations/${config.ghl.locationId}/tags`, { name }).then((r) => r?.tag || r); }
  renombrarTag(tagId, name) { return this.req('PUT', `/locations/${config.ghl.locationId}/tags/${tagId}`, { name }); }
}
