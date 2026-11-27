// Contacto recién creado: el aviso del workflow de GHL llega antes de que GHL devuelva su conversación.
// Los reintentos van en la cola de avisos (tabla ghl_avisos), no en temporizadores: sobreviven a un reinicio.
// Datos sintéticos: ningún teléfono ni id es real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import { crearAvisos } from '../src/avisos-ghl.js';
import { recuperar } from '../src/arranque.js';

const T0 = new Date('2026-11-17T11:00:00Z'); // martes 12:00 en Madrid
const silencio = { log() {}, warn() {}, error() {} };

function montar({ buscar, repo = crearRepo(openDb(':memory:')) }) {
  const sal = { enviados: [], busquedas: 0 };
  const ghl = {
    sendMessage: async ({ texto }) => { sal.enviados.push(texto); return { messageId: `s${sal.enviados.length}` }; },
    addTags: async () => {}, removeTags: async () => {}, assign: async () => {}, addNote: async () => {},
    getContact: async () => ({ contact: {} }),
    buscarConversacion: async (c) => { sal.busquedas++; return buscar(c); },
  };
  const setter = new Setter({
    repo, ghl, live: false, sleep: async () => {}, now: () => T0, random: () => 0, avisar: async () => {},
    aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: false }) },
    complete: async () => ({ content: [{ type: 'tool_use', id: 't', name: 'responder', input: { fase: 'f1 apertura', sede: 'parla', mensajes: ['hola'] } }], usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  // Reloj de los reintentos, controlado por la prueba
  let ms = T0.getTime();
  const avisos = crearAvisos({ repo, setter, reloj: () => ms, esperas: { conversacion: [5000, 5000, 5000] }, log: silencio });
  return {
    repo, setter, sal, avisos,
    recibir: (evt) => avisos.procesar(avisos.guardar(evt)), // lo que hace POST /webhooks/ghl
    vuelta: async (avanzar = 5000) => { ms += avanzar; await avisos.pendientes().terminado; }, // el bucle de index.js
  };
}
const aviso = (extra = {}) => ({ evento: 'inbound', contactId: 'k1', canal: 'whatsapp', texto: 'hola, precio?', messageId: 'm1', telefono: '+34600000000', nombre: 'Lead Sintético', tags: [], ...extra });
const chats = (repo) => repo.db.prepare('SELECT count(*) n FROM conversations').get().n;
const estados = (repo) => repo.db.prepare('SELECT estado FROM ghl_avisos ORDER BY id').all().map((f) => f.estado);

test('GHL aún no devuelve la conversación del contacto nuevo: el aviso queda en la cola y entra al aparecer', async () => {
  let lista = false;
  const { repo, recibir, vuelta } = montar({ buscar: () => (lista ? { id: 'c1' } : null) });
  const r = await recibir(aviso());
  assert.equal(r.ignorado, 'faltan ids');
  assert.equal(r.reintento, 'conversacion');
  assert.equal(chats(repo), 0);
  assert.deepEqual(estados(repo), ['pendiente'], 'guardado con su reintento, no en un temporizador');
  lista = true;
  await vuelta();
  assert.equal(repo.getConv('c1')?.contact_id, 'k1', 'el chat entra en el panel');
  assert.deepEqual(estados(repo), ['hecho']);
});

test('dos avisos del mismo contacto sin conversación: una sola búsqueda por vuelta y entran los dos', async () => {
  let lista = false;
  const { repo, sal, recibir, vuelta } = montar({ buscar: () => (lista ? { id: 'c1' } : null) });
  await recibir(aviso());
  const r2 = await recibir(aviso({ messageId: 'm2', texto: 'y horarios?' }));
  assert.equal(r2.reintento, 'conversacion');
  const antes = sal.busquedas;
  await vuelta();
  assert.equal(sal.busquedas - antes, 1, 'los dos avisos comparten el reintento');
  lista = true;
  await vuelta();
  assert.deepEqual(repo.db.prepare("SELECT external_id FROM messages WHERE autor = 'lead' ORDER BY id").all().map((m) => m.external_id), ['m1', 'm2']);
  assert.deepEqual(estados(repo), ['hecho', 'hecho']);
});

test('si GHL nunca devuelve la conversación, se deja de preguntar', async () => {
  const { repo, sal, recibir, vuelta } = montar({ buscar: () => null });
  await recibir(aviso());
  for (let i = 0; i < 5; i++) await vuelta();
  assert.equal(sal.busquedas, 1 + 3, 'la búsqueda inicial y tres reintentos');
  assert.equal(chats(repo), 0);
  assert.deepEqual(estados(repo), ['descartado']);
});

test('los salientes sin conversación no se repasan', async () => {
  const { repo, recibir } = montar({ buscar: () => null });
  const r = await recibir(aviso({ evento: 'outbound' }));
  assert.equal(r.reintento, false);
  assert.deepEqual(estados(repo), ['hecho']);
});

test('reinicio con un reintento pendiente: el servicio nuevo lo retoma desde la base', async () => {
  let lista = false;
  const repo = crearRepo(openDb(':memory:'));
  const antes = montar({ repo, buscar: () => null });
  await antes.recibir(aviso());
  assert.deepEqual(estados(repo), ['pendiente']);
  // Se reinicia: la memoria del servicio anterior (temporizadores, colas) desaparece; la base no
  assert.equal(recuperar(repo.db, T0).avisos, undefined, 'nada a medias: el aviso ya estaba en la cola');
  const despues = montar({ repo, buscar: () => (lista ? { id: 'c1' } : null) });
  lista = true;
  await despues.vuelta();
  assert.equal(repo.getConv('c1')?.contact_id, 'k1');
  assert.equal(repo.db.prepare("SELECT count(*) n FROM messages WHERE autor = 'lead'").get().n, 1);
});

test('reinicio con el aviso a medio procesar (ya contestado el 200): vuelve a la cola al arrancar y entra', async () => {
  const repo = crearRepo(openDb(':memory:'));
  const antes = montar({ repo, buscar: () => ({ id: 'c1' }) });
  const id = antes.avisos.guardar(aviso());
  repo.tomarAvisoGhl(id); // el servicio se para justo aquí: «procesando» y sin terminar
  assert.equal(chats(repo), 0);
  assert.equal(recuperar(repo.db, T0).avisos, 1);
  const despues = montar({ repo, buscar: () => ({ id: 'c1' }) });
  await despues.vuelta(0);
  assert.equal(repo.getConv('c1')?.contact_id, 'k1', 'el mensaje del lead no se pierde');
  assert.deepEqual(estados(repo), ['hecho']);
  // Procesarlo otra vez (por ejemplo, si GHL lo repite) no lo duplica
  await despues.recibir(aviso());
  assert.equal(repo.db.prepare("SELECT count(*) n FROM messages WHERE autor = 'lead'").get().n, 1);
});

test('un aviso que lleva más de 24 h pendiente se descarta sin procesarlo', async () => {
  const { repo, sal, recibir, vuelta } = montar({ buscar: () => null });
  await recibir(aviso());
  const n = sal.busquedas;
  repo.db.prepare('UPDATE ghl_avisos SET creado_ms = creado_ms - ?').run(25 * 3600e3);
  await vuelta();
  assert.equal(sal.busquedas, n);
  assert.deepEqual(estados(repo), ['descartado']);
});
