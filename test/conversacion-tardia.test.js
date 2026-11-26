// Contacto recién creado: el aviso del workflow de GHL llega antes de que GHL devuelva su conversación.
// Datos sintéticos: ningún teléfono ni id es real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';

const T0 = new Date('2026-11-17T11:00:00Z'); // martes 12:00 en Madrid
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));

function montar({ buscar }) {
  const repo = crearRepo(openDb(':memory:'));
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
  setter.repasosConversacion = [5, 5, 5];
  return { repo, setter, sal };
}
const aviso = (extra = {}) => ({ evento: 'inbound', contactId: 'k1', canal: 'whatsapp', texto: 'hola, precio?', messageId: 'm1', telefono: '+34600000000', nombre: 'Lead Sintético', tags: [], ...extra });
const chats = (repo) => repo.db.prepare('SELECT count(*) n FROM conversations').get().n;

test('GHL aún no devuelve la conversación del contacto nuevo: se repasa y el aviso entra al aparecer', async () => {
  let lista = false;
  const { repo, setter } = montar({ buscar: () => (lista ? { id: 'c1' } : null) });
  const r = await setter.handleWebhook(aviso());
  assert.equal(r.ignorado, 'faltan ids');
  assert.equal(r.reintento, true);
  assert.equal(chats(repo), 0);
  lista = true;
  await espera(60);
  assert.equal(repo.getConv('c1')?.contact_id, 'k1', 'el chat entra en el panel');
});

test('dos avisos del mismo contacto sin conversación: un solo repaso', async () => {
  let lista = false;
  const { setter, sal } = montar({ buscar: () => (lista ? { id: 'c1' } : null) });
  await setter.handleWebhook(aviso());
  const r2 = await setter.handleWebhook(aviso({ messageId: 'm2' }));
  assert.equal(r2.reintento, true);
  const antes = sal.busquedas;
  await espera(8);
  assert.ok(sal.busquedas - antes <= 1, 'no se duplica el repaso');
  lista = true;
  await espera(60);
});

test('si GHL nunca devuelve la conversación, se deja de preguntar', async () => {
  const { repo, setter, sal } = montar({ buscar: () => null });
  await setter.handleWebhook(aviso());
  await espera(80);
  assert.equal(sal.busquedas, 1 + 3, 'la búsqueda inicial y tres repasos');
  assert.equal(chats(repo), 0);
  assert.equal(setter.conversacionesPendientes.size, 0);
});

test('los salientes sin conversación no se repasan', async () => {
  const { setter } = montar({ buscar: () => null });
  const r = await setter.handleWebhook(aviso({ evento: 'outbound' }));
  assert.equal(r.reintento, false);
});
