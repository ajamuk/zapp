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
  ryK7OnOBu179FUkFpMaL: { sede: 'las_rosas', tipo: 'quiosco' },
  hrjdwDKjjm07JJjNpEj6: { sede: 'getafe', tipo: 'quiosco' },
  w6lYwy5DrhiDrHbL448c: { sede: 'parla', tipo: 'quiosco' },
  AUICT7vBIwRL8gBw8xyA: { sede: 'las_rosas', permiso: 'aviso' },
  Z4WIoHTFKFuZiX7kcSn5: { sede: 'parla', permiso: 'aviso' },
  iNHm8fAVl7eO6LKfdpPP: { sede: 'parla', tipo: 'cita' },
  sk2RgvYpQM64Y5w2FNkE: { sede: 'parla', tipo: 'cita' },
  EaYGNKXdpWEPzhU2KsP7: { sede: 'parla', tipo: 'cita' },
  kvAEIjv8F1juV2Yksa0q: { tipo: 'cita' },
  pPjWm6WOYqnInYWSFngQ: { sede: 'parla', tipo: 'campaña' },
  a18ck1HvdFXZ5V1zmL4s: { sede: 'getafe', tipo: 'campaña' },
  eRc129PEIAi1Vdhoa43o: { sede: 'getafe', tipo: 'campaña' },
  brFVZ9t2tezEeK40dmAn: { sede: 'parla', tipo: 'campaña' },
  Bt30konfEyZDdXMUeq8k: { tipo: 'campaña' },
  u2sPxLPd7WJ6g9QWpq3L: { tipo: 'opinión' },
};

const SEDES_RECEPTION = { getafe: 'getafe', parla: 'parla', 'las-rosas': 'las_rosas' };
const EXPERIENCIAS = { never: 'No ha entrenado CrossFit antes', current: 'Entrena CrossFit actualmente', past: 'Ha entrenado CrossFit en el pasado' };
const META = {
  academia_parla: 'parla',
  academia_las_rosas: 'las_rosas',
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
  const seleccion = lista(datos.djlH6rQjgN3n4Re7vOlR)[0];
  const sede = ruta.sede || Object.keys(SEDES_RECEPTION).map((id) => SEDES_RECEPTION[id])
    .find((id) => seleccion === `CrossFit MetroPolitano ${SEDE_NOMBRE[id]}`) || '';
  const tema = ruta.tipo === 'cita' ? 'una solicitud de clase de prueba' : servicio || 'entrenar';
  const asunto = ruta.apertura ? 'el aviso de apertura de El Cañaveral'
    : ruta.tipo === 'opinión' ? 'una opinión enviada a CrossFit MetroPolitano'
      : `${tema}${sede ? ` en ${SEDE_NOMBRE[sede]}` : ' en MetroPolitano'}`;
  const consentimiento = lista(datos.terms_and_conditions);
  const consiente = ruta.apertura ? lista(datos.AQSO7RVJ9ucjR1MAWmOs).includes(WHATSAPP_APERTURA)
    : ruta.permiso === 'aviso' || (!ruta.tipo && consentimiento.some((v) => v === true || v === 'Acepto las políticas de privacidad'));
  const experiencia = lista(datos.embxvmEEfSlvh4GuDEnk).find((v) => v === 'Sí' || v === 'No');
  return {
    id: fila.id, contacto: fila.contactId, formulario: fila.formId, fecha, telefono, sede,
    servicio, asunto, consiente, experiencia: experiencia === 'Sí' ? 'Indicó que ya ha practicado CrossFit' : experiencia === 'No' ? EXPERIENCIAS.never : null,
    claveTelefono: createHash('sha256').update(telefono).digest('hex'),
  };
}

export function contextoSolicitud(db, conv, ahora) {
  if (conv.channel !== 'whatsapp' || !conv.contact_id) return '';
  const solicitud = db.prepare(`SELECT sede, servicio, asunto, estado, experiencia FROM solicitudes_web
    WHERE contacto = ? AND fecha >= ? AND estado IN ('enviando', 'aceptada', 'incierta', 'chat_abierto', 'sin_permiso', 'duplicada')
    ORDER BY fecha DESC LIMIT 1`).get(conv.contact_id, ahora.getTime() - 7 * HORAS_24);
  if (!solicitud) return '';
  const servicio = solicitud.servicio
    ? `Eligió ${solicitud.servicio}.`
    : 'Dejó el servicio sin determinar o pidió solo un aviso de apertura.';
  const enviado = solicitud.estado === 'aceptada' ? 'El primer WhatsApp se escribió sobre esa solicitud.' : '';
  const sede = SEDE_NOMBRE[solicitud.sede] || 'sede por confirmar';
  const experiencia = solicitud.experiencia ? `${solicitud.experiencia}. ` : '';
  return `- Solicitud reciente, ${sede}. Asunto: ${solicitud.asunto}. ${servicio} ${experiencia}${enviado} Una solicitud de clase no confirma una reserva. Aprovecha los datos y sigue lo último que te diga.`;
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
    (id, contacto, formulario, fecha, telefono_hash, sede, servicio, asunto, estado, experiencia)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const estado = repo.db.prepare('UPDATE solicitudes_web SET estado = ?, mensaje = ? WHERE id = ?');
  const duplicado = repo.db.prepare(`SELECT 1 FROM solicitudes_web
    WHERE (telefono_hash = ? OR contacto = ?) AND fecha >= ?
      AND estado IN ('enviando', 'aceptada', 'incierta', 'duplicada') LIMIT 1`);
  const reservar = repo.db.transaction((s, fin) => {
    if (get.get(s.id)) return false;
    const anterior = duplicado.get(s.claveTelefono, s.contacto, s.fecha - HORAS_24);
    const nuevoEstado = fin || (anterior ? 'duplicada' : 'enviando');
    guardar.run(s.id, s.contacto, s.formulario, s.fecha, s.claveTelefono, s.sede, s.servicio, s.asunto, nuevoEstado, s.experiencia || null);
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
        repo.updateConv(chatId, { aislado_num: aislamiento.clave, ...(s.sede ? { sede: s.sede } : {}) });
        repo.addMessage({ conversation_id: chatId, external_id: mensaje, autor: 'ia', texto: env.texto, tipo: 'plantilla' });
      }
    });
  }

  const encolar = repo.db.prepare('INSERT OR IGNORE INTO solicitudes_externas (id, fecha, carga) VALUES (?, ?, ?)');
  const resolver = repo.db.prepare('UPDATE solicitudes_externas SET carga = NULL WHERE id = ?');

  function recepcion(d, clave) {
    const sede = Object.hasOwn(SEDES_RECEPTION, d?.centre) && SEDES_RECEPTION[d.centre];
    const telefono = normalizarTelefono(d?.phone);
    const nombre = typeof d?.name === 'string' ? d.name.trim().slice(0, 80) : '';
    if (!sede || !telefono || !nombre || d.consent !== true || !Object.hasOwn(EXPERIENCIAS, d.experience) ||
        !/^[a-f0-9-]{36}$/i.test(String(clave || ''))) return false;
    const id = `recepcion:${clave}`;
    encolar.run(id, clock(), JSON.stringify({ sede, telefono, nombre, experiencia: EXPERIENCIAS[d.experience] }));
    return true;
  }

  const getAviso = repo.db.prepare('SELECT resultado FROM avisos_prueba WHERE id = ?');
  const reclamarAviso = repo.db.prepare('INSERT OR IGNORE INTO avisos_prueba (id, fecha) VALUES (?, ?)');
  const guardarAviso = repo.db.prepare('UPDATE avisos_prueba SET resultado = ? WHERE id = ?');
  const avisoIncierto = [409, { code: 'send_unconfirmed', detail: 'Comprobar el mensaje en Nexor antes de reenviar', retryable: false }];
  const repetirAviso = (fila) => fila?.resultado ? [200, JSON.parse(fila.resultado)] : avisoIncierto;

  async function recordatorio(d, clave) {
    const id = String(clave || '');
    const telefono = normalizarTelefono(d?.recipientPhone);
    const fecha = Date.parse(d?.appointmentAt);
    const variable = typeof d?.bodyVariables?.[0] === 'string' ? d.bodyVariables[0].trim() : '';
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) || !telefono ||
        !Number.isFinite(fecha) || fecha <= clock() || fecha > clock() + HORAS_24 || !variable || variable.length > 550 ||
        d.templateName !== 'sofia_seguimiento_v1' || d.templateLanguage !== 'es_ES') {
      return [400, { code: 'invalid_reminder', retryable: false }];
    }
    const existente = getAviso.get(id);
    if (existente) return repetirAviso(existente);
    const plantilla = repo.db.prepare('SELECT id FROM plantillas_wa WHERE nombre = ? AND activa = 1').get(d.templateName);
    if (!plantilla) return [503, { code: 'template_not_approved', retryable: true }];
    const contacto = await ghl.buscarContactoPorTelefono(telefono);
    if (!contacto?.id || contacto.locationId !== locationId || normalizarTelefono(contacto.phone) !== telefono || contactoBloqueado(contacto)) {
      return [422, { code: 'contact_not_available', detail: 'Revisar el contacto o el permiso de WhatsApp en Nexor', retryable: false }];
    }
    const { plantilla: modelo, variables, texto } = prepararEnvio(repo.db, plantilla.id, [variable]);
    if (!reclamarAviso.run(id, clock()).changes) return repetirAviso(getAviso.get(id));
    try {
      const respuesta = await ghl.enviarPlantillaWa({
        contactId: contacto.id, nombre: modelo.nombre, idioma: modelo.idioma, categoria: modelo.categoria, variables, texto,
      });
      if (!respuesta?.messageId) return avisoIncierto;
      const resultado = { messageId: respuesta.messageId, conversationId: respuesta.conversationId || '', messageText: texto, provider: 'sofia' };
      guardarAviso.run(JSON.stringify(resultado), id);
      return [200, resultado];
    } catch {
      return avisoIncierto;
    }
  }

  function meta(payload) {
    const datos = payload.customData || payload.custom_data || {};
    const origen = datos.formulario_sofia;
    const contacto = payload.contact_id || payload.contactId;
    const location = payload.location_id || payload.locationId || payload.location?.id;
    if (!Object.hasOwn(META, origen) || location !== locationId || !/^[A-Za-z0-9]{20}$/.test(String(contacto || ''))) return false;
    const fecha = clock();
    const id = `meta:${origen}:${contacto}:${new Date(fecha).toISOString().slice(0, 10)}`;
    encolar.run(id, fecha, JSON.stringify({ sede: META[origen], contacto, servicio: 'CrossFit Academy' }));
    return true;
  }

  async function revisarExterno(plantilla) {
    const entradas = repo.db.prepare('SELECT id, fecha, carga FROM solicitudes_externas WHERE carga IS NOT NULL ORDER BY fecha LIMIT 25').all();
    for (const fila of entradas) {
      try {
        if (get.get(fila.id)) { resolver.run(fila.id); continue; }
        const d = JSON.parse(fila.carga);
        const consiente = fila.id.startsWith('recepcion:');
        if (consiente && !d.contacto) {
          const previo = await ghl.buscarContactoPorTelefono(d.telefono);
          d.contacto = previo?.id || (await ghl.upsertContacto({ telefono: d.telefono, nombre: d.nombre, fuente: 'Recepción · visita presencial' })).id;
          repo.db.prepare('UPDATE solicitudes_externas SET carga = ? WHERE id = ?').run(JSON.stringify(d), fila.id);
        }
        const telefono = d.telefono || normalizarTelefono((await ghl.getContact(d.contacto))?.contact?.phone);
        if (!telefono) { resolver.run(fila.id); continue; }
        const asunto = consiente ? `entrenar en ${SEDE_NOMBRE[d.sede]} después de tu visita`
          : `CrossFit Academy en ${SEDE_NOMBRE[d.sede]}`;
        await procesar({ ...d, id: fila.id, formulario: consiente ? 'recepcion' : 'meta', fecha: fila.fecha, telefono, asunto,
          consiente: consiente && fila.fecha > clock() - 2 * HORAS_24, claveTelefono: createHash('sha256').update(telefono).digest('hex') }, plantilla);
        if (get.get(fila.id)) resolver.run(fila.id);
      } catch { console.error('[formularios] solicitud externa pendiente de revisión'); }
    }
  }

  async function revisar() {
    const plantilla = repo.db.prepare('SELECT id FROM plantillas_wa WHERE nombre = ? AND activa = 1').get(ajustes.plantilla);
    if (!plantilla) throw new Error('La plantilla de solicitud web no está activa en el catálogo de Zapp');
    await revisarExterno(plantilla);
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
  }
  return Object.assign(revisar, { recepcion, meta, recordatorio });
}
