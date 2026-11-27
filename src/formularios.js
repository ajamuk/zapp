import { createHash } from 'node:crypto';
import { normalizarTelefono } from './primer-contacto.js';
import { prepararEnvio } from './plantillas.js';
import { SEDE_NOMBRE } from './knowledge.js';

const HORAS_24 = 24 * 3600_000;
const FORMULARIOS = {
  dLmjqTQhXGKeURKqtZJh: { sede: 'getafe' },
  PL7nPBgjoiyOOsPTPXQp: { sede: 'parla' },
  fHEhwttrRKTKvVmgfcoh: { sede: 'las_rosas' },
  TAQsBdExmLa6e0eqdpzH: { sede: 'el_canaveral', apertura: true },
  xJcaf7HDOzmVFR8qBOqA: { sede: 'getafe' },
  Rhd8bB6VAlOrZmldEmDR: { sede: 'parla' },
  gMmEDPBKc912y6RWsJm1: { sede: 'las_rosas' },
};
const SERVICIOS = new Set(['CrossFit Academy', 'CrossFit']);
const WHATSAPP_APERTURA = 'Sí, podéis responder a mi solicitud por WhatsApp o teléfono y avisarme por ese canal cuando se abra la oferta de apertura de El Cañaveral.';
const TAGS_BLOQUEO = new Set(['parar ia', 'ai off', 'baja de mensajes', 'cb:opt-out', 'ia-necesita-humano', 'humano']);
const lista = (dato) => Array.isArray(dato) ? dato : [dato];

export function prepararSolicitud(fila, { ids, campoServicio, locationId, desde, ahora }) {
  const datos = fila.others || {};
  const ruta = Object.hasOwn(FORMULARIOS, fila.formId) && FORMULARIOS[fila.formId];
  if (!ruta || !ids.has(fila.formId) || datos.location_id !== locationId || !fila.id || !fila.contactId) return null;
  const fecha = Date.parse(fila.createdAt);
  if (!Number.isFinite(fecha) || fecha < desde || fecha > ahora || fecha < ahora - 2 * HORAS_24) return null;
  const telefono = normalizarTelefono(datos.phone);
  if (!telefono) return null;
  const servicio = lista(datos[campoServicio]).find((opcion) => SERVICIOS.has(opcion)) || null;
  const sede = SEDE_NOMBRE[ruta.sede];
  const asunto = ruta.apertura ? 'el aviso de apertura de El Cañaveral' : `${servicio || 'entrenar'} en ${sede}`;
  const consiente = ruta.apertura ? lista(datos.AQSO7RVJ9ucjR1MAWmOs).includes(WHATSAPP_APERTURA)
    : lista(datos.terms_and_conditions).some((valor) => valor === true || valor === 'Acepto las políticas de privacidad');
  return {
    id: fila.id, contacto: fila.contactId, formulario: fila.formId, fecha, telefono, sede: ruta.sede,
    servicio, asunto, consiente, claveTelefono: createHash('sha256').update(telefono).digest('hex'),
  };
}

export function contextoSolicitud(db, conv, ahora) {
  if (conv.channel !== 'whatsapp' || !conv.contact_id) return '';
  const solicitud = db.prepare(`SELECT sede, servicio, asunto, estado FROM solicitudes_web
    WHERE contacto = ? AND fecha >= ? AND estado IN ('enviando', 'aceptada', 'incierta', 'chat_abierto')
    ORDER BY fecha DESC LIMIT 1`).get(conv.contact_id, ahora.getTime() - 7 * HORAS_24);
  if (!solicitud) return '';
  const servicio = solicitud.servicio
    ? `Eligió ${solicitud.servicio}.`
    : 'Dejó el servicio sin determinar o pidió solo un aviso de apertura.';
  const enviado = solicitud.estado === 'aceptada' ? 'El primer WhatsApp se escribió sobre esa solicitud.' : '';
  return `- Solicitud reciente del formulario de ${SEDE_NOMBRE[solicitud.sede]}. Asunto: ${solicitud.asunto}. ${servicio} ${enviado} Aprovecha esos datos sin repetir preguntas ya contestadas. Si en el chat ha corregido su elección, sigue lo último que te diga.`;
}

function contactoBloqueado(contacto) {
  const dnd = Object.entries(contacto.dndSettings || {})
    .some(([canal, estado]) => canal.toLowerCase() === 'whatsapp' && String(estado?.status).toLowerCase() === 'active');
  return contacto.dnd === true || dnd || (contacto.tags || []).some((tag) => TAGS_BLOQUEO.has(String(tag).toLowerCase()));
}

export function procesadorFormularios({ setter, ajustes, locationId, avisar, clock = Date.now }) {
  const { repo, ghl, aislamiento } = setter;
  const desde = Date.parse(ajustes.desde);
  const ids = new Set(ajustes.ids);
  if (!setter.live || aislamiento.modo !== 'activo' || aislamiento.locationId !== locationId ||
      !Number.isFinite(desde) || !ids.size || [...ids].some((id) => !Object.hasOwn(FORMULARIOS, id)) ||
      !ajustes.campoServicio || !ajustes.campoAsunto || !ajustes.plantilla) {
    throw new Error('Configuración incompleta o incompatible para solicitudes web');
  }

  const get = repo.db.prepare('SELECT estado FROM solicitudes_web WHERE id = ?');
  const guardar = repo.db.prepare(`INSERT OR IGNORE INTO solicitudes_web
    (id, contacto, formulario, fecha, telefono_hash, sede, servicio, asunto, estado)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const estado = repo.db.prepare('UPDATE solicitudes_web SET estado = ?, mensaje = ? WHERE id = ?');
  const duplicado = repo.db.prepare(`SELECT 1 FROM solicitudes_web
    WHERE (telefono_hash = ? OR contacto = ?) AND fecha >= ?
      AND estado IN ('enviando', 'aceptada', 'incierta', 'duplicada') LIMIT 1`);
  const reservar = repo.db.transaction((s, fin) => {
    if (get.get(s.id)) return false;
    const anterior = duplicado.get(s.claveTelefono, s.contacto, s.fecha - HORAS_24);
    const nuevoEstado = fin || (anterior ? 'duplicada' : 'enviando');
    guardar.run(s.id, s.contacto, s.formulario, s.fecha, s.claveTelefono, s.sede, s.servicio, s.asunto, nuevoEstado);
    return nuevoEstado === 'enviando';
  });

  async function procesar(s, plantilla) {
    if (get.get(s.id)) return;
    if (!s.consiente) { reservar(s, 'sin_permiso'); return; }
    const { contact: contacto } = await ghl.getContact(s.contacto);
    if (!contacto || contacto.id !== s.contacto || contacto.locationId !== locationId ||
        normalizarTelefono(contacto.phone) !== s.telefono || contactoBloqueado(contacto)) {
      reservar(s, 'bloqueada');
      return;
    }
    const nombre = String(contacto.firstName || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!nombre) { reservar(s, 'sin_nombre'); return; }
    const prueba = setter.esDePrueba({ telefono: s.telefono });
    const socio = !prueba && await setter.aimharder.buscarSocioPorTelefono(s.telefono);
    if (socio?.esSocio) { reservar(s, 'socio'); return; }

    const conversacion = await ghl.buscarConversacion(s.contacto);
    const previo = conversacion ? repo.getConv(conversacion.id) : null;
    if (previo?.ai_paused || previo?.derivado || previo?.aislado_bloqueo || previo?.tipo === 'socio') {
      reservar(s, 'bloqueada');
      return;
    }
    const recientes = conversacion ? await ghl.mensajes(conversacion.id) : [];
    if (recientes.some((m) => m.canal === 'whatsapp' && Date.parse(m.fecha) >= s.fecha - HORAS_24)) {
      reservar(s, 'chat_abierto');
      return;
    }
    const env = prepararEnvio(repo.db, plantilla.id, [nombre, s.asunto]);
    if (!reservar(s)) return;

    try {
      await ghl.req('PUT', `/contacts/${s.contacto}`, { customFields: [{ id: ajustes.campoAsunto, field_value: s.asunto }] });
    } catch {
      // Todavía no se ha solicitado el envío. La lectura de formularios volverá a recogerlo.
      repo.db.prepare('DELETE FROM solicitudes_web WHERE id = ? AND estado = ?').run(s.id, 'enviando');
      throw new Error('No se ha podido guardar el asunto en Nexor');
    }

    let respuesta;
    try {
      respuesta = await ghl.enviarPlantillaWa({
        contactId: s.contacto, nombre: env.plantilla.nombre, idioma: env.plantilla.idioma,
        categoria: env.plantilla.categoria, variables: env.variables, texto: env.texto,
      });
    } catch {
      estado.run('incierta', null, s.id);
      avisar?.(s.id);
      return;
    }
    const mensaje = respuesta?.messageId || null;
    estado.run(mensaje ? 'aceptada' : 'incierta', mensaje, s.id);
    if (!mensaje) { avisar?.(s.id); return; }
    const chatId = respuesta.conversationId || conversacion?.id || (await ghl.buscarConversacion(s.contacto))?.id;
    if (!chatId) return; // El contexto sigue disponible por contacto cuando llegue la respuesta.
    await setter.enSerie(chatId, () => {
      const chat = repo.upsertConv({ id: chatId, contact_id: s.contacto, channel: 'whatsapp', nombre, telefono: s.telefono });
      if (!chat.aislado_bloqueo && chat.channel === 'whatsapp') {
        repo.updateConv(chatId, { aislado_num: aislamiento.clave, sede: s.sede });
        repo.addMessage({ conversation_id: chatId, external_id: mensaje, autor: 'ia', texto: env.texto, tipo: 'plantilla' });
      }
    });
  }

  return async function revisar() {
    const plantilla = repo.db.prepare('SELECT id FROM plantillas_wa WHERE nombre = ? AND activa = 1').get(ajustes.plantilla);
    if (!plantilla) throw new Error('La plantilla de solicitud web no está activa en el catálogo de Zapp');
    const ahora = clock();
    const day = (t) => new Date(t).toISOString().slice(0, 10);
    const startAt = day(Math.max(desde, ahora - 2 * HORAS_24));
    const endAt = day(ahora + HORAS_24);
    let pagina = 1;
    const filas = [];
    do {
      const respuesta = await ghl.formularios({ startAt, endAt, page: pagina });
      if (!Array.isArray(respuesta?.submissions)) throw new Error('Nexor no devolvió la lista de solicitudes web');
      filas.push(...respuesta.submissions);
      const siguiente = Number(respuesta.meta?.nextPage || 0);
      if (siguiente && siguiente <= pagina) throw new Error('Paginación de formularios incoherente en Nexor');
      pagina = siguiente;
    } while (pagina);
    const solicitudes = filas.map((fila) => prepararSolicitud(fila, { ids, campoServicio: ajustes.campoServicio, locationId, desde, ahora }))
      .filter(Boolean).sort((a, b) => a.fecha - b.fecha);
    for (const solicitud of solicitudes) {
      try { await procesar(solicitud, plantilla); }
      catch { console.error(`[formularios] fallo de proceso para la solicitud ${solicitud.id}`); }
    }
  };
}
