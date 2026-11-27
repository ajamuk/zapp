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

function entorno({ dnd = false, incierto = false, abierto = false } = {}) {
  const r = repo(openDb(':memory:'));
  crear(r.db, { nombre: 'mpo_sofia_solicitud_web_v1', idioma: 'es_ES', categoria: 'UTILITY', cuerpo: 'Hola, {{1}}. Solicitud sobre {{2}}.' });
  const salientes = [];
  const cartera = [registro('a', parla, { servicio: 'CrossFit Academy' }), registro('b', parla, { servicio: 'CrossFit Academy' })];
  const ghl = {
    formularios: async () => ({ submissions: cartera, meta: { nextPage: null } }),
    getContact: async () => ({ contact: { id: 'contacto', locationId, phone: datos.phone, firstName: 'Prueba', dnd } }),
    buscarConversacion: async () => abierto ? { id: 'chat' } : null,
    mensajes: async () => [{ canal: 'whatsapp', fecha: createdAt }],
    req: async () => ({}),
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

test('reinicio a mitad de envío: la solicitud queda «incierta» (no se repite) y se devuelve para abrir su alerta', async () => {
  const { openDb, repo: crearRepo } = await import('../src/db.js');
  const { recuperar } = await import('../src/arranque.js');
  const repo = crearRepo(openDb(':memory:'));
  const meter = repo.db.prepare(`INSERT INTO solicitudes_web (id, contacto, formulario, fecha, telefono_hash, sede, servicio, asunto, estado)
    VALUES (?, 'k1', 'f1', 1, 'h', 'getafe', NULL, 'entrenar en Getafe', ?)`);
  meter.run('s-enviando', 'enviando');
  meter.run('s-aceptada', 'aceptada');
  const r = recuperar(repo.db, new Date());
  assert.deepEqual(r.solicitudes, ['s-enviando']);
  const estado = (id) => repo.db.prepare('SELECT estado FROM solicitudes_web WHERE id = ?').get(id).estado;
  assert.equal(estado('s-enviando'), 'incierta');
  assert.equal(estado('s-aceptada'), 'aceptada');
  assert.equal(recuperar(repo.db, new Date()).solicitudes, undefined, 'sin nada a medias no devuelve nada');
});
