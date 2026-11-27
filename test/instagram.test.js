// Instagram con aislamiento: solo peticiones claras de información; nunca historias, reacciones ni emojis.
// Datos sintéticos: ningún teléfono, id ni cuenta es real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import { Ghl } from '../src/ghl.js';
import { estadoAislamiento, evaluarEntrante, salienteVerificado, esDeOtraLinea } from '../src/aislamiento.js';
import { filtroInstagram, pideInformacion, pideInformacionSinModelo } from '../src/instagram.js';

const PROPIO = '+34910000001'; const LOC = 'locSofia';
const PAGINA = '11111111111111111'; const OTRA_PAGINA = '22222222222222222';
const AISL = estadoAislamiento({ numero: PROPIO, locationId: LOC, locationCliente: LOC, instagram: PAGINA });
const SIN_IG = estadoAislamiento({ numero: PROPIO, locationId: LOC, locationCliente: LOC });
const T0 = new Date('2026-11-17T11:00:00Z'); // martes 12:00 en Madrid
const HISTORIA = 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1&signature=x';

const ig = (id, extra = {}) => ({
  id, direccion: 'inbound', tipo: 'TYPE_INSTAGRAM', canal: 'instagram', texto: 'Hola, ¿qué precio tiene la cuota?', adjuntos: [], userId: null, source: null,
  fecha: T0.toISOString(), locationId: LOC, conversationId: 'c1', contactId: 'k1', para: 'cuenta', de: 'lead', pagina: PAGINA, ...extra,
});
const aviso = () => ({ evento: 'inbound', contactId: 'k1', conversationId: 'c1', canal: 'desconocido', texto: '', messageId: null, nombre: 'Lead Sintético', tags: [] });

function montar({ aislamiento = AISL, lista = [], lead = true, falla = false } = {}) {
  const repo = crearRepo(openDb(':memory:'));
  const sal = { enviados: [], filtro: 0, modelo: 0 };
  let reloj = new Date(T0);
  const ghl = {
    sendMessage: async ({ texto, canal }) => { sal.enviados.push({ texto, canal }); return { messageId: `s${sal.enviados.length}` }; },
    enviarAdjunto: async (x) => { sal.enviados.push(x); return { messageId: 'a1' }; },
    addTags: async () => {}, removeTags: async () => {}, assign: async () => {}, addNote: async () => {}, getContact: async () => ({ contact: {} }),
    mensajes: async () => (typeof lista === 'function' ? lista() : lista),
  };
  const setter = new Setter({
    repo, ghl, live: true, aislamiento, sleep: async () => {}, now: () => reloj, random: () => 0, avisar: async () => {},
    aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: false }) },
    complete: async () => { sal.modelo++; return { content: [{ type: 'tool_use', id: 't', name: 'responder', input: { fase: 'f2 diagnóstico', sede: 'desconocida', mensajes: ['hola, te cuento'] } }], usage: { input_tokens: 1, output_tokens: 1 } }; },
  });
  setter.completeFiltro = async () => {
    sal.filtro++;
    if (falla) throw new Error('modelo caído');
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ lead }) }], usage: { input_tokens: 1, output_tokens: 1 } };
  };
  return { repo, setter, sal, avanzar: (ms) => { reloj = new Date(reloj.getTime() + ms); } };
}
const chats = (repo) => repo.db.prepare('SELECT count(*) n FROM conversations').get().n;

// ---------- Configuración y pruebas de origen ----------

test('configuración: id de Instagram opcional y solo con cifras', () => {
  assert.equal(SIN_IG.instagram, null);
  assert.equal(AISL.instagram, PAGINA);
  assert.equal(estadoAislamiento({ numero: PROPIO, locationId: LOC, locationCliente: LOC, instagram: 'cuenta' }).modo, 'invalido');
});

test('entrante de Instagram: vale solo si Sofía atiende esa cuenta', () => {
  assert.equal(evaluarEntrante(AISL, ig('m1')).ok, true);
  assert.equal(evaluarEntrante(SIN_IG, ig('m1')).motivo, 'no es WhatsApp', 'sin cuenta configurada, como antes');
  assert.equal(evaluarEntrante(AISL, ig('m1', { pagina: OTRA_PAGINA })).motivo, 'dirigido a otra cuenta de Instagram');
  assert.equal(evaluarEntrante(AISL, ig('m1', { pagina: null })).motivo, 'GHL no indica a qué cuenta de Instagram se escribió');
  assert.equal(evaluarEntrante(AISL, ig('m1', { locationId: 'otra' })).ok, false);
  assert.equal(evaluarEntrante(AISL, ig('m1', { contactId: 'k9' }), { contactId: 'k1' }).ok, false);
});

test('salientes de Instagram: el equipo escribiendo desde la cuenta propia cuenta; otra cuenta marca chat compartido', () => {
  const sal = ig('o1', { direccion: 'outbound' });
  assert.equal(salienteVerificado(AISL, sal), true);
  assert.equal(salienteVerificado(SIN_IG, sal), false);
  assert.equal(esDeOtraLinea(AISL, ig('m1', { pagina: OTRA_PAGINA })), true);
  assert.equal(esDeOtraLinea(AISL, ig('m1')), false);
  assert.equal(esDeOtraLinea(SIN_IG, ig('m1', { pagina: OTRA_PAGINA })), false, 'sin Instagram no cambia nada');
});

test('envío: por Instagram solo con la cuenta configurada', () => {
  assert.deepEqual(new Ghl({ token: 't', aislamiento: AISL }).cuerpoEnvio('instagram', { message: 'x' }), { type: 'IG', message: 'x' });
  assert.throws(() => new Ghl({ token: 't', aislamiento: SIN_IG }).cuerpoEnvio('instagram', { message: 'x' }), /solo se envía por WhatsApp/);
  assert.equal(new Ghl({ token: 't', aislamiento: AISL }).cuerpoEnvio('whatsapp', { message: 'x' }).fromNumber, PROPIO);
});

// ---------- Filtros ----------

test('filtro fijo: historias, publicaciones compartidas, mensajes sin texto y emojis no pasan', () => {
  assert.match(filtroInstagram(ig('m', { adjuntos: [HISTORIA], texto: '' })).motivo, /historia/);
  assert.match(filtroInstagram(ig('m', { adjuntos: [HISTORIA], texto: 'qué guapo, ¿precio?' })).motivo, /historia/, 'respuesta a una historia, aunque traiga texto');
  assert.match(filtroInstagram(ig('m', { adjuntos: ['https://link.ejemplo/foto.jpeg'], texto: '' })).motivo, /sin texto/);
  assert.match(filtroInstagram(ig('m', { texto: '😂🔥' })).motivo, /emojis/);
  assert.match(filtroInstagram(ig('m', { texto: '  ' })).motivo, /sin texto/);
  assert.equal(filtroInstagram(ig('m')).ok, true);
});

test('respaldo sin modelo: solo frases inequívocas', () => {
  for (const t of ['¿Qué precio tiene?', 'Quiero información', 'Me gustaría probar una clase', '¿Tenéis clase de prueba?', 'horarios de Parla?', 'quiero apuntarme']) assert.equal(pideInformacionSinModelo(t), true, t);
  for (const t of ['jajaja qué guay', 'Gracias 💙', 'Felicidades al equipo', 'Hola']) assert.equal(pideInformacionSinModelo(t), false, t);
});

test('el modelo decide; si falla, decide el respaldo', async () => {
  const resp = (lead) => async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ lead }) }] });
  assert.equal((await pideInformacion('¿os apuntáis a nuestra liga?', { complete: resp(false) })).ok, false);
  assert.equal((await pideInformacion('hola!', { complete: resp(true) })).ok, true);
  const caido = async () => { throw new Error('caído'); };
  assert.deepEqual(await pideInformacion('¿precio de la cuota?', { complete: caido }), { ok: true, via: 'respaldo' });
  assert.equal((await pideInformacion('jaja', { complete: caido })).ok, false);
});

test('el filtro va sin razonamiento en Haiku (con margen de tokens y tiempo límite corto); otros modelos, esfuerzo bajo', async () => {
  const vistos = [];
  const complete = async (req, opciones) => { vistos.push({ req, opciones }); return { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"lead":true}' }] }; };
  await pideInformacion('¿precio?', { complete, modelo: 'claude-haiku-5-5' });
  const { req, opciones } = vistos[0];
  assert.deepEqual(req.thinking, { type: 'disabled' });
  assert.equal(req.output_config.effort, undefined);
  assert.ok(req.max_tokens >= 1024);
  assert.deepEqual(opciones, { timeout: 15000, maxRetries: 1 });
  await pideInformacion('¿precio?', { complete, modelo: 'claude-sonnet-5-5' });
  assert.equal(vistos[1].req.thinking, undefined, 'Sonnet 5.5 no admite apagar el razonamiento');
  assert.equal(vistos[1].req.output_config.effort, 'low');
});

// ---------- Entrada ----------

test('petición clara por Instagram a la cuenta propia: se abre el chat y Sofía contesta por Instagram', async () => {
  const { repo, setter, sal, avanzar } = montar({ lista: [ig('m1')] });
  await setter.handleWebhook(aviso());
  const c = repo.getConv('c1');
  assert.deepEqual([c.channel, c.aislado_num], ['instagram', AISL.clave]);
  assert.equal(sal.filtro, 1);
  avanzar(60000); await setter.tick();
  assert.deepEqual(sal.enviados, [{ texto: 'hola, te cuento', canal: 'instagram' }]);
});

test('lo que no es una petición clara no abre chat ni toca nada', async () => {
  const casos = {
    historia: { lista: [ig('m1', { adjuntos: [HISTORIA], texto: '' })], filtro: 0 },
    reaccion: { lista: [ig('m1', { texto: '❤️' })], filtro: 0 },
    otra_cuenta: { lista: [ig('m1', { pagina: OTRA_PAGINA })], filtro: 0 },
    sin_interes: { lista: [ig('m1', { texto: '¿Os apuntáis a la liga de este domingo con vuestro box?' })], lead: false, filtro: 1 },
  };
  for (const [nombre, k] of Object.entries(casos)) {
    const { repo, setter, sal } = montar({ lista: k.lista, lead: k.lead ?? true });
    await setter.handleWebhook(aviso());
    assert.equal(chats(repo), 0, nombre);
    assert.equal(sal.filtro, k.filtro, `${nombre}: llamadas al filtro`);
    assert.deepEqual([sal.enviados, sal.modelo], [[], 0], nombre);
  }
});

test('sin cuenta de Instagram configurada, Instagram sigue sin atenderse', async () => {
  const { repo, setter, sal } = montar({ aislamiento: SIN_IG, lista: [ig('m1')] });
  await setter.handleWebhook(aviso());
  assert.equal(chats(repo), 0);
  assert.equal(sal.filtro, 0);
});

test('chat de Instagram ya abierto: los textos entran sin volver a preguntar; las historias y reacciones no', async () => {
  let lista = [ig('m1')];
  const { repo, setter, sal, avanzar } = montar({ lista: () => lista });
  await setter.handleWebhook(aviso());
  avanzar(60000); await setter.tick();
  lista = [...lista, ig('m2', { texto: 'vale, ¿y los sábados?', fecha: new Date(T0.getTime() + 120000).toISOString() }),
    ig('m3', { texto: '', adjuntos: [HISTORIA], fecha: new Date(T0.getTime() + 130000).toISOString() })];
  avanzar(60000);
  await setter.handleWebhook(aviso());
  const textos = repo.db.prepare("SELECT texto FROM messages WHERE conversation_id = 'c1' AND autor = 'lead' ORDER BY id").all().map((x) => x.texto);
  assert.deepEqual(textos, ['Hola, ¿qué precio tiene la cuota?', 'vale, ¿y los sábados?']);
  assert.equal(sal.filtro, 1, 'el filtro de intención solo se usa para abrir el chat');
});

test('la decisión se recuerda: repasar la conversación no vuelve a preguntar al modelo', async () => {
  const { repo, setter, sal } = montar({ lista: [ig('m1', { texto: 'qué buena pinta' })], lead: false });
  await setter.handleWebhook(aviso());
  await setter.handleWebhook(aviso());
  assert.equal(chats(repo), 0);
  assert.equal(sal.filtro, 1);
});

test('modelo caído al abrir: una petición inequívoca entra igualmente', async () => {
  const { repo, setter } = montar({ lista: [ig('m1', { texto: 'Hola, ¿tenéis clase de prueba?' })], falla: true });
  await setter.handleWebhook(aviso());
  assert.equal(repo.getConv('c1')?.channel, 'instagram');
});
