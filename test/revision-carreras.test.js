import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import { parseWebhook } from '../src/ghl.js';
import { MENSAJE_FUERA_HORARIO } from '../src/fuera-horario.js';

// Carreras y casos límite del recorrido aviso de GHL → respuesta, encontrados en la revisión del 22/11.
// Cada test reproduce el fallo tal como se dio y comprueba que ya no pasa.

const T0 = new Date('2026-11-17T11:00:00Z'); // martes 12:00 Madrid
const msg = (id, direccion, tipo, texto, fecha, extra = {}) => ({
  id, direccion, tipo, canal: { TYPE_WHATSAPP: 'whatsapp', TYPE_INSTAGRAM: 'instagram' }[tipo] || tipo.toLowerCase(), texto, adjuntos: [], userId: null, source: null, fecha, ...extra,
});
const copia = (id, direccion, texto, fecha) => msg(id, direccion, 'TYPE_CUSTOM_SMS', `${texto}\n\n💬${direccion === 'inbound' ? 'Received on' : 'Sent from'} 34600000000`, fecha, { source: 'api' });
const webhook = (texto) => parseWebhook({ contact_id: 'k1', full_name: 'Ana López', phone: '+34611111111', tags: '', message: { type: 19, body: texto }, workflow: { id: 'w' } });
const tick0 = () => new Promise((r) => setImmediate(r));

function montar({ live = true, respuestas = [], t0 = T0, realClock = false } = {}) {
  const repo = crearRepo(openDb(':memory:'));
  const en = { lista: [], enviados: [], notas: [], avisos: [], llamadasIA: 0, hooks: {} };
  let n = 0;
  let reloj = new Date(t0);
  const ahora = () => (realClock ? new Date() : reloj);
  const ghl = {
    buscarConversacion: async () => ({ id: 'cv1', canal: 'type_custom_sms' }),
    mensajes: async () => { if (en.hooks.mensajes) await en.hooks.mensajes(); return [...en.lista]; },
    sendMessage: async ({ texto }) => { const id = `s${++n}`; en.enviados.push(texto); en.lista.push(msg(id, 'outbound', 'TYPE_WHATSAPP', texto, ahora().toISOString(), { userId: 'u-api', source: 'app' })); if (en.hooks.send) await en.hooks.send(id, texto); return { messageId: id }; },
    enviarAdjunto: async ({ texto }) => { const id = `a${++n}`; en.enviados.push(`[adj] ${texto}`); en.lista.push(msg(id, 'outbound', 'TYPE_WHATSAPP', texto, ahora().toISOString(), { userId: 'u-api', source: 'app', adjuntos: ['https://x/img.png'] })); return { messageId: id }; },
    addTags: async () => {}, removeTags: async () => {}, assign: async () => {}, addNote: async (_, t) => { en.notas.push(t); return { id: 'n1' }; }, updateNote: async () => {},
    getContact: async () => ({ contact: { phone: '+34611111111' } }),
  };
  const cola = [...respuestas];
  const complete = async (req) => {
    en.llamadasIA++;
    en.ultimaPeticion = req;
    if (en.hooks.ia) await en.hooks.ia();
    const r = cola.shift();
    if (!r) throw new Error('sin respuesta preparada');
    return { content: [{ type: 'tool_use', id: 't', name: 'responder', input: { mensajes: r, fase: 'f1 apertura', sede: 'desconocida', etiquetas: [] } }], usage: { input_tokens: 1, output_tokens: 1 } };
  };
  const setter = new Setter({
    repo, ghl, complete, live, sleep: async () => {}, now: ahora, random: () => 0, avisar: async (t) => en.avisos.push(t),
    aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: false }), prepararAlta: async () => ({}) },
  });
  const hist = () => repo.history('cv1').map((m) => `${m.autor}: ${m.texto}`);
  return { repo, setter, en, hist, ahora, avanzar: (ms) => { reloj = new Date(reloj.getTime() + ms); } };
}
const hace = (base, s) => new Date(base.getTime() - s * 1000).toISOString();

test('el turno empieza mientras entra otro aviso del lead: contesta una sola vez, con los dos mensajes', async () => {
  const { setter, repo, en, hist, ahora, avanzar } = montar({ respuestas: [['respuesta 1'], ['respuesta 2 (repetida)']] });
  en.lista = [msg('g1', 'inbound', 'TYPE_WHATSAPP', 'hola', hace(ahora(), 5))];
  await setter.handleWebhook(webhook('hola'));
  const due = new Date(repo.getConv('cv1').respond_at);
  avanzar(due.getTime() - ahora().getTime() + 10); // justo cuando toca contestar
  en.lista.push(msg('g2', 'inbound', 'TYPE_WHATSAPP', 'cuánto cuesta?', hace(ahora(), 1)));
  // El GET de mensajes de GHL del webhook de M2 tarda un poco: en ese hueco entra el tick
  let soltar; const puerta = new Promise((r) => { soltar = r; });
  en.hooks.mensajes = async () => { en.hooks.mensajes = null; await puerta; };
  const w = setter.handleWebhook(webhook('cuánto cuesta?'));
  await tick0();
  const t = setter.tick();        // el bucle de 2 s
  await tick0();
  soltar();
  await w; await t;
  assert.deepEqual(en.enviados, ['respuesta 1']);
  assert.equal(repo.getConv('cv1').respond_at, null, 'no queda otra respuesta programada');
  assert.deepEqual(hist().slice(0, 2), ['lead: hola', 'lead: cuánto cuesta?']);
  avanzar(60000);
  await setter.tick();
  assert.deepEqual(en.enviados, ['respuesta 1']);
  assert.equal(en.llamadasIA, 1);
});

test('un mensaje de un workflow de GHL y su copia del conector no apartan a Sofía', async () => {
  const { setter, repo, en, hist, ahora, avanzar } = montar({ respuestas: [['hola!']] });
  en.lista = [msg('g1', 'inbound', 'TYPE_WHATSAPP', 'hola', hace(ahora(), 5))];
  await setter.handleWebhook(webhook('hola'));
  const mas = (s) => new Date(T0.getTime() + s * 1000).toISOString();
  en.lista.push(msg('w1', 'outbound', 'TYPE_WHATSAPP', 'Recordatorio automático: mañana tienes tu clase', mas(6), { source: 'workflow' }));
  en.lista.push(copia('w1c', 'outbound', 'Recordatorio automático: mañana tienes tu clase', mas(7)));
  avanzar(60000);
  await setter.tick();
  assert.equal(repo.getConv('cv1').ai_paused, 0);
  assert.deepEqual(en.enviados, ['hola!']);
  assert.ok(!hist().some((x) => x.startsWith('humano')));
});

test('la copia del conector de un archivo que manda Sofía (con su pie) no la aparta', async () => {
  const { setter, repo, en, hist, ahora, avanzar } = montar({ respuestas: [['son 85 € al mes']], realClock: true });
  en.lista = [msg('g1', 'inbound', 'TYPE_WHATSAPP', 'hola', hace(ahora(), 5))];
  await setter.handleWebhook(webhook('hola'));
  const conv = repo.getConv('cv1');
  await setter.enviarRecursos(conv, [{ id: 1, tipo: 'imagen', nombre: 'parla-tarifas', media_ruta: 'recursos/x.png', mime: 'image/png', token: 'tok' }]);
  en.lista.push(copia('a1c', 'outbound', 'aquí tienes las tarifas', new Date(Date.now() + 1000).toISOString()));
  en.lista.push(msg('g2', 'inbound', 'TYPE_WHATSAPP', 'gracias', new Date(Date.now() + 2000).toISOString()));
  await setter.handleWebhook(webhook('gracias'));
  assert.equal(repo.getConv('cv1').ai_paused, 0);
  assert.ok(!hist().some((x) => x.startsWith('humano')));
});

test('un envío sin confirmar que sí salió: al reintentar se reconoce como de Sofía, sin pausa ni segunda respuesta', async (t) => {
  // Hora fija de día: con el reloj real, de madrugada el reintento se aplaza a la apertura y la prueba fallaba
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-17T10:00:00Z') });
  const { setter, repo, en, hist, ahora, avanzar } = montar({ respuestas: [['hola! qué sede te pilla mejor?'], ['otra']], realClock: true });
  en.lista = [msg('g1', 'inbound', 'TYPE_WHATSAPP', 'hola', hace(ahora(), 5))];
  await setter.handleWebhook(webhook('hola'));
  repo.updateConv('cv1', { respond_at: new Date(Date.now() - 1000).toISOString() });
  let tarde = null;
  setter.ghl.sendMessage = async ({ texto }) => { tarde = msg('s-tarde', 'outbound', 'TYPE_WHATSAPP', texto, new Date().toISOString(), { userId: 'u-api', source: 'app' }); throw new Error('GHL POST /conversations/messages → sin respuesta en 20 s'); };
  await setter.tick();
  const c1 = repo.getConv('cv1');
  assert.ok(c1.respond_at, 'reintento programado');
  en.lista.push(tarde); // GHL lo lista ahora (el mensaje sí salió)
  repo.updateConv('cv1', { respond_at: new Date(Date.now() - 1000).toISOString() });
  await setter.tick();
  const c2 = repo.getConv('cv1');
  assert.equal(c2.ai_paused, 0);
  assert.deepEqual(hist(), ['lead: hola', 'ia: hola! qué sede te pilla mejor?']);
  assert.equal(en.llamadasIA, 1, 'no se vuelve a contestar');
  assert.equal(c2.respond_at, null);
});

test('una respuesta pendiente de madrugada (reintento, reinicio, forzar) espera a la apertura', async () => {
  const noche = new Date('2026-11-17T02:00:00Z'); // 03:00 Madrid
  const { setter, repo, en, hist, ahora, avanzar } = montar({ respuestas: [['hola!']], t0: noche });
  en.lista = [msg('g1', 'inbound', 'TYPE_WHATSAPP', 'hola', hace(ahora(), 5))];
  await setter.handleWebhook(webhook('hola'));
  // lo que hacen /panel/.../forzar, recuperar() tras un reinicio, la etiqueta «forzar respuesta» o un reintento
  repo.updateConv('cv1', { respond_at: ahora().toISOString() });
  await setter.tick();
  assert.deepEqual(en.enviados, [MENSAJE_FUERA_HORARIO]); // solo el aviso automático de fuera de horario
  assert.equal(new Date(repo.getConv('cv1').respond_at).toISOString(), '2026-11-17T07:00:00.000Z'); // las 8:00 en Madrid
  avanzar(5 * 3600e3 + 60000);
  await setter.tick();
  assert.deepEqual(en.enviados, [MENSAJE_FUERA_HORARIO, 'hola!']);
});

test('un aviso procesado con más de 3 minutos de retraso no duplica el mensaje del lead', async () => {
  const { setter, repo, en, hist, ahora, avanzar } = montar();
  en.lista = [msg('g1', 'inbound', 'TYPE_WHATSAPP', 'hola', hace(ahora(), 5))];
  await setter.handleWebhook(webhook('hola'));
  en.lista.push(msg('g2', 'inbound', 'TYPE_WHATSAPP', 'te he mandado un audio', new Date(T0.getTime() + 5000).toISOString()));
  avanzar(190000); // el webhook de M2 se procesa 185 s después de M2
  // (p. ej. estaba en cola detrás de la transcripción de un audio largo, o GHL tardó en avisar)
  const aviso = webhook('te he mandado un audio');
  aviso.recibido = new Date(T0.getTime() + 6000).toISOString(); // llegó a su hora; se procesa tarde, detrás de otro
  await setter.handleWebhook(aviso);
  assert.equal(repo.history('cv1').filter((m) => m.texto === 'te he mandado un audio').length, 1);
});

test('si el equipo contesta solo con un audio o una foto, Sofía también se aparta', async () => {
  const { setter, repo, en, hist, ahora, avanzar } = montar({ respuestas: [['hola!']] });
  en.lista = [msg('g1', 'inbound', 'TYPE_WHATSAPP', 'hola', hace(ahora(), 5))];
  await setter.handleWebhook(webhook('hola'));
  en.lista.push(msg('h1', 'outbound', 'TYPE_WHATSAPP', '', new Date(T0.getTime() + 5000).toISOString(), { userId: 'u7', source: 'app', adjuntos: ['https://x/nota.ogg'] }));
  avanzar(60000);
  await setter.tick();
  assert.equal(repo.getConv('cv1').ai_paused, 1);
  assert.equal(en.enviados.length, 0);
});

test('si el equipo escribe mientras Sofía piensa, su respuesta ya no sale', async () => {
  const { setter, repo, en, hist, ahora, avanzar } = montar({ respuestas: [['hola!', 'qué sede te pilla mejor?']] });
  en.lista = [msg('g1', 'inbound', 'TYPE_WHATSAPP', 'hola', hace(ahora(), 5))];
  await setter.handleWebhook(webhook('hola'));
  avanzar(60000);
  en.hooks.ia = async () => { en.lista.push(msg('h1', 'outbound', 'TYPE_WHATSAPP', 'Hola Ana, soy Carlos, te llamo', ahora().toISOString(), { userId: 'u7', source: 'app' })); };
  await setter.tick();
  assert.equal(en.enviados.length, 0);
  assert.equal(repo.getConv('cv1').ai_paused, 1);
});

test('tras un reinicio: no se repite un turno del que ya salió algo, y se recupera el mensaje que quedó sin programar', async () => {
  const { recuperar } = await import('../src/arranque.js');
  const repo = crearRepo(openDb(':memory:'));
  const chat = (id, patch) => { repo.upsertConv({ id, contact_id: `k-${id}`, channel: 'whatsapp' }); repo.updateConv(id, { tipo: 'captacion', ...patch }); };
  // a: se cortó entre burbujas (ya salió una) → no vuelve a la cola
  chat('a', { respondiendo_desde: T0.toISOString() });
  repo.addMessage({ conversation_id: 'a', autor: 'lead', texto: 'hola' }); repo.addMessage({ conversation_id: 'a', autor: 'ia', texto: 'hola!', external_id: 's1' });
  // b: se cortó mientras pensaba (no salió nada) → vuelve a la cola
  chat('b', { respondiendo_desde: T0.toISOString() });
  repo.addMessage({ conversation_id: 'b', autor: 'lead', texto: 'hola' });
  // c: el mensaje entró, pero el servicio se paró antes de programar la respuesta → se programa
  chat('c', {});
  repo.addMessage({ conversation_id: 'c', autor: 'lead', texto: 'un audio' });
  // d: igual que c pero pausado, y e: mensaje de hace una hora → no se tocan
  chat('d', { ai_paused: 1 });
  repo.addMessage({ conversation_id: 'd', autor: 'lead', texto: 'hola' });
  chat('e', {});
  repo.addMessage({ conversation_id: 'e', autor: 'lead', texto: 'hola', created_at: new Date(Date.now() - 3600e3).toISOString() });
  recuperar(repo.db, new Date());
  const cola = (id) => Boolean(repo.getConv(id).respond_at);
  assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map(cola), [false, true, true, false, false]);
  assert.equal(repo.getConv('a').respondiendo_desde, null);
});

test('las notas de sistema de Probar IA no llegan al modelo como si las hubiera escrito Sofía', () => {
  const repo = crearRepo(openDb(':memory:'));
  repo.upsertConv({ id: 'prueba-1', contact_id: 'prueba-1', channel: 'whatsapp' });
  repo.addMessage({ conversation_id: 'prueba-1', autor: 'lead', texto: 'hola' });
  repo.addMessage({ conversation_id: 'prueba-1', autor: 'ia', texto: 'hola! en qué sede?' });
  repo.addMessage({ conversation_id: 'prueba-1', autor: 'sistema', texto: '[GHL] etiquetas: captación' });
  assert.deepEqual(repo.history('prueba-1').map((m) => m.autor), ['lead', 'ia']);
});

test('el canal del chat sigue al último mensaje del lead', async () => {
  const { setter, repo } = montar();
  await setter.handleWebhook({ evento: 'inbound', conversationId: 'cv1', contactId: 'k1', canal: 'instagram', texto: 'hola', messageId: 'i1' });
  assert.equal(repo.getConv('cv1').channel, 'instagram');
  await setter.handleWebhook({ evento: 'inbound', conversationId: 'cv1', contactId: 'k1', canal: 'whatsapp', texto: 'te escribo por aquí', messageId: 'w1' });
  assert.equal(repo.getConv('cv1').channel, 'whatsapp');
});
