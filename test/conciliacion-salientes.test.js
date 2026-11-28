// Conciliación por id de los mensajes del equipo (GHL solo avisa de los entrantes; los del móvil llegan tarde y con
// su hora original). Datos sintéticos: ningún teléfono ni id es real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import { estadoAislamiento } from '../src/aislamiento.js';

const PROPIO = '+34910000001'; const OTRO = '+34910000002'; const LEAD = '+34600000000'; const LOC = 'locSofia';
const AISL = estadoAislamiento({ numero: PROPIO, locationId: LOC, locationCliente: LOC });
const T0 = new Date('2026-11-17T11:00:00Z'); // martes 12:00 en Madrid
const hace = (min) => new Date(T0.getTime() - min * 60000).toISOString();

const entrante = (id, conv, min, extra = {}) => ({
  id, direccion: 'inbound', tipo: 'TYPE_WHATSAPP', canal: 'whatsapp', texto: 'hola', adjuntos: [], userId: null, source: null,
  fecha: hace(min), locationId: LOC, conversationId: conv, contactId: `k-${conv}`, para: PROPIO, de: LEAD, ...extra,
});
const saliente = (id, conv, min, extra = {}) => ({
  ...entrante(id, conv, min), direccion: 'outbound', texto: `te escribe el equipo (${id})`, userId: 'u1', source: 'app', para: LEAD, de: PROPIO, ...extra,
});

function montar({ mensajes = {}, recientes = [] } = {}) {
  const repo = crearRepo(openDb(':memory:'));
  const sal = { lecturas: {} };
  const ghl = {
    sendMessage: async () => ({ messageId: 'x' }), addTags: async () => {}, removeTags: async () => {}, assign: async () => {}, addNote: async () => {}, getContact: async () => ({ contact: {} }),
    conversacionesRecientes: async () => recientes,
    mensajes: async (id) => { sal.lecturas[id] = (sal.lecturas[id] || 0) + 1; return mensajes[id] || []; },
  };
  const setter = new Setter({
    repo, ghl, live: true, aislamiento: AISL, sleep: async () => {}, now: () => T0, random: () => 0, avisar: async () => {},
    aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: false }) },
    complete: async () => { throw new Error('no debería contestar'); },
  });
  return { repo, setter, sal };
}

/** Chat ya conocido y verificado para el número propio, creado hace `min` minutos. */
function chat(repo, id, { min = 600, ...extra } = {}) {
  repo.upsertConv({ id, contact_id: `k-${id}`, channel: 'whatsapp' });
  repo.db.prepare('UPDATE conversations SET created_at = ? WHERE id = ?').run(hace(min), id);
  repo.updateConv(id, { aislado_num: AISL.clave, ...extra });
}
const autores = (repo, id) => repo.db.prepare('SELECT autor, external_id FROM messages WHERE conversation_id = ? ORDER BY created_at').all(id);

test('mensaje del equipo por detrás del cursor (GHL lo listó tarde): entra y aparta a Sofía', async () => {
  const { repo, setter } = montar({ mensajes: { c1: [entrante('m1', 'c1', 120), saliente('o1', 'c1', 90)] } });
  chat(repo, 'c1', { ghl_sync_at: hace(60) });
  repo.addMessage({ conversation_id: 'c1', external_id: 'm1', autor: 'lead', texto: 'hola', created_at: hace(120) });
  // Con el cursor en «hace 60 min», sincronizar ya no lo mira
  await setter.sincronizar('c1', null, { enMarcha: false });
  assert.deepEqual(autores(repo, 'c1').map((x) => x.autor), ['lead']);
  const r = await setter.conciliarSalientes('c1');
  assert.deepEqual(r, { salientes: 1, historial: 0 });
  assert.deepEqual(autores(repo, 'c1'), [{ autor: 'lead', external_id: 'm1' }, { autor: 'humano', external_id: 'o1' }]);
  assert.equal(repo.getConv('c1').ai_paused, 1, 'el equipo ha escrito: Sofía se aparta');
  // Repetirlo no duplica nada
  assert.deepEqual(await setter.conciliarSalientes('c1'), { salientes: 0, historial: 0 });
});

test('mensaje del equipo anterior a lo último de Sofía: solo historial, no la pausa', async () => {
  const { repo, setter } = montar({ mensajes: { c1: [saliente('o1', 'c1', 90, { userId: null, texto: 'desde el móvil' })] } });
  chat(repo, 'c1');
  repo.addMessage({ conversation_id: 'c1', autor: 'ia', texto: 'hola, soy Sofía', created_at: hace(30) });
  assert.deepEqual(await setter.conciliarSalientes('c1'), { salientes: 0, historial: 1 });
  const c = repo.getConv('c1');
  assert.equal(c.ai_paused, 0);
  assert.deepEqual(autores(repo, 'c1').map((x) => x.autor), ['humano', 'ia'], 'en su sitio por la hora real');
});

test('mensaje del equipo de antes del primer contacto: entra como historial', async () => {
  const { repo, setter } = montar({ mensajes: { c1: [saliente('o1', 'c1', 50), entrante('m1', 'c1', 45)] } });
  chat(repo, 'c1', { min: 45 });
  assert.deepEqual(await setter.conciliarSalientes('c1'), { salientes: 0, historial: 1 });
  assert.equal(repo.getConv('c1').ai_paused, 0);
  // Los entrantes no se tocan aquí (de esos se encarga sincronizar)
  assert.deepEqual(autores(repo, 'c1').map((x) => x.autor), ['humano']);
});

test('no entran workflows, copias del conector, salientes de otra subcuenta ni lo que ya tiene Sofía', async () => {
  const lista = [
    saliente('w1', 'c1', 100, { source: 'workflow' }),
    saliente('n1', 'c1', 80, { texto: 'mensaje nativo' }),
    saliente('copia', 'c1', 80, { tipo: 'TYPE_CUSTOM_SMS', canal: 'sms', source: 'api', texto: 'mensaje nativo', de: null }),
    saliente('fuera', 'c1', 70, { locationId: 'otraSubcuenta' }),
    saliente('ia1', 'c1', 60, { texto: 'hola, soy Sofía' }),
    saliente('viejo', 'c1', 25 * 60),
  ];
  const { repo, setter } = montar({ mensajes: { c1: lista } });
  chat(repo, 'c1', { min: 30 * 60 });
  repo.addMessage({ conversation_id: 'c1', autor: 'ia', texto: 'hola, soy Sofía', created_at: hace(61) }); // aún sin id de GHL
  const r = await setter.conciliarSalientes('c1');
  assert.deepEqual(r, { salientes: 0, historial: 1 });
  assert.deepEqual(autores(repo, 'c1').map((x) => x.external_id), ['n1', null], 'solo el nativo; lo de hace más de 24 h no se mira');
});

test('conversación compartida con otra línea: se bloquea y no se importa nada', async () => {
  const { repo, setter } = montar({ mensajes: { c1: [saliente('o1', 'c1', 90), entrante('m9', 'c1', 80, { para: OTRO })] } });
  chat(repo, 'c1');
  const r = await setter.conciliarSalientes('c1');
  assert.equal(r.compartida, true);
  assert.ok(repo.getConv('c1').aislado_bloqueo);
  assert.equal(autores(repo, 'c1').length, 0);
});

test('chat en el que Sofía está escribiendo, de prueba o desconocido: no se toca', async () => {
  const { repo, setter, sal } = montar({ mensajes: { c1: [saliente('o1', 'c1', 90)] } });
  chat(repo, 'c1');
  setter.enCurso = new Set(['c1']);
  assert.deepEqual(await setter.conciliarSalientes('c1'), { salientes: 0, historial: 0, enCurso: true });
  assert.equal(await setter.conciliarSalientes('prueba-1'), null);
  assert.equal(await setter.conciliarSalientes('nadie'), null);
  assert.equal(sal.lecturas.c1, undefined);
});

test('repaso de chats recientes: solo los conocidos, sin releer los que no cambian, y compartido si ya hay uno', async () => {
  const recientes = [
    { id: 'c1', contactId: 'k-c1', ultimo: hace(10) },
    { id: 'nuevo', contactId: 'k-nuevo', ultimo: hace(10) },
    { id: 'viejo', contactId: 'k-viejo', ultimo: hace(30 * 60) },
  ];
  const { repo, setter, sal } = montar({ recientes, mensajes: { c1: [saliente('o1', 'c1', 20)] } });
  chat(repo, 'c1'); chat(repo, 'viejo');
  const [a, b] = [setter.conciliarRecientes(), setter.conciliarRecientes()];
  assert.equal(a, b, 'dos peticiones a la vez comparten el mismo repaso');
  assert.deepEqual(await a, { revisadas: 1, recuperados: 1, motivo: 'repaso' });
  assert.deepEqual(Object.keys(sal.lecturas), ['c1'], 'ni el chat nuevo (lo lleva el barrido) ni el de fuera de la ventana');
  // Sin cambios en GHL no se vuelve a leer…
  await setter.conciliarRecientes();
  assert.equal(sal.lecturas.c1, 1);
  // …salvo que se pida sin espera (botón «Actualizar»)
  assert.deepEqual(await setter.conciliarRecientes({ refrescoMs: 0 }), { revisadas: 1, recuperados: 0, motivo: 'repaso' });
  assert.equal(sal.lecturas.c1, 2);
});

test('GHL no contesta: el repaso devuelve null y el chat se vuelve a mirar la próxima vez', async () => {
  const { repo, setter, sal } = montar({ recientes: [{ id: 'c1', contactId: 'k-c1', ultimo: hace(10) }] });
  chat(repo, 'c1');
  setter.ghl.mensajes = async (id) => { sal.lecturas[id] = (sal.lecturas[id] || 0) + 1; throw new Error('caído'); };
  assert.deepEqual(await setter.conciliarRecientes(), { revisadas: 0, recuperados: 0, motivo: 'repaso' });
  await setter.conciliarRecientes();
  assert.equal(sal.lecturas.c1, 2);
  setter.ghl.conversacionesRecientes = async () => { throw new Error('caído'); };
  assert.equal(await setter.conciliarRecientes(), null);
});

test('panel abierto y chat abierto: repaso en segundo plano, con espera entre uno y otro', async () => {
  let ahora = T0.getTime();
  const { repo, setter, sal } = montar({ recientes: [{ id: 'c1', contactId: 'k-c1', ultimo: hace(10) }], mensajes: { c1: [saliente('o1', 'c1', 20)] } });
  setter.now = () => new Date(ahora);
  chat(repo, 'c1');
  assert.equal(setter.conciliarAlAbrirPanel(), true);
  await setter.conciliando;
  assert.equal(setter.conciliarAlAbrirPanel(), false, 'a los pocos segundos no se repite');
  ahora += 5 * 60000;
  assert.equal(setter.conciliarAlAbrirPanel(), true);
  await setter.conciliando;
  assert.equal(autores(repo, 'c1').length, 1);

  assert.equal(setter.conciliarAlAbrirChat('c1'), true);
  assert.equal(setter.conciliarAlAbrirChat('c1'), false, 'el refresco de cada 5 s no vuelve a leer GHL');
  await setter.enSerie('c1', async () => {});
  const lecturas = sal.lecturas.c1;
  ahora += 60000;
  assert.equal(setter.conciliarAlAbrirChat('c1'), true);
  await setter.enSerie('c1', async () => {});
  assert.equal(sal.lecturas.c1, lecturas + 1);
});

test('panel: la lista y el chat lanzan el repaso, y los botones «Actualizar» dicen cuánto han traído', async () => {
  const { config } = await import('../src/config.js');
  const { crearApp } = await import('../src/server.js');
  config.adminToken = 'clave-test';
  const { repo, setter, sal } = montar({ recientes: [{ id: 'c1', contactId: 'k-c1', ultimo: hace(10) }], mensajes: { c1: [saliente('o1', 'c1', 20)] } });
  chat(repo, 'c1');
  const srv = crearApp({ setter, repo }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}/admin`;
  const api = (ruta, o = {}) => fetch(base + ruta, { ...o, headers: { authorization: 'Bearer clave-test' } });
  try {
    assert.equal((await api('/panel/conversaciones')).status, 200);
    await setter.conciliando;
    assert.equal(sal.lecturas.c1, 1, 'abrir la lista ha repasado los chats recientes');
    assert.equal((await api('/panel/conversaciones/c1')).status, 200);
    await setter.enSerie('c1', async () => {});
    assert.equal(sal.lecturas.c1, 2, 'abrir el chat lo ha repasado');
    const todos = await (await api('/panel/conciliar', { method: 'POST' })).json();
    assert.deepEqual(todos, { revisadas: 1, recuperados: 0, motivo: 'botón Actualizar' });
    const uno = await api('/panel/conversaciones/c1/conciliar', { method: 'POST' });
    assert.deepEqual(await uno.json(), { salientes: 0, historial: 0 });
    assert.equal((await api('/panel/conversaciones/nadie/conciliar', { method: 'POST' })).status, 404);
    assert.equal(repo.db.prepare("SELECT count(*) n FROM messages WHERE external_id = 'o1'").get().n, 1, 'sin duplicados');
  } finally { srv.close(); }
});
