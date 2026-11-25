import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import { procesarSeguimientos, textoPrevisto } from '../src/followups.js';
import { Ghl } from '../src/ghl.js';
import { config } from '../src/config.js';
import { crearApp } from '../src/server.js';

const T0 = new Date('2026-11-17T11:00:00Z'); // martes 12:00 en Madrid

function montar({ respuestas = [], live = true } = {}) {
  const repo = crearRepo(openDb(':memory:'));
  repo.guardarAjuste('intensidadSeguimientos', 'intensa'); // mecánica con todos los seguimientos (los niveles, en intensidad.test.js)
  const sal = { enviados: [], plantillas: [], notas: [], requests: [] };
  let reloj = new Date(T0);
  const cola = [...respuestas];
  const setter = new Setter({
    repo, live, sleep: async () => {}, now: () => reloj, random: () => 0,
    ghl: {
      sendMessage: async ({ texto }) => { sal.enviados.push(texto); return { messageId: `m${sal.enviados.length}` }; },
      enviarPorPlantilla: async ({ texto }) => { sal.plantillas.push(texto); return { messageId: null }; },
      addTags: async () => {}, removeTags: async () => {}, assign: async () => {}, addNote: async (_, n) => sal.notas.push(n), getContact: async () => ({ contact: {} }),
    },
    aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: false }) },
    complete: async (req) => {
      sal.requests.push(req);
      const r = cola.shift();
      if (!r) throw new Error('sin respuesta preparada');
      return { content: [{ type: 'tool_use', id: 't', name: 'responder', input: { fase: 'f2 diagnóstico', ...r } }] };
    },
  });
  return { repo, setter, sal, avanzar: (ms) => { reloj = new Date(reloj.getTime() + ms); }, ahora: () => reloj };
}
const entrante = (texto, id) => ({ evento: 'inbound', conversationId: 'c1', contactId: 'k1', canal: 'whatsapp', texto, messageId: id, telefono: '+34600000000' });
const pendientes = (repo) => repo.db.prepare("SELECT regla_id, due_at, contexto FROM scheduled WHERE estado = 'pendiente' ORDER BY due_at").all();

test('en modo prueba también se programan y, al vencer, quedan como borrador', async () => {
  const { repo, setter, sal, avanzar } = montar({ live: false, respuestas: [{ mensajes: ['te cuento'] }, { mensajes: ['oye, qué te pareció lo de los horarios?'] }] });
  await setter.handleWebhook(entrante('precio?', 'w1'));
  avanzar(60000); await setter.tick();
  assert.deepEqual(pendientes(repo).map((x) => x.regla_id), ['comercial-5h', 'info-tras-reserva', 'ultimo-intento-24h', 'cierre-4-dias']);
  avanzar(300 * 60000);
  await procesarSeguimientos(setter);
  assert.equal(sal.enviados.length, 0); // nada sale al lead
  assert.match(sal.notas.at(-1), /Borrador IA.*\n.*horarios/);
  assert.match(repo.db.prepare("SELECT detalle FROM scheduled WHERE regla_id = 'comercial-5h'").get().detalle, /borrador/);
});

test('texto previsto: se ve antes y se envía tal cual si el chat no cambia; si cambia, se rehace', async () => {
  const { repo, setter, sal, avanzar } = montar({ respuestas: [{ mensajes: ['te paso horarios'] }, { mensajes: ['sigues interesada en parla?'] }, { mensajes: ['texto nuevo tras su mensaje'] }] });
  await setter.handleWebhook(entrante('horarios?', 'w1'));
  avanzar(60000); await setter.tick();
  const s = repo.db.prepare("SELECT * FROM scheduled WHERE regla_id = 'comercial-5h'").get();
  const p = await textoPrevisto(setter, s);
  assert.equal(p.texto, 'sigues interesada en parla?');
  assert.equal(p.plantilla, false);
  const n = sal.requests.length;
  for (const r of ['info-tras-reserva', 'ultimo-intento-24h', 'cierre-4-dias']) repo.db.prepare("UPDATE scheduled SET estado = 'omitido' WHERE regla_id = ?").run(r);
  avanzar(300 * 60000);
  await procesarSeguimientos(setter);
  assert.equal(sal.requests.length, n); // no se vuelve a llamar al modelo
  assert.deepEqual(sal.enviados, ['te paso horarios', 'sigues interesada en parla?']);
  // Al redactar no puede usar herramientas con efectos
  assert.match(sal.requests.at(-1).system.at(-1).text, /Follow-up comercial 5h/);
  assert.match(sal.requests.at(-1).system.at(-1).text, /se enviará el martes, 17 de noviembre de 2026/); // preparado antes de tiempo
});

test('largo plazo: «me apunto en enero» cancela los cortos y programa dos intentos; el lead escribiendo no los borra', async () => {
  const { repo, setter, sal, avanzar } = montar({ respuestas: [
    { mensajes: ['genial, sin problema'], retomar: { fecha: '2027-01-11', motivo: 'se apunta en enero, ahora está de viaje' } },
    { mensajes: ['de nada!'] },
  ] });
  await setter.handleWebhook(entrante('me apuntaré en enero', 'w1'));
  avanzar(60000); const r = await setter.responder('c1');
  assert.deepEqual(r.turno.retomar.fecha, '2027-01-11');
  let p = pendientes(repo);
  assert.deepEqual(p.map((x) => x.regla_id), ['largo-plazo', 'largo-plazo-2']);
  assert.equal(p[0].due_at, '2027-01-11T10:00:00.000Z');
  assert.equal(p[1].due_at, '2027-02-10T10:00:00.000Z');
  assert.match(p[0].contexto, /enero/);
  assert.match(repo.getConv('c1').retomar, /2027-01-11/);
  // Escribe «gracias»: no se borran los de largo plazo
  await setter.handleWebhook(entrante('gracias', 'w2'));
  avanzar(60000); await setter.tick();
  p = pendientes(repo);
  assert.ok(p.some((x) => x.regla_id === 'largo-plazo'));
  // Sofía sabe que hay que retomarlo
  assert.match(sal.requests.at(-1).system.at(-1).text, /retomarlo el 2027-01-11/);
});

test('largo plazo: sin fecha o con fecha absurda, a los 21 días; sale por plantilla con el motivo en la tarea', async () => {
  const { repo, setter, sal, avanzar, ahora } = montar({ respuestas: [
    { mensajes: ['vale, sin prisa'], retomar: { fecha: '1999-01-01', motivo: 'lo tiene que pensar' } },
    { mensajes: ['hola! pudiste pensarlo?', 'segunda burbuja'] },
  ] });
  await setter.handleWebhook(entrante('lo pienso y ya te digo', 'w1'));
  avanzar(60000); await setter.responder('c1');
  const p = pendientes(repo)[0];
  assert.equal(p.due_at.slice(0, 10), new Date(ahora().getTime() + 21 * 864e5).toISOString().slice(0, 10));
  avanzar(22 * 864e5);
  repo.db.prepare("UPDATE scheduled SET due_at = ? WHERE regla_id = 'largo-plazo'").run(new Date(ahora().getTime() - 1000).toISOString());
  await procesarSeguimientos(setter);
  assert.deepEqual(sal.plantillas, ['hola! pudiste pensarlo?']);
  assert.match(sal.requests.at(-1).system.at(-1).text, /lo tiene que pensar[\s\S]*plantilla aprobada/);
});

test('largo plazo en Instagram: no se puede programar (Instagram no deja escribir tanto después)', async () => {
  const { repo, setter, avanzar } = montar({ respuestas: [{ mensajes: ['ok'], retomar: { fecha: '2027-01-11', motivo: 'enero' } }] });
  await setter.handleWebhook({ ...entrante('en enero', 'w1'), canal: 'instagram' });
  avanzar(60000); const r = await setter.responder('c1');
  assert.equal(r.turno.retomar.programado, false);
  assert.equal(pendientes(repo).length, 0);
});

test('plantilla vía workflow de GHL: guarda el texto en el campo y quita y pone la etiqueta', async () => {
  const llamadas = [];
  const fetchImpl = async (url, { method, body }) => {
    llamadas.push([method, url.replace(/^https:\/\/[^/]+/, ''), body ? JSON.parse(body) : null]);
    const r = method === 'GET' ? { customFields: [{ id: 'cf1', name: config.ghl.campoPlantilla }] } : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(r) };
  };
  const g = new Ghl({ token: 't', baseUrl: 'https://x', fetchImpl });
  await g.enviarPorPlantilla({ contactId: 'k1', texto: 'hola de nuevo' });
  await g.enviarPorPlantilla({ contactId: 'k2', texto: 'otra' });
  assert.deepEqual(llamadas.filter((l) => l[0] === 'GET').length, 1); // el id del campo se recuerda
  assert.deepEqual(llamadas[1], ['PUT', '/contacts/k1', { customFields: [{ id: 'cf1', field_value: 'hola de nuevo' }] }]);
  assert.deepEqual(llamadas[2], ['DELETE', '/contacts/k1/tags', { tags: ['sofia-enviar-plantilla'] }]);
  assert.deepEqual(llamadas[3], ['POST', '/contacts/k1/tags', { tags: ['sofia-enviar-plantilla'] }]);
});

test('Probar IA: el texto que se ve es el que sale al forzar', async () => {
  config.adminToken = 'clave-test';
  const repo = crearRepo(openDb(':memory:'));
  repo.guardarAjuste('intensidadSeguimientos', 'intensa'); // mecánica con todos los seguimientos (los niveles, en intensidad.test.js)
  const pruebas = crearRepo(openDb(':memory:'));
  const cola = [{ mensajes: ['claro, te cuento'] }, { mensajes: ['oye, al final te encajan los martes?'] }];
  let llamadas = 0;
  const complete = async () => { llamadas++; const r = cola.shift(); return { content: [{ type: 'tool_use', id: 't', name: 'responder', input: { fase: 'f2 diagnóstico', ...r } }] }; };
  const srv = crearApp({ setter: {}, repo, pruebas, complete }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}/admin/probar`;
  const h = { authorization: 'Bearer clave-test', 'content-type': 'application/json' };
  const post = async (r, b) => (await fetch(url + r, { method: 'POST', headers: h, body: JSON.stringify(b || {}) })).json();
  try {
    const c = (await post('/conversaciones', { canal: 'whatsapp' })).conv;
    await post(`/conversaciones/${c.id}/mensaje`, { texto: 'horarios?' });
    const p1 = await post(`/conversaciones/${c.id}/seguimiento/comercial-5h/previa`);
    const p2 = await post(`/conversaciones/${c.id}/seguimiento/comercial-5h/previa`);
    assert.equal(p1.texto, 'oye, al final te encajan los martes?');
    assert.equal(p2.texto, p1.texto);
    assert.equal(llamadas, 2); // la segunda vez no llama al modelo
    const d = await post(`/conversaciones/${c.id}/seguimiento`, { regla: 'comercial-5h' });
    assert.ok(d.mensajes.some((m) => m.autor === 'ia' && m.texto === p1.texto));
    assert.equal(llamadas, 2);
    // La regla de 4 días sale por plantilla
    const p4 = await post(`/conversaciones/${c.id}/seguimiento/cierre-4-dias/previa`).catch(() => null);
    assert.equal(p4.plantilla, true);
  } finally { srv.close(); }
});
