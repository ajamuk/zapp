// Paginación de la API de GHL: mensajes de una conversación y búsqueda de conversaciones.
// El GHL de mentira responde como la API v2 documentada (GoHighLevel/highlevel-api-docs, apps/conversations.json):
//  - GET /conversations/:id/messages → { messages: { lastMessageId, nextPage, messages } }, del más nuevo al más antiguo;
//    la página siguiente se pide con ?lastMessageId=<último de la anterior>.
//  - GET /conversations/search → { conversations, total }; la página siguiente, con ?startAfterDate=<valor de orden
//    del último>, que con sortBy=last_message_date es su lastMessageDate (ms).
// Datos sintéticos: ningún teléfono ni id es real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import { Ghl } from '../src/ghl.js';
import { config } from '../src/config.js';
import { estadoAislamiento, APAGADO } from '../src/aislamiento.js';

const T0 = new Date('2026-11-17T11:00:00Z'); // martes 12:00 en Madrid
const hace = (min) => new Date(T0.getTime() - min * 60000).toISOString();
const PROPIO = '+34910000001'; const PROPIO_GHL = '+34 910 00 00 01'; const OTRO_GHL = '+34 910 00 00 02'; const LOC = 'locSofia';
const AISL = estadoAislamiento({ numero: PROPIO, locationId: LOC, locationCliente: LOC });

/** Mensaje tal como lo devuelve la API de GHL (sin normalizar). */
const crudo = (id, min, extra = {}) => ({
  id, direction: 'inbound', messageType: 'TYPE_WHATSAPP', body: `mensaje ${id}`, dateAdded: hace(min),
  locationId: LOC, conversationId: 'c1', contactId: 'k1', to: PROPIO_GHL, ...extra,
});
/** `n` mensajes del lead, uno por minuto: el más nuevo hace `desde` minutos. */
const serie = (n, { desde = 1, prefijo = 'm', ...extra } = {}) => Array.from({ length: n }, (_, i) => crudo(`${prefijo}${i + 1}`, desde + n - 1 - i, extra));

function ghlFalso({ mensajes = {}, conversaciones = [], falla = () => false } = {}) {
  const peticiones = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    peticiones.push(u.pathname + u.search);
    const limite = Number(u.searchParams.get('limit')) || 20;
    const m = u.pathname.match(/^\/conversations\/([^/]+)\/messages$/);
    let cuerpo = {}; let status = 200;
    if (falla(u)) { status = 404; cuerpo = { message: 'Not found' }; }
    else if (u.pathname === '/conversations/search') {
      const despues = Number(u.searchParams.get('startAfterDate')) || Infinity;
      const todas = [...conversaciones].sort((a, b) => b.lastMessageDate - a.lastMessageDate).filter((c) => c.lastMessageDate < despues);
      cuerpo = { conversations: todas.slice(0, limite), total: todas.length };
    } else if (m) {
      const todos = [...(mensajes[m[1]] || [])].sort((a, b) => b.dateAdded.localeCompare(a.dateAdded));
      const ultimo = u.searchParams.get('lastMessageId');
      const i = ultimo ? todos.findIndex((x) => x.id === ultimo) + 1 : 0;
      const pagina = todos.slice(i, i + limite);
      cuerpo = { messages: { lastMessageId: pagina.at(-1)?.id ?? null, nextPage: i + limite < todos.length, messages: pagina } };
    }
    return { ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(cuerpo) };
  };
  return { ghl: new Ghl({ token: 't', baseUrl: 'https://ghl.test', fetchImpl, aislamiento: APAGADO }), peticiones };
}
const lecturasDe = (peticiones, conv = 'c1') => peticiones.filter((p) => p.startsWith(`/conversations/${conv}/messages`));

test('mensajes sin `desde`: una sola página, la misma petición de siempre', async () => {
  const { ghl, peticiones } = ghlFalso({ mensajes: { c1: serie(75) } });
  const lista = await ghl.mensajes('c1');
  assert.deepEqual(peticiones, ['/conversations/c1/messages?limit=30']);
  assert.equal(lista.length, 30);
  assert.equal(lista.at(-1).id, 'm75', 'del más antiguo al más nuevo');
  assert.equal(lista.incompleta, undefined);
  // Con un número, es el tamaño de la página (confirmarEnvio)
  assert.equal((await ghl.mensajes('c1', 15)).length, 15);
});

test('mensajes con `desde`: se piden páginas con lastMessageId hasta pasar de esa fecha', async () => {
  const { ghl, peticiones } = ghlFalso({ mensajes: { c1: serie(75) } });
  // m75 es de hace 1 minuto y m1 de hace 75: hasta hace 50 minutos hacen falta dos páginas
  const lista = await ghl.mensajes('c1', { desde: hace(50) });
  assert.deepEqual(peticiones, ['/conversations/c1/messages?limit=30', '/conversations/c1/messages?limit=30&lastMessageId=m46']);
  assert.equal(lista.length, 60);
  assert.ok(lista.some((m) => m.id === 'm26'), 'el de hace 50 minutos está');
  assert.deepEqual(lista.map((m) => m.fecha), [...lista.map((m) => m.fecha)].sort());
});

test('mensajes con `desde: null`: todo el historial; con tope, la lista avisa de que está incompleta', async () => {
  const a = ghlFalso({ mensajes: { c1: serie(75) } });
  const todo = await a.ghl.mensajes('c1', { desde: null });
  assert.equal(todo.length, 75);
  assert.equal(lecturasDe(a.peticiones).length, 3);
  assert.equal(todo.incompleta, undefined);
  const b = ghlFalso({ mensajes: { c1: serie(75) } });
  const corta = await b.ghl.mensajes('c1', { desde: null, maxPaginas: 2 });
  assert.equal(corta.length, 60);
  assert.equal(corta.incompleta, 'tope');
});

test('mensajes: si falla una página que no es la primera, se devuelve lo leído marcado como incompleto', async () => {
  const { ghl } = ghlFalso({ mensajes: { c1: serie(75) }, falla: (u) => u.searchParams.has('lastMessageId') });
  const lista = await ghl.mensajes('c1', { desde: hace(70) });
  assert.equal(lista.length, 30);
  assert.equal(lista.incompleta, 'error');
  // La primera página sí falla como siempre (GHL caído)
  const caido = ghlFalso({ mensajes: { c1: serie(5) }, falla: () => true });
  await assert.rejects(caido.ghl.mensajes('c1', { desde: hace(70) }), /404/);
});

test('conversaciones recientes: páginas con startAfterDate hasta salir de la ventana', async () => {
  // 70 conversaciones con actividad, una cada 20 segundos: la más antigua, hace 23 minutos
  const conversaciones = Array.from({ length: 70 }, (_, i) => ({ id: `c${i + 1}`, contactId: `k${i + 1}`, lastMessageDate: T0.getTime() - i * 20000 }));
  const a = ghlFalso({ conversaciones });
  const una = await a.ghl.conversacionesRecientes(30);
  assert.equal(una.length, 30, 'sin ventana, una página (como antes)');
  assert.deepEqual(a.peticiones, [`/conversations/search?${new URLSearchParams({ locationId: config.ghl.locationId, sortBy: 'last_message_date', sort: 'desc', limit: '30' })}`]);
  const b = ghlFalso({ conversaciones });
  const todas = await b.ghl.conversacionesRecientes({ limit: 30, desdeMs: T0.getTime() - 30 * 60000 });
  assert.equal(todas.length, 70);
  assert.equal(b.peticiones.length, 3);
  assert.equal(new URLSearchParams(b.peticiones[1].split('?')[1]).get('startAfterDate'), String(conversaciones[29].lastMessageDate));
  assert.ok(!new URLSearchParams(b.peticiones[0].split('?')[1]).has('startAfterDate'));
  // Con la ventana más corta, para en cuanto la última de la página es más antigua
  const c = ghlFalso({ conversaciones });
  await c.ghl.conversacionesRecientes({ limit: 30, desdeMs: T0.getTime() - 5 * 60000 });
  assert.equal(c.peticiones.length, 1);
});

function setterCon(ghl, { aislamiento = APAGADO, repo = crearRepo(openDb(':memory:')) } = {}) {
  const setter = new Setter({
    repo, ghl, live: false, aislamiento, sleep: async () => {}, now: () => T0, random: () => 0, avisar: async () => {},
    aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: false }) },
    complete: async () => ({ content: [{ type: 'tool_use', id: 't', name: 'responder', input: { fase: 'f2 diagnóstico', sede: 'parla', mensajes: ['hola'] } }], usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  return { repo, setter };
}
const delLead = (repo) => repo.db.prepare("SELECT external_id FROM messages WHERE autor = 'lead' ORDER BY created_at, id").all().map((m) => m.external_id);

test('más de 30 mensajes del lead entre dos repasos: entran todos (antes se perdían los más antiguos)', async () => {
  const { ghl } = ghlFalso({ mensajes: { c1: serie(45, { desde: 1 }) } });
  const { repo, setter } = setterCon(ghl);
  repo.upsertConv({ id: 'c1', contact_id: 'k1', channel: 'whatsapp' });
  repo.updateConv('c1', { ghl_sync_at: hace(60) }); // último repaso, hace una hora
  const r = await setter.sincronizar('c1');
  assert.equal(r.entrantes, 45);
  assert.equal(delLead(repo).length, 45);
  assert.equal(repo.getConv('c1').ghl_sync_at, hace(1), 'el cursor queda en el último');
});

test('si falla una página intermedia, el cursor no avanza y el siguiente repaso recupera lo que faltó', async () => {
  let caida = true;
  const { ghl } = ghlFalso({ mensajes: { c1: serie(45, { desde: 1 }) }, falla: (u) => caida && u.searchParams.has('lastMessageId') });
  const { repo, setter } = setterCon(ghl);
  repo.upsertConv({ id: 'c1', contact_id: 'k1', channel: 'whatsapp' });
  repo.updateConv('c1', { ghl_sync_at: hace(60) });
  await setter.sincronizar('c1');
  assert.equal(delLead(repo).length, 30);
  assert.equal(repo.getConv('c1').ghl_sync_at, hace(60));
  caida = false;
  await setter.sincronizar('c1');
  assert.equal(delLead(repo).length, 45);
});

test('aislamiento: un WhatsApp de otra línea más allá de la primera página marca la conversación como compartida', async () => {
  // 40 mensajes al número propio y, más atrás, uno a otra línea de la empresa
  const mensajes = { c1: [...serie(40, { desde: 1 }), crudo('viejo', 300, { to: OTRO_GHL })] };
  const { ghl } = ghlFalso({ mensajes });
  const { repo, setter } = setterCon(ghl, { aislamiento: AISL });
  const r = await setter.handleWebhook({ evento: 'inbound', contactId: 'k1', conversationId: 'c1', canal: 'desconocido', texto: 'mensaje m40', messageId: null, telefono: '+34600000000' });
  assert.equal(r.compartida, true);
  assert.equal(repo.getConv('c1'), undefined, 'no se abre el chat');
});

test('aislamiento: sin poder leer todo el historial de un chat nuevo, no se atiende todavía', async () => {
  // Más mensajes de los que caben en el tope de páginas (20 de 30)
  const { ghl } = ghlFalso({ mensajes: { c1: serie(650, { desde: 1 }) } });
  const { repo, setter } = setterCon(ghl, { aislamiento: AISL });
  const r = await setter.handleWebhook({ evento: 'inbound', contactId: 'k1', conversationId: 'c1', canal: 'desconocido', texto: 'mensaje m650', messageId: null, telefono: '+34600000000' });
  assert.equal(r.reintento, 'aislamiento');
  assert.equal(repo.getConv('c1'), undefined);
});

test('barrido: un lead nuevo fuera de las 30 conversaciones más recientes se recupera', async () => {
  // 40 conversaciones con actividad en la última media hora; solo la 35.ª es nueva para Sofía
  const conversaciones = Array.from({ length: 40 }, (_, i) => ({ id: `c${i + 1}`, contactId: `k${i + 1}`, lastMessageDate: T0.getTime() - (2 + i * 0.5) * 60000 }));
  const nueva = conversaciones[34];
  const mensajes = { [nueva.id]: [crudo('n1', (T0.getTime() - nueva.lastMessageDate) / 60000, { conversationId: nueva.id, contactId: nueva.contactId })] };
  const { ghl, peticiones } = ghlFalso({ conversaciones, mensajes });
  const { repo, setter } = setterCon(ghl);
  for (const c of conversaciones) if (c !== nueva) repo.upsertConv({ id: c.id, contact_id: c.contactId, channel: 'whatsapp' });
  const r = await setter.barrerConversacionesNuevas();
  assert.equal(r.recuperadas, 1);
  assert.equal(repo.getConv(nueva.id)?.contact_id, nueva.contactId);
  assert.equal(peticiones.filter((p) => p.startsWith('/conversations/search')).length, 2);
});

test('aislamiento: en cuanto aparece otra línea se deja de leer el historial', async () => {
  // Conversación de otra línea de la empresa con mucho historial: el aviso de su último mensaje cuesta una página
  const { ghl, peticiones } = ghlFalso({ mensajes: { c1: serie(100, { desde: 1, to: OTRO_GHL }) } });
  const { repo, setter } = setterCon(ghl, { aislamiento: AISL });
  const r = await setter.handleWebhook({ evento: 'inbound', contactId: 'k1', conversationId: 'c1', canal: 'desconocido', texto: 'mensaje m100', messageId: null });
  assert.equal(r.compartida, true);
  assert.equal(lecturasDe(peticiones).length, 1);
  assert.equal(repo.getConv('c1'), undefined);
});

test('aislamiento: una conversación sin chat ya revisada entera solo se vuelve a leer desde entonces', async () => {
  // Instagram sin cuenta configurada: no se atiende ni es de otra línea; cada aviso suyo volvería a leerlo todo
  const mensajes = { c1: serie(100, { desde: 2, messageType: 'TYPE_INSTAGRAM', to: undefined }) };
  const { ghl, peticiones } = ghlFalso({ mensajes });
  const { repo, setter } = setterCon(ghl, { aislamiento: AISL });
  const aviso = (texto) => ({ evento: 'inbound', contactId: 'k1', conversationId: 'c1', canal: 'desconocido', texto, messageId: null });
  await setter.handleWebhook(aviso('mensaje m100'));
  assert.equal(lecturasDe(peticiones).length, 4, 'la primera vez, el historial entero (100 mensajes, páginas de 30)');
  mensajes.c1.push(crudo('nuevo', 1, { messageType: 'TYPE_INSTAGRAM', to: undefined }));
  await setter.handleWebhook(aviso('mensaje nuevo'));
  assert.equal(lecturasDe(peticiones).length, 5, 'la segunda, una página');
  assert.equal(repo.getConv('c1'), undefined);
});
