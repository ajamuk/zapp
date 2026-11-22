import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import { parseWebhook, Ghl } from '../src/ghl.js';

// Un martes a las 12:00 en Madrid (dentro de horario)
const T0 = new Date('2026-11-17T11:00:00Z');
const hace = (s) => new Date(T0.getTime() - s * 1000).toISOString();
// Los mensajes se guardan con la hora real: lo que se compara con ellos por fecha usa también la hora real
const real = (s = 0) => new Date(Date.now() - s * 1000).toISOString();
const msg = (id, direccion, tipo, texto, fecha, extra = {}) => ({
  id, direccion, tipo, canal: { TYPE_WHATSAPP: 'whatsapp', TYPE_INSTAGRAM: 'instagram' }[tipo] || tipo.toLowerCase(), texto, adjuntos: [], userId: null, source: null, fecha, ...extra,
});
const copia = (id, direccion, texto, fecha) => msg(id, direccion, 'TYPE_CUSTOM_SMS', `${texto}\n\n💬Received on 34600000000`, fecha, { source: 'api' });
// Lo que manda el workflow de GHL: sin id de mensaje, sin id de conversación y con el canal como número
const webhook = (texto) => parseWebhook({ contact_id: 'k1', full_name: 'Ana López', phone: '+34611111111', tags: '', message: { type: 19, body: texto }, workflow: { id: 'w' } });

function montar({ live = true, respuestas = [] } = {}) {
  const repo = crearRepo(openDb(':memory:'));
  const en = { lista: [], enviados: [], notas: [], avisos: [], pedidos: 0 };
  let n = 0;
  const ghl = {
    buscarConversacion: async () => ({ id: 'cv1', canal: 'type_custom_sms' }), // lo último del chat es la copia del conector
    mensajes: async () => { en.pedidos++; return [...en.lista]; },
    sendMessage: async ({ texto }) => { const id = `s${++n}`; en.enviados.push(texto); en.lista.push(msg(id, 'outbound', 'TYPE_WHATSAPP', texto, new Date(reloj).toISOString(), { userId: 'u-api', source: 'app' })); return { messageId: id }; },
    addTags: async () => {}, removeTags: async () => {}, assign: async () => {}, addNote: async (_, t) => { en.notas.push(t); return { id: 'n1' }; }, updateNote: async () => {},
    getContact: async () => ({ contact: { phone: '+34611111111' } }),
  };
  let reloj = new Date(T0);
  const cola = [...respuestas];
  const complete = async () => {
    const r = cola.shift();
    if (!r) throw new Error('sin respuesta preparada');
    return { content: [{ type: 'tool_use', id: 't', name: 'responder', input: { mensajes: r, fase: 'f1 apertura', etiquetas: [] } }], usage: { input_tokens: 1, output_tokens: 1 } };
  };
  const setter = new Setter({
    repo, ghl, complete, live, sleep: async () => {}, now: () => reloj, random: () => 0, avisar: async (t) => en.avisos.push(t),
    aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: false }), prepararAlta: async () => ({}) },
  });
  const leads = () => repo.history('cv1').filter((m) => m.autor === 'lead').map((m) => m.texto);
  return { repo, setter, en, leads, avanzar: (ms) => { reloj = new Date(reloj.getTime() + ms); } };
}

test('Ghl.mensajes normaliza y ordena del más antiguo al más nuevo', async () => {
  const g = new Ghl({ token: 't', baseUrl: 'https://x', fetchImpl: async () => new Response(JSON.stringify({ messages: { messages: [
    { id: 'b', direction: 'outbound', messageType: 'TYPE_CUSTOM_SMS', body: 'hola', dateAdded: '2026-11-17T10:59:30.000Z', source: 'api', userId: 'u' },
    { id: 'a', direction: 'inbound', messageType: 'TYPE_WHATSAPP', body: 'Hola', dateAdded: '2026-11-17T10:59:00.000Z', attachments: ['https://x/a.ogg'] },
  ] } })) });
  const l = await g.mensajes('cv1');
  assert.deepEqual(l.map((m) => [m.id, m.direccion, m.canal]), [['a', 'inbound', 'whatsapp'], ['b', 'outbound', 'type_custom_sms']]);
  assert.deepEqual(l[0].adjuntos, ['https://x/a.ogg']);
});

test('el mensaje entra aunque lo último del chat en GHL sea la copia del conector', async () => {
  const { setter, repo, en, leads } = montar();
  en.lista = [msg('g1', 'inbound', 'TYPE_WHATSAPP', 'Hola', hace(20)), copia('g2', 'inbound', 'Hola', hace(19))];
  const r = await setter.handleWebhook(webhook('Hola'));
  assert.equal(r.visto, true);
  assert.deepEqual(leads(), ['Hola']);
  const c = repo.getConv('cv1');
  assert.equal(c.channel, 'whatsapp');
  assert.ok(c.respond_at, 'queda programada la respuesta');
  assert.equal(repo.history('cv1')[0].external_id, 'g1');
});

test('ráfaga: entran los mensajes que el workflow de GHL no avisó, y un webhook repetido no duplica', async () => {
  const { setter, en, leads } = montar();
  en.lista = [msg('g1', 'inbound', 'TYPE_WHATSAPP', 'hola', hace(30)), copia('c1', 'inbound', 'hola', hace(30)), msg('g2', 'inbound', 'TYPE_WHATSAPP', 'quería info de precios', hace(20))];
  await setter.handleWebhook(webhook('hola'));
  assert.deepEqual(leads(), ['hola', 'quería info de precios']);
  await setter.handleWebhook(webhook('quería info de precios'));
  await setter.handleWebhook(webhook('hola'));
  assert.deepEqual(leads(), ['hola', 'quería info de precios']);
});

test('si GHL aún no lista el mensaje, entra tal cual y luego no se repite', async () => {
  const { setter, repo, en, leads } = montar();
  await setter.handleWebhook(webhook('buenas'));
  assert.deepEqual(leads(), ['buenas']);
  assert.equal(repo.getConv('cv1').channel, 'whatsapp');
  en.lista = [msg('g1', 'inbound', 'TYPE_WHATSAPP', 'buenas', real(5)), msg('g2', 'inbound', 'TYPE_WHATSAPP', 'estás?', real(1))];
  await setter.handleWebhook(webhook('estás?'));
  assert.deepEqual(leads(), ['buenas', 'estás?']);
  assert.deepEqual(repo.history('cv1').map((m) => m.external_id), ['g1', 'g2']);
});

test('antes de contestar se recogen los mensajes sin avisar, y la respuesta sale una sola vez', async () => {
  const { setter, en, leads, avanzar } = montar({ respuestas: [['hola! qué sede te pilla mejor?']] });
  en.lista = [msg('g1', 'inbound', 'TYPE_WHATSAPP', 'hola', hace(5))];
  await setter.handleWebhook(webhook('hola'));
  en.lista.push(msg('g2', 'inbound', 'TYPE_WHATSAPP', 'cuánto cuesta?', hace(1)));
  avanzar(60000);
  await setter.tick();
  assert.deepEqual(leads(), ['hola', 'cuánto cuesta?']);
  assert.deepEqual(en.enviados, ['hola! qué sede te pilla mejor?']);
  // Los mensajes de Sofía (y su copia del conector) no se toman por alguien del equipo
  en.lista.push(copia('c9', 'outbound', 'hola! qué sede te pilla mejor?', real(-1)));
  en.lista.push(msg('g3', 'inbound', 'TYPE_WHATSAPP', 'parla', real(-2)));
  avanzar(40000);
  await setter.handleWebhook(webhook('parla'));
  assert.deepEqual(leads(), ['hola', 'cuánto cuesta?', 'parla']);
  assert.equal(setter.repo.getConv('cv1').ai_paused, 0);
  assert.equal(setter.repo.history('cv1').filter((m) => m.autor === 'humano').length, 0);
});

test('si alguien del equipo ya ha contestado en GHL, Sofía se aparta y no escribe', async () => {
  const { setter, repo, en, avanzar } = montar({ respuestas: [['hola!']] });
  en.lista = [msg('g1', 'inbound', 'TYPE_WHATSAPP', 'hola', hace(5))];
  await setter.handleWebhook(webhook('hola'));
  en.lista.push(msg('h1', 'outbound', 'TYPE_WHATSAPP', 'Hola Ana, soy Carlos, te llamo ahora', new Date(T0.getTime() + 5000).toISOString(), { userId: 'u7', source: 'app' }));
  en.lista.push(msg('w1', 'outbound', 'TYPE_WHATSAPP', 'Recordatorio automático', new Date(T0.getTime() + 6000).toISOString(), { source: 'workflow' }));
  en.lista.push(msg('e1', 'outbound', 'TYPE_EMAIL', 'Bienvenida', new Date(T0.getTime() + 7000).toISOString(), { source: 'app', userId: 'u7' }));
  avanzar(60000);
  await setter.tick();
  assert.equal(en.enviados.length, 0);
  const c = repo.getConv('cv1');
  assert.equal(c.ai_paused, 1);
  assert.deepEqual(repo.history('cv1').filter((m) => m.autor === 'humano').map((m) => m.texto), ['Hola Ana, soy Carlos, te llamo ahora']);
});

test('en modo prueba, lo que contesta el equipo queda como contexto y Sofía sigue dejando su borrador', async () => {
  const { setter, repo, en, avanzar } = montar({ live: false, respuestas: [['genial, te cuento']] });
  en.lista = [msg('g1', 'inbound', 'TYPE_WHATSAPP', 'hola', hace(5))];
  await setter.handleWebhook(webhook('hola'));
  en.lista.push(msg('h1', 'outbound', 'TYPE_WHATSAPP', 'Hola Ana, dime', new Date(T0.getTime() + 5000).toISOString(), { userId: 'u7', source: 'app' }));
  avanzar(60000);
  await setter.tick();
  assert.equal(repo.getConv('cv1').ai_paused, 0);
  assert.equal(repo.history('cv1').filter((m) => m.autor === 'humano').length, 1);
  assert.ok(en.notas.some((n) => n.startsWith('[Borrador IA')));
  assert.equal(en.enviados.length, 0);
});

test('lo que escribió el equipo hace rato entra una sola vez, aunque el conector lo repita (en cualquier orden)', async () => {
  const { setter, repo, en, avanzar } = montar({ live: false });
  en.lista = [msg('g1', 'inbound', 'TYPE_WHATSAPP', 'hola', hace(5)), copia('c1', 'inbound', 'hola', hace(4))];
  await setter.handleWebhook(webhook('hola'));
  const mas = (s) => new Date(T0.getTime() + s * 1000).toISOString();
  // Desde GHL: mensaje nativo y, después, su copia. Desde el móvil: primero la copia y luego el eco nativo.
  en.lista.push(msg('h1', 'outbound', 'TYPE_WHATSAPP', 'Hola Ana, te cuento', mas(60), { userId: 'u7', source: 'app' }));
  en.lista.push(msg('h2', 'outbound', 'TYPE_CUSTOM_SMS', 'Hola Ana, te cuento \n \n💬Sent from 34600000000', mas(65), { userId: 'u7', source: 'api' }));
  en.lista.push(msg('h3', 'outbound', 'TYPE_CUSTOM_SMS', 'son 85 € al mes', mas(120), { userId: 'u7', source: 'api' }));
  en.lista.push(msg('h4', 'outbound', 'TYPE_WHATSAPP', 'son 85 € al mes', mas(123), { source: 'app' }));
  en.lista.push(msg('g2', 'inbound', 'TYPE_WHATSAPP', 'vale, gracias', mas(1795)), copia('c2', 'inbound', 'vale, gracias', mas(1796)));
  avanzar(30 * 60000);
  await setter.handleWebhook(webhook('vale, gracias'));
  assert.deepEqual(repo.history('cv1').map((m) => `${m.autor}: ${m.texto}`), ['lead: hola', 'humano: Hola Ana, te cuento', 'humano: son 85 € al mes', 'lead: vale, gracias']);
});

test('si GHL no confirma a tiempo un envío que sí salió, se da por enviado y el chat no se pausa', async () => {
  const { setter, repo, en, avanzar } = montar({ respuestas: [['hola!', 'qué sede te pilla mejor?']] });
  en.lista = [msg('g1', 'inbound', 'TYPE_WHATSAPP', 'hola', hace(5))];
  await setter.handleWebhook(webhook('hola'));
  avanzar(60000);
  const enviar = setter.ghl.sendMessage; let n = 0;
  setter.ghl.sendMessage = async (x) => { const r = await enviar(x); if (++n === 2) throw new Error('GHL POST /conversations/messages → sin respuesta en 20 s'); return r; };
  await setter.tick();
  assert.deepEqual(repo.history('cv1').filter((m) => m.autor === 'ia').map((m) => [m.texto, m.external_id]), [['hola!', 's1'], ['qué sede te pilla mejor?', 's2']]);
  en.lista.push(msg('g2', 'inbound', 'TYPE_WHATSAPP', 'parla', new Date(T0.getTime() + 90000).toISOString()));
  avanzar(40000);
  await setter.handleWebhook(webhook('parla'));
  assert.equal(repo.getConv('cv1').ai_paused, 0);
  assert.equal(repo.history('cv1').filter((m) => m.autor === 'humano').length, 0);
});
