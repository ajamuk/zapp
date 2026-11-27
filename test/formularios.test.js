import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo } from '../src/db.js';
import { crear } from '../src/plantillas.js';
import { prepararSolicitud, procesadorFormularios, contextoSolicitud } from '../src/formularios.js';

const locationId = 'location-prueba';
const parla = 'PL7nPBgjoiyOOsPTPXQp';
const ros = 'fHEhwttrRKTKvVmgfcoh';
const canaveral = 'TAQsBdExmLa6e0eqdpzH';
const createdAt = '2026-11-27T06:00:00Z';
const desde = '2026-11-27T05:00:00Z';
const ahora = Date.parse('2026-11-27T06:01:00Z');
const datos = { location_id: locationId, phone: '+34600000000', terms_and_conditions: 'Acepto las políticas de privacidad' };
const registro = (id, formId, extra = {}) => ({ id, formId, createdAt, contactId: 'contacto', others: { ...datos, ...extra } });
const match = { ids: new Set([parla, ros, canaveral]), campoServicio: 'servicio', locationId, desde: Date.parse(desde), ahora };

test('sede del formulario, servicio exacto y autorización específica de apertura', () => {
  assert.equal(prepararSolicitud(registro('1', parla, { servicio: 'CrossFit Academy' }), match).asunto, 'CrossFit Academy en Parla');
  assert.equal(prepararSolicitud(registro('2', ros, { servicio: 'Aún no lo sé' }), match).asunto, 'entrenar en Las Rosas');
  assert.equal(prepararSolicitud(registro('3', canaveral), match).consiente, false);
  assert.equal(prepararSolicitud(registro('4', parla, { location_id: 'otra' }), match), null);
  assert.equal(prepararSolicitud({ ...registro('5', parla), createdAt: '2026-11-25T01:00:00Z' }, match), null);
});

function entorno({ dnd = false, incierto = false, abierto = false, citas = [] } = {}) {
  const r = repo(openDb(':memory:'));
  crear(r.db, { nombre: 'mpo_sofia_solicitud_web_v1', idioma: 'es_ES', categoria: 'UTILITY', cuerpo: 'Hola, {{1}}. Solicitud sobre {{2}}.' });
  const salientes = [];
  const cartera = [registro('a', parla, { servicio: 'CrossFit Academy' }), registro('b', parla, { servicio: 'CrossFit Academy' })];
  const ghl = {
    formularios: async () => ({ submissions: cartera, meta: { nextPage: null } }),
    getContact: async (id) => ({ contact: { id, locationId, phone: datos.phone, firstName: 'Prueba', dnd } }),
    buscarContactoPorTelefono: async () => ({ id: 'contacto', locationId, phone: datos.phone, dnd }),
    buscarConversacion: async () => abierto ? { id: 'chat' } : null,
    mensajes: async () => [{ canal: 'whatsapp', fecha: createdAt }],
    req: async (_method, path) => path.endsWith('/appointments') ? { events: citas } : ({}),
    enviarPlantillaWa: async (payload) => {
      salientes.push(payload);
      if (incierto) throw new Error('timeout');
      return { messageId: 'mensaje', conversationId: 'chat' };
    },
  };
  const setter = { repo: r, ghl, live: true, aislamiento: { modo: 'activo', locationId, clave: 'test' },
    esDePrueba: () => false, aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: false }) },
    enSerie: async (_chatId, fn) => fn() };
  const ajustes = { desde, ids: [parla], campoServicio: 'servicio', campoAsunto: 'asunto', plantilla: 'mpo_sofia_solicitud_web_v1' };
  return { r, salientes, revisar: procesadorFormularios({ setter, ajustes, locationId, clock: () => ahora }) };
}

test('dos registros de la misma persona y nuevas lecturas en Nexor producen un único WhatsApp con contexto', async () => {
  const { r, salientes, revisar } = entorno();
  await revisar();
  await revisar();
  assert.equal(salientes.length, 1);
  assert.deepEqual(salientes[0].variables, ['Prueba', 'CrossFit Academy en Parla']);
  assert.equal(r.getConv('chat').sede, 'parla');
  assert.match(contextoSolicitud(r.db, r.getConv('chat'), new Date(ahora)), /Eligió CrossFit Academy/);
  assert.equal(r.db.prepare('SELECT estado FROM solicitudes_web WHERE id = ?').get('b').estado, 'duplicada');
});

test('respeta la baja de mensajes y el chat abierto y concilia un envío incierto sin repetirlo', async () => {
  for (const [ajustes, estado, total] of [[{ dnd: true }, 'bloqueada', 0], [{ abierto: true }, 'chat_abierto', 0], [{ incierto: true }, 'incierta', 1]]) {
    const { r, revisar, salientes } = entorno(ajustes);
    await revisar();
    await revisar();
    assert.equal(salientes.length, total);
    assert.equal(r.db.prepare('SELECT estado FROM solicitudes_web WHERE id = ?').get('a').estado, estado);
  }
});

test('quioscos, citas y opinión se guardan como contexto sin inferir permiso ni reservas', () => {
  const extras = ['hrjdwDKjjm07JJjNpEj6', 'sk2RgvYpQM64Y5w2FNkE', 'u2sPxLPd7WJ6g9QWpq3L'];
  const scope = { ...match, ids: new Set(extras) };
  for (const [n, formId] of extras.entries()) {
    const info = prepararSolicitud(registro('ext' + n, formId), scope);
    assert.equal(info.consiente, false);
  }
  assert.match(prepararSolicitud(registro('cita', extras[1]), scope).asunto, /solicitud de clase de prueba en Parla/);
});

test('recepción guarda una sola entrada durable y Meta valida subcuenta y formulario', () => {
  const { r, revisar } = entorno();
  const clave = '3eadc8a9-221e-4b7e-8965-cfabe2a56cb9';
  const payload = { centre: 'getafe', name: 'Recepción prueba', phone: datos.phone, consent: true, experience: 'past' };
  assert.equal(revisar.recepcion(payload, clave), true);
  assert.equal(revisar.recepcion(payload, clave), true);
  assert.equal(revisar.recepcion({ ...payload, consent: false }, clave), false);
  assert.equal(revisar.entradaCrm({ locationId: 'otra', contact_id: 'a'.repeat(20), customData: { formulario_sofia: 'academia_parla' } }), false);
  assert.equal(revisar.entradaCrm({ locationId, contact_id: 'a'.repeat(20), customData: { formulario_sofia: 'academia_parla' } }), true);
  assert.equal(r.db.prepare('SELECT count(*) AS n FROM solicitudes_externas').get().n, 2);
});

test('un recordatorio válido y concurrente produce un solo envío, y uno incierto queda bloqueado', async () => {
  const clave = '9f4d3ef5-228a-4316-ab93-f3d4509cbf47';
  const datosAviso = {
    recipientPhone: datos.phone, appointmentAt: '2026-11-27T14:30:00Z',
    templateName: 'sofia_seguimiento_v1', templateLanguage: 'es_ES', bodyVariables: ['Tu clase de prueba en Parla'],
  };
  for (const caso of [{}, { incierto: true }, { dnd: true }]) {
    const { r, revisar, salientes } = entorno(caso);
    crear(r.db, { nombre: 'sofia_seguimiento_v1', idioma: 'es_ES', cuerpo: 'Recordatorio. {{1}}' });
    assert.equal((await revisar.recordatorio({ ...datosAviso, appointmentAt: createdAt }, clave))[0], 400);
    const resultados = await Promise.all([revisar.recordatorio(datosAviso, clave), revisar.recordatorio(datosAviso, clave)]);
    assert.equal(salientes.length, caso.dnd ? 0 : 1);
    const [status, recibo] = await revisar.recordatorio(datosAviso, clave);
    if (caso.dnd) assert.equal(status, 422);
    else if (caso.incierto) {
      assert.equal(status, 409);
      assert.equal(recibo.retryable, false);
    } else {
      assert.equal(status, 200);
      assert.equal(recibo.messageId, 'mensaje');
      assert.equal(recibo.messageText, 'Recordatorio. Tu clase de prueba en Parla');
      assert.ok(resultados.some(([codigo]) => codigo === 200));
    }
  }
});

test('la cita de Nexor pasa la sede, la actividad y la hora sin disparar un WhatsApp adicional', async () => {
  const contacto = 'c'.repeat(20);
  const appointment = { id: 'r'.repeat(20), contactId: contacto, locationId, appointmentStatus: 'confirmed',
    calendarId: '2D7yvfbpgGlBwPd4OfVJ', startTime: '2026-11-27T16:00:00Z' };
  const { revisar, r, salientes } = entorno({ citas: [appointment] });
  assert.equal(revisar.entradaCrm({ location: { id: locationId }, contact_id: contacto,
    appointment, customData: { formulario_sofia: 'cita_ghl' } }), true);
  await revisar();
  const saved = r.db.prepare('SELECT sede, servicio, asunto, estado FROM solicitudes_web WHERE contacto = ?').get(contacto);
  assert.equal(saved.sede, 'parla');
  assert.equal(saved.servicio, 'CrossFit Academy');
  assert.match(saved.asunto, /17:00/);
  assert.equal(saved.estado, 'sin_permiso');
  assert.equal(salientes.length, 1); // Solo el formulario web de la otra persona de prueba.
});
