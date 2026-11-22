import { config } from './config.js';

const CANAL_A_TIPO = { whatsapp: 'WhatsApp', instagram: 'IG', messenger: 'FB' };

export function canalDesdeTipo(t) {
  const s = String(t || '').toLowerCase();
  if (s.includes('whatsapp') || s === 'type_whatsapp') return 'whatsapp';
  if (s === 'ig' || s.includes('instagram') || s === 'type_instagram') return 'instagram';
  if (s === 'fb' || s.includes('facebook') || s.includes('messenger')) return 'messenger';
  // El workflow de GHL manda el tipo como número ({{message.type}}): no se adivina, se pregunta a GHL (buscarConversacion)
  if (!s || /^\d+$/.test(s)) return 'desconocido';
  return s;
}

/**
 * Normaliza el webhook de GHL (eventos InboundMessage / OutboundMessage de la app de GHL,
 * o el "Custom Webhook" de un workflow con los mismos campos).
 */
/** GHL puede mandar listas como texto («a, b») cuando vienen de un campo de workflow. */
const aLista = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : v == null ? null : []);

/**
 * La acción «Webhook» de un workflow de GHL manda su propio formato: contact_id, full_name, phone, tags como texto,
 * message: { type, body } y lo que se añada en «Custom Data» dentro de `customData`. No trae el id de la conversación
 * ni el canal por nombre: los completa `Setter.handleWebhook` preguntando a GHL.
 */
function aplanar(raw) {
  const extra = raw.customData || raw.custom_data || {};
  const b = { ...raw };
  // Un campo de «Custom Data» vacío o con la variable sin sustituir ({{...}}) no pisa lo que ya venga
  for (const [k, v] of Object.entries(extra)) if (v !== '' && v != null && !/^\{\{.*\}\}$/.test(String(v))) b[k] = v;
  return b;
}

export function parseWebhook(raw = {}) {
  const b = aplanar(raw || {});
  const tipoEvento = b.type || b.event || '';
  const direction = String(b.direction || (tipoEvento.includes('Outbound') ? 'outbound' : 'inbound')).toLowerCase();
  const msg = b.message || {};
  const esTags = /ContactTag|TagUpdate|ContactUpdate/i.test(tipoEvento);
  return {
    evento: esTags ? 'tags' : direction === 'outbound' ? 'outbound' : 'inbound',
    conversationId: b.conversationId || b.conversation_id || msg.conversationId,
    contactId: b.contactId || b.contact_id || msg.contactId || b.contact?.id || (esTags ? b.id : undefined),
    canal: canalDesdeTipo(b.messageType || msg.type || b.channel),
    texto: b.body ?? msg.body ?? b.text ?? '',
    messageId: b.messageId || b.id || msg.id || null,
    userId: b.userId || msg.userId || null, // presente cuando escribe una persona del equipo desde GHL
    source: b.source || msg.source || null,
    adjuntos: aLista(b.attachments ?? msg.attachments) || [],
    nombre: b.contactName || b.full_name || [b.first_name, b.last_name].filter(Boolean).join(' ') || b.contact?.name || null,
    telefono: b.phone || b.contact?.phone || null,
    tags: aLista(b.tags ?? b.contact?.tags),
    fecha: b.dateAdded || new Date().toISOString(),
  };
}

export class Ghl {
  constructor({ token = config.ghl.token, baseUrl = config.ghl.baseUrl, fetchImpl = fetch } = {}) {
    this.token = token;
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
  }

  /**
   * Petición a GHL con tiempo límite (20 s) para que nunca se quede colgada. Se reintenta (2 veces, con espera)
   * solo lo que es seguro repetir: lecturas, y cualquier petición si GHL contesta 429 (no la ha procesado).
   * Los envíos de mensajes NO se reintentan ante un corte o un 5xx: podría salir duplicado.
   */
  async req(method, path, body, { intentos = 3, esperaMs = 800 } = {}) {
    let r; let ultimo;
    for (let i = 1; i <= intentos; i++) {
      try {
        r = await this.fetch(this.baseUrl + path, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Version: '2021-07-28',
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(20000),
        });
      } catch (e) {
        ultimo = new Error(`GHL ${method} ${path} → ${e.name === 'TimeoutError' ? 'sin respuesta en 20 s' : e.message}`);
        if (method !== 'GET' || i === intentos) throw ultimo;
        await new Promise((ok) => setTimeout(ok, esperaMs * i));
        continue;
      }
      const repetible = r.status === 429 || (method === 'GET' && r.status >= 500);
      if (!repetible || i === intentos) break;
      await r.text().catch(() => null);
      const pedido = Number(r.headers?.get?.('retry-after')) * 1000;
      await new Promise((ok) => setTimeout(ok, Math.min(10000, pedido || esperaMs * i)));
    }
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

  /** Archivo (imagen, vídeo, PDF…) por WhatsApp o Instagram. `url` debe ser pública (GHL la descarga). */
  enviarAdjunto({ contactId, canal, url, texto = '' }) {
    const type = CANAL_A_TIPO[canal];
    if (!type) throw new Error(`Canal no soportado: ${canal}`);
    return this.req('POST', '/conversations/messages', { type, contactId, attachments: [url], ...(texto ? { message: texto } : {}) });
  }

  /**
   * Plantilla de WhatsApp (fuera de la ventana de 24 h). La API de GHL no admite variables de plantilla, así que
   * se hace con un workflow de GHL: se guarda el texto en el campo «Sofía · Texto de seguimiento» del contacto y
   * se pone la etiqueta `sofia-enviar-plantilla`; el workflow envía la plantilla con ese campo como variable.
   * Ver docs/seguimientos.md.
   */
  async enviarPorPlantilla({ contactId, texto }) {
    const campo = await this.campoPlantilla();
    await this.req('PUT', `/contacts/${contactId}`, { customFields: [{ id: campo, field_value: texto }] });
    const tag = config.ghl.tagPlantilla;
    await this.removeTags(contactId, [tag]).catch(() => null); // quitar y poner, para que el workflow salte otra vez
    await this.addTags(contactId, [tag]);
    return { messageId: null, via: 'workflow' };
  }

  // Compatibilidad: el nombre antiguo
  sendTemplate({ contactId, variables = [] }) { return this.enviarPorPlantilla({ contactId, texto: variables[0] || '' }); }

  /** Id del campo de contacto donde va el texto de la plantilla (se crea la primera vez). */
  async campoPlantilla() {
    if (this._campo) return this._campo;
    const nombre = config.ghl.campoPlantilla;
    const r = await this.req('GET', `/locations/${config.ghl.locationId}/customFields?model=contact`);
    let f = (r?.customFields || []).find((x) => x.name === nombre);
    if (!f) f = (await this.req('POST', `/locations/${config.ghl.locationId}/customFields`, { name: nombre, dataType: 'LARGE_TEXT', model: 'contact' }))?.customField;
    if (!f?.id) throw new Error('No se ha podido preparar el campo de la plantilla en GHL');
    this._campo = f.id;
    return f.id;
  }

  /**
   * Conversación de un contacto (en GHL hay una por contacto y location) y el canal de su último mensaje.
   * Para los webhooks de workflow, que no traen el id de la conversación ni el canal por nombre.
   */
  async buscarConversacion(contactId) {
    const q = new URLSearchParams({ locationId: config.ghl.locationId, contactId, limit: '5' });
    const r = await this.req('GET', `/conversations/search?${q}`);
    const c = (r?.conversations || [])[0];
    return c ? { id: c.id, canal: canalDesdeTipo(c.lastMessageType || c.type) } : null;
  }

  getContact(contactId) { return this.req('GET', `/contacts/${contactId}`); }
  addTags(contactId, tags) { return tags.length ? this.req('POST', `/contacts/${contactId}/tags`, { tags }) : null; }
  removeTags(contactId, tags) { return tags.length ? this.req('DELETE', `/contacts/${contactId}/tags`, { tags }) : null; }
  assign(contactId, userId) { return userId ? this.req('PUT', `/contacts/${contactId}`, { assignedTo: userId }) : null; }
  addNote(contactId, body) { return this.req('POST', `/contacts/${contactId}/notes`, { body }); }
  updateNote(contactId, noteId, body) { return this.req('PUT', `/contacts/${contactId}/notes/${noteId}`, { body }); }
  // Etiquetas del location (el catálogo de tags de GHL)
  listarTags() { return this.req('GET', `/locations/${config.ghl.locationId}/tags`).then((r) => r?.tags || []); }
  crearTag(name) { return this.req('POST', `/locations/${config.ghl.locationId}/tags`, { name }).then((r) => r?.tag || r); }
  renombrarTag(tagId, name) { return this.req('PUT', `/locations/${config.ghl.locationId}/tags/${tagId}`, { name }); }
}
