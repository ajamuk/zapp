import { config } from './config.js';
import { estadoAislamiento, plantillasPermitidas } from './aislamiento.js';

const CANAL_A_TIPO = { whatsapp: 'WhatsApp', instagram: 'IG', messenger: 'FB' };
// Tope de páginas por lectura de mensajes o conversaciones (cada página, `limit` elementos): nunca un bucle sin fin
export const MAX_PAGINAS = 10;

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
  const tipoEvento = String(b.type || b.event || '');
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

/**
 * Mensaje de GHL ya normalizado. `locationId`, `para` (`to`: a qué número se envió) y `de` (`from`: desde cuál salió)
 * solo se usan para el aislamiento. `to` y `from` no están en la documentación pública de GHL para WhatsApp, pero la
 * API los devuelve con el número de la empresa en formato «+34 910 00 00 01» (comprobado en entrantes y salientes).
 */
const normalizarMensaje = (m) => ({
  id: m.id, direccion: String(m.direction || '').toLowerCase(), tipo: String(m.messageType || ''), canal: canalDesdeTipo(m.messageType),
  texto: m.body || '', adjuntos: Array.isArray(m.attachments) ? m.attachments : [], userId: m.userId || null, source: m.source || null, fecha: m.dateAdded,
  locationId: m.locationId || null, conversationId: m.conversationId || null, contactId: m.contactId || null, para: m.to ?? null, de: m.from ?? null,
  pagina: m.meta?.ig?.pageId ?? null, // Instagram: cuenta (página) a la que se escribió o desde la que salió
});

export class Ghl {
  constructor({ token = config.ghl.token, baseUrl = config.ghl.baseUrl, fetchImpl = fetch, aislamiento = estadoAislamiento() } = {}) {
    this.token = token;
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
    // Por defecto, el de la configuración: el cliente real nunca envía fuera del número propio aunque quien lo use se olvide
    this.aislamiento = aislamiento;
  }

  /**
   * Cuerpo de un envío. Con aislamiento: solo WhatsApp y siempre con el número propio como emisor (`fromNumber`);
   * si la configuración está a medias, no sale nada.
   */
  cuerpoEnvio(canal, resto) {
    const type = CANAL_A_TIPO[canal];
    if (!type) throw new Error(`Canal no soportado: ${canal}`);
    const a = this.aislamiento;
    if (!a || a.modo === 'apagado') return { type, ...resto };
    if (a.modo !== 'activo') throw new Error('Aislamiento mal configurado: no se envía nada');
    // Instagram solo si Sofía atiende esa cuenta: GHL responde por la página de la conversación
    if (canal === 'instagram' && a.instagram) return { type, ...resto };
    if (canal !== 'whatsapp') throw new Error(`Aislamiento: solo se envía por WhatsApp (no por ${canal})`);
    return { type, ...resto, fromNumber: a.numero };
  }

  /**
   * Petición a GHL con tiempo límite (20 s) para que nunca se quede colgada. Se reintenta (2 veces, con espera)
   * solo lo que es seguro repetir: lecturas, y cualquier petición si GHL contesta 429 (no la ha procesado).
   * Los envíos de mensajes NO se reintentan ante un corte o un 5xx: podría salir duplicado.
   */
  async req(method, path, body, { intentos = 3, esperaMs = 800, version = '2021-07-28' } = {}) {
    let r; let ultimo;
    for (let i = 1; i <= intentos; i++) {
      try {
        r = await this.fetch(this.baseUrl + path, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Version: version,
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
    // El cuerpo va recortado: una página de error en HTML acabaría entera en los detalles de la base
    if (!r.ok) throw new Error(`GHL ${method} ${path} → ${r.status}: ${String(typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 300)}`);
    return data;
  }

  sendMessage({ contactId, canal, texto }) {
    return this.req('POST', '/conversations/messages', this.cuerpoEnvio(canal, { contactId, message: texto }));
  }

  /**
   * Archivo (imagen, vídeo, PDF…) por WhatsApp o Instagram. `url` debe ser pública.
   * Por WhatsApp el archivo va en `whatsapp.media` (el formato de la bandeja de GHL): Meta descarga la URL y lo
   * entrega con `texto` como pie. Con `attachments` a secas GHL acepta el envío, pero al lead solo le llega el texto.
   */
  enviarAdjunto({ contactId, canal, url, texto = '', mime = '', nombre = '' }) {
    const resto = { contactId, ...(texto ? { message: texto } : {}) };
    if (canal === 'whatsapp' && mime) {
      const tipo = { image: 'image', video: 'video', audio: 'audio' }[String(mime).split('/')[0]] || 'document';
      const archivo = nombre || decodeURIComponent(String(url).split('/').pop().split('?')[0]);
      resto.whatsapp = { type: 'media', media: { url, type: tipo, name: archivo, mimeType: mime, ...(texto ? { caption: texto } : {}) } };
    } else resto.attachments = [url];
    return this.req('POST', '/conversations/messages', this.cuerpoEnvio(canal, resto));
  }

  /**
   * Plantilla de WhatsApp (fuera de la ventana de 24 h). La API de GHL no admite variables de plantilla, así que
   * se hace con un workflow de GHL: se guarda el texto en el campo «Sofía · Texto de seguimiento» del contacto y
   * se pone la etiqueta `sofia-enviar-plantilla`; el workflow envía la plantilla con ese campo como variable.
   * Ver docs/seguimientos.md.
   */
  async enviarPorPlantilla({ contactId, texto }) {
    // La plantilla la envía un workflow de GHL: desde aquí no se puede fijar con qué número sale. Con aislamiento solo
    // se usa si se ha declarado (SOFIA_WA_PLANTILLAS=true) que ese workflow envía desde el número propio.
    if (!plantillasPermitidas(this.aislamiento)) throw new Error('Aislamiento: la plantilla la envía un workflow de GHL y no se puede fijar el número emisor');
    const campo = await this.campoPlantilla();
    await this.req('PUT', `/contacts/${contactId}`, { customFields: [{ id: campo, field_value: texto }] });
    const tag = config.ghl.tagPlantilla;
    await this.removeTags(contactId, [tag]).catch(() => null); // quitar y poner, para que el workflow salte otra vez
    await this.addTags(contactId, [tag]);
    return { messageId: null, via: 'workflow' };
  }

  /**
   * Plantilla aprobada de WhatsApp enviada directamente (sin workflow), con el formato de la bandeja de GHL:
   * `whatsapp.type = 'template'` y las variables del cuerpo por orden en `placeholders.body`. `texto` es la plantilla
   * ya rellenada: es lo que GHL guarda y enseña en el chat. Con aislamiento sale del número propio (`fromNumber`).
   */
  enviarPlantillaWa({ contactId, nombre, idioma, categoria, variables = [], texto }) {
    return this.req('POST', '/conversations/messages', this.cuerpoEnvio('whatsapp', {
      contactId, message: texto,
      whatsapp: { type: 'template', template: { name: nombre, lang: idioma, ...(categoria ? { category: categoria } : {}) }, placeholders: { header: [], body: variables, buttons: [] } },
    }));
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

  /**
   * Conversaciones de la subcuenta con el último mensaje más reciente primero (para el barrido de chats nuevos).
   * GHL las da de `limit` en `limit` (GET /conversations/search). La página siguiente se pide con `startAfterDate`,
   * que según la documentación de GHL lleva «el valor de orden del último documento»: con sortBy=last_message_date,
   * su `lastMessageDate` en milisegundos. Se siguen pidiendo páginas mientras la última conversación sea de después de
   * `desdeMs`, como mucho `maxPaginas`. Sin `desdeMs`, una sola página. Un número como argumento es el `limit`.
   */
  async conversacionesRecientes(opciones = {}) {
    const { limit = 30, desdeMs = null, maxPaginas = MAX_PAGINAS } = typeof opciones === 'number' ? { limit: opciones } : opciones;
    const enMs = (v) => Number(v) || Date.parse(v) || null;
    const vistas = new Map(); let despues = null;
    for (let pagina = 1; pagina <= maxPaginas; pagina++) {
      const q = new URLSearchParams({ locationId: config.ghl.locationId, sortBy: 'last_message_date', sort: 'desc', limit: String(limit), ...(despues ? { startAfterDate: String(despues) } : {}) });
      let r;
      try { r = await this.req('GET', `/conversations/search?${q}`); } catch (e) {
        if (pagina === 1) throw e;
        console.warn(`[ghl] conversaciones recientes: falla la página ${pagina}; se usan las ${vistas.size} ya leídas (${e.message})`);
        break;
      }
      const lista = r?.conversations || [];
      for (const c of lista) if (c.id && !vistas.has(c.id)) vistas.set(c.id, c);
      const ultima = enMs(lista.at(-1)?.lastMessageDate);
      // Página corta, ya por debajo de la ventana o sin avanzar (misma fecha que la anterior): no hay más que pedir
      if (lista.length < limit || desdeMs == null || !ultima || ultima < desdeMs || (despues && ultima >= despues)) break;
      despues = ultima;
    }
    return [...vistas.values()].map((c) => ({ id: c.id, contactId: c.contactId, ultimo: enMs(c.lastMessageDate) ? new Date(enMs(c.lastMessageDate)).toISOString() : null }))
      .filter((c) => c.id && c.contactId && c.ultimo);
  }

  /**
   * Mensajes de una conversación, del más antiguo al más nuevo, ya normalizados. Es la fuente fiable de lo que ha
   * entrado y salido: el webhook de workflow no trae el id del mensaje, ni el canal, ni los adjuntos.
   *
   * GHL los da del más nuevo al más antiguo, de `limit` en `limit` (GET /conversations/:id/messages). Cada respuesta
   * trae `nextPage` (quedan más) y `lastMessageId` (el último de la página), que se pasa como `lastMessageId` para
   * pedir la siguiente. Opciones:
   *  - `desde` (ISO): se piden páginas hasta tener un mensaje anterior a esa fecha. `null`: todo el historial.
   *    Sin `desde`, una sola página (como antes).
   *  - `maxPaginas`: tope de peticiones. Si se llega al tope sin cubrir lo pedido, la lista lleva `incompleta = 'tope'`;
   *    si falla una página que no es la primera, `incompleta = 'error'` (con lo ya leído).
   *  - `parar(pagina)`: si devuelve true para una página (ya normalizada), no se piden más (ya se sabe lo que se buscaba).
   * Un número como segundo argumento es el tamaño de la página (una sola).
   */
  async mensajes(conversationId, opciones = {}) {
    const { limit = 30, desde, maxPaginas = MAX_PAGINAS, parar = null } = typeof opciones === 'number' ? { limit: opciones } : opciones;
    const hasta = desde === undefined ? undefined : desde === null ? null : Date.parse(desde);
    const vistos = new Map(); let despues = null; let incompleta = null;
    for (let pagina = 1; ; pagina++) {
      const q = new URLSearchParams({ limit: String(limit), ...(despues ? { lastMessageId: despues } : {}) });
      let r;
      try { r = await this.req('GET', `/conversations/${conversationId}/messages?${q}`); } catch (e) {
        if (pagina === 1) throw e;
        console.warn(`[ghl] ${conversationId}: falla la página ${pagina} de mensajes; se usan los ${vistos.size} ya leídos (${e.message})`);
        incompleta = 'error'; break;
      }
      // GHL envuelve la página en `messages` ({ messages: { lastMessageId, nextPage, messages: [...] } })
      const pag = Array.isArray(r?.messages) ? r : (r?.messages || {});
      const crudos = Array.isArray(pag.messages) ? pag.messages : [];
      const nuevos = crudos.filter((m) => m?.id && m.dateAdded && !vistos.has(m.id)).map(normalizarMensaje);
      for (const m of nuevos) vistos.set(m.id, m);
      if (parar?.(nuevos)) break;
      const masAntiguo = Math.min(...crudos.map((m) => Date.parse(m?.dateAdded)).filter(Number.isFinite));
      const quedan = pag.nextPage === true && pag.lastMessageId && pag.lastMessageId !== despues && crudos.length > 0;
      if (!quedan || hasta === undefined || (hasta !== null && masAntiguo < hasta)) break;
      if (pagina >= maxPaginas) { incompleta = 'tope'; break; }
      despues = pag.lastMessageId;
    }
    const lista = [...vistos.values()].sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
    if (incompleta) lista.incompleta = incompleta;
    return lista;
  }

  /** Un mensaje por su id (GET /conversations/messages/{id}), normalizado; null si GHL no devuelve ese mismo mensaje. */
  async mensaje(id) {
    const r = await this.req('GET', `/conversations/messages/${encodeURIComponent(id)}`);
    const m = r?.message || r;
    return m && m.id === id ? normalizarMensaje(m) : null;
  }

  getContact(contactId) { return this.req('GET', `/contacts/${contactId}`); }
  formularios({ startAt, endAt, page }) {
    const q = new URLSearchParams({ locationId: config.ghl.locationId, startAt, endAt, page: String(page), limit: '100' });
    return this.req('GET', `/forms/submissions?${q}`, undefined, { version: 'v3' });
  }

  /**
   * Crea el contacto (o devuelve el que ya hay con ese teléfono: GHL deduplica por teléfono) para escribirle por
   * primera vez. Devuelve { id, nuevo }.
   */
  async upsertContacto({ telefono, nombre, fuente = 'Sofía · primer contacto' }) {
    const r = await this.req('POST', '/contacts/upsert', { locationId: config.ghl.locationId, phone: telefono, firstName: nombre, source: fuente });
    const id = r?.contact?.id;
    if (!id) throw new Error('GHL no ha devuelto el contacto');
    return { id, nuevo: Boolean(r?.new) };
  }
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
