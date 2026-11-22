import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import { parseWebhook, Ghl } from '../src/ghl.js';

// Lo que manda la acción «Webhook» de un workflow de GHL (disparador Customer Replied)
const cuerpoWorkflow = {
  contact_id: 'k7', first_name: 'Ana', last_name: 'López', full_name: 'Ana López', phone: '+34611111111',
  tags: 'parla, lead', message: { type: 19, body: 'hola, cuánto cuesta?' },
  location: { id: 'loc' }, workflow: { id: 'w', name: 'Mensaje entrante' },
  customData: { messageType: '{{message.type}}', conversationId: '' },
};

test('webhook de workflow de GHL: contact_id, customData y tipo numérico', () => {
  const e = parseWebhook(cuerpoWorkflow);
  assert.equal(e.evento, 'inbound');
  assert.equal(e.contactId, 'k7');
  assert.equal(e.texto, 'hola, cuánto cuesta?');
  assert.equal(e.nombre, 'Ana López');
  assert.equal(e.canal, 'desconocido'); // el número no se adivina
  assert.equal(e.conversationId, undefined);
  assert.deepEqual(e.tags, ['parla', 'lead']);
  // Custom Data con valores reales sí cuenta
  const c = parseWebhook({ ...cuerpoWorkflow, customData: { conversationId: 'cv1', messageType: 'WhatsApp' } });
  assert.deepEqual([c.conversationId, c.canal], ['cv1', 'whatsapp']);
});

test('sin id de conversación ni canal, se preguntan a GHL y el mensaje entra', async () => {
  const repo = crearRepo(openDb(':memory:'));
  const pedidos = [];
  const ghl = {
    buscarConversacion: async (id) => { pedidos.push(id); return { id: 'cv9', canal: 'whatsapp' }; },
    addTags: async () => {}, removeTags: async () => {}, assign: async () => {}, addNote: async () => {},
    getContact: async () => ({ contact: { phone: '+34611111111' } }),
  };
  const setter = new Setter({
    repo, ghl, live: false, sleep: async () => {}, avisar: async () => {}, complete: async () => { throw new Error('no'); },
    aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: false }), prepararAlta: async () => ({}) },
  });
  await setter.handleWebhook(parseWebhook(cuerpoWorkflow));
  assert.deepEqual(pedidos, ['k7']);
  const conv = repo.getConv('cv9');
  assert.ok(conv, 'se crea la conversación con el id de GHL');
  assert.equal(conv.channel, 'whatsapp');
});

test('buscarConversacion lee el canal del último mensaje', async () => {
  let url;
  const g = new Ghl({ token: 't', baseUrl: 'https://x', fetchImpl: async (u) => { url = u; return new Response(JSON.stringify({ conversations: [{ id: 'cv1', lastMessageType: 'TYPE_INSTAGRAM' }] })); } });
  assert.deepEqual(await g.buscarConversacion('k1'), { id: 'cv1', canal: 'instagram' });
  assert.match(url, /\/conversations\/search\?.*contactId=k1/);
});
