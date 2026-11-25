import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import { procesarSeguimientos, contextoTarea } from '../src/followups.js';
import { leerAjustes, guardarAjustes } from '../src/ajustes.js';
import * as reglas from '../src/reglas.js';
import { reglasDelNivel, entraEnNivel, esUltimaDelNivel, normasDeTono } from '../src/intensidad.js';

const T0 = new Date('2026-11-17T11:00:00Z'); // martes 12:00 en Madrid

function montar({ nivel } = {}) {
  const repo = crearRepo(openDb(':memory:'));
  if (nivel) guardarAjustes(repo, { intensidadSeguimientos: nivel });
  const sal = { enviados: [], requests: [] };
  let reloj = new Date(T0);
  const cola = [{ mensajes: ['te cuento'] }];
  const setter = new Setter({
    repo, live: true, sleep: async () => {}, now: () => reloj, random: () => 0,
    ghl: {
      sendMessage: async ({ texto }) => { sal.enviados.push(texto); return { messageId: `m${sal.enviados.length}` }; },
      enviarPorPlantilla: async () => ({ messageId: null }),
      addTags: async () => {}, removeTags: async () => {}, assign: async () => {}, addNote: async () => {}, getContact: async () => ({ contact: {} }),
    },
    aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: false }) },
    complete: async (req) => {
      sal.requests.push(req);
      const r = cola.shift() || { mensajes: ['sigo por aquí'] };
      return { content: [{ type: 'tool_use', id: 't', name: 'responder', input: { fase: 'f2 diagnóstico', ...r } }] };
    },
  });
  return { repo, setter, sal, avanzar: (ms) => { reloj = new Date(reloj.getTime() + ms); } };
}
const entrante = (texto, id) => ({ evento: 'inbound', conversationId: 'c1', contactId: 'k1', canal: 'whatsapp', texto, messageId: id, telefono: '+34600000000' });
const pendientes = (repo) => repo.db.prepare("SELECT regla_id FROM scheduled WHERE estado = 'pendiente' ORDER BY due_at").all().map((x) => x.regla_id);

test('intensidad: «normal» por defecto; se guarda y rechaza valores raros', () => {
  const repo = crearRepo(openDb(':memory:'));
  assert.equal(leerAjustes(repo).intensidadSeguimientos, 'normal');
  assert.equal(guardarAjustes(repo, { intensidadSeguimientos: 'suave' }).intensidadSeguimientos, 'suave');
  assert.throws(() => guardarAjustes(repo, { intensidadSeguimientos: 'maxima' }), /no válida/);
  assert.equal(leerAjustes(repo).intensidadSeguimientos, 'suave');
});

test('intensidad: qué reglas entran en cada nivel (las operativas, siempre)', () => {
  const todas = reglas.listar(crearRepo(openDb(':memory:')).db);
  const ids = (n) => [...reglasDelNivel(todas, n)].sort();
  assert.deepEqual(ids('suave'), ['largo-plazo', 'ultimo-intento-24h']);
  assert.deepEqual(ids('normal'), ['cierre-4-dias', 'largo-plazo', 'largo-plazo-2', 'ultimo-intento-24h']);
  assert.deepEqual(ids('intensa'), ['cierre-4-dias', 'comercial-5h', 'largo-plazo', 'largo-plazo-2', 'ultimo-intento-24h']);
  const r = (id) => todas.find((x) => x.id === id);
  for (const n of ['suave', 'normal', 'intensa']) {
    assert.ok(entraEnNivel(r('info-tras-reserva'), todas, n), `info-tras-reserva en ${n}`);
    assert.ok(entraEnNivel(r('recordatorio-prueba'), todas, n), `recordatorio en ${n}`);
  }
  assert.ok(esUltimaDelNivel(r('ultimo-intento-24h'), todas, 'suave'));
  assert.ok(!esUltimaDelNivel(r('ultimo-intento-24h'), todas, 'normal'));
  assert.ok(esUltimaDelNivel(r('cierre-4-dias'), todas, 'normal'));
  assert.ok(esUltimaDelNivel(r('largo-plazo'), todas, 'suave') && !esUltimaDelNivel(r('largo-plazo'), todas, 'normal'));
});

test('intensidad: un silencio desactivado deja sitio al siguiente', () => {
  const repo = crearRepo(openDb(':memory:'));
  repo.db.prepare("UPDATE reglas_seguimiento SET activo = 0 WHERE id = 'ultimo-intento-24h'").run();
  assert.deepEqual([...reglasDelNivel(reglas.listar(repo.db), 'suave')].sort(), ['cierre-4-dias', 'largo-plazo']);
});

test('intensidad: «normal» no programa el de 5 h; «suave» solo el de 24 h', async () => {
  for (const [nivel, esperado] of [['normal', ['info-tras-reserva', 'ultimo-intento-24h', 'cierre-4-dias']], ['suave', ['info-tras-reserva', 'ultimo-intento-24h']], ['intensa', ['comercial-5h', 'info-tras-reserva', 'ultimo-intento-24h', 'cierre-4-dias']]]) {
    const { repo, setter, avanzar } = montar({ nivel });
    await setter.handleWebhook(entrante('precio?', 'w1'));
    avanzar(60000); await setter.tick();
    assert.deepEqual(pendientes(repo), esperado, nivel);
  }
});

test('intensidad: lo ya programado que no entra en el nivel nuevo no sale', async () => {
  const { repo, setter, sal, avanzar } = montar({ nivel: 'intensa' });
  await setter.handleWebhook(entrante('precio?', 'w1'));
  avanzar(60000); await setter.tick();
  assert.ok(pendientes(repo).includes('comercial-5h'));
  guardarAjustes(repo, { intensidadSeguimientos: 'normal' });
  const antes = sal.enviados.length;
  avanzar(300 * 60000);
  await procesarSeguimientos(setter);
  assert.equal(sal.enviados.length, antes);
  assert.match(repo.db.prepare("SELECT estado || ' ' || detalle d FROM scheduled WHERE regla_id = 'comercial-5h'").get().d, /omitido no entra en la intensidad «Normal»/);
});

test('intensidad: el tono va en las instrucciones de los comerciales, no en los operativos', () => {
  const todas = reglas.listar(crearRepo(openDb(':memory:')).db);
  const r = (id) => todas.find((x) => x.id === id);
  const t = contextoTarea(r('cierre-4-dias'), {}, { reglas: todas, nivel: 'normal' });
  assert.match(t, /No crees urgencia/);
  assert.match(t, /No des precios ni propongas el alta/);
  assert.match(t, /Es el último mensaje/);
  assert.match(t, /Intensidad normal/);
  assert.doesNotMatch(contextoTarea(r('ultimo-intento-24h'), {}, { reglas: todas, nivel: 'normal' }), /Es el último mensaje/);
  assert.match(contextoTarea(r('ultimo-intento-24h'), {}, { reglas: todas, nivel: 'suave' }), /Es el último mensaje[\s\S]*Intensidad suave|Intensidad suave[\s\S]*Es el último mensaje/);
  assert.deepEqual(normasDeTono(r('recordatorio-prueba'), todas, 'normal'), []);
  assert.deepEqual(normasDeTono(r('info-tras-reserva'), todas, 'normal'), []);
  assert.doesNotMatch(contextoTarea(r('cierre-4-dias'), {}), /No crees urgencia/); // sin nivel (llamadas antiguas): igual que antes
});
