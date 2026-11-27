// Barrido de chats nuevos sin aviso de GHL. Datos sintéticos: ningún teléfono ni id es real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import { estadoAislamiento } from '../src/aislamiento.js';

const PROPIO = '+34910000001'; const OTRO = '+34910000002'; const LOC = 'locSofia';
const AISL = estadoAislamiento({ numero: PROPIO, locationId: LOC, locationCliente: LOC });
const T0 = new Date('2026-11-17T11:00:00Z'); // martes 12:00 en Madrid
const hace = (min) => new Date(T0.getTime() - min * 60000).toISOString();

const wa = (id, conv, extra = {}) => ({
  id, direccion: 'inbound', tipo: 'TYPE_WHATSAPP', canal: 'whatsapp', texto: 'hola, precio?', adjuntos: [], userId: null, source: null,
  fecha: hace(10), locationId: LOC, conversationId: conv, contactId: `k-${conv}`, para: PROPIO, de: '+34600000000', ...extra,
});

function montar({ recientes, mensajes }) {
  const repo = crearRepo(openDb(':memory:'));
  const sal = { enviados: [], lecturas: {} };
  const ghl = {
    sendMessage: async ({ texto, canal }) => { sal.enviados.push({ texto, canal }); return { messageId: `s${sal.enviados.length}` }; },
    addTags: async () => {}, removeTags: async () => {}, assign: async () => {}, addNote: async () => {}, getContact: async () => ({ contact: {} }),
    conversacionesRecientes: async () => recientes,
    mensajes: async (id) => { sal.lecturas[id] = (sal.lecturas[id] || 0) + 1; return mensajes[id] || []; },
  };
  const setter = new Setter({
    repo, ghl, live: true, aislamiento: AISL, sleep: async () => {}, now: () => T0, random: () => 0, avisar: async () => {},
    aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: false }) },
    complete: async () => ({ content: [{ type: 'tool_use', id: 't', name: 'responder', input: { fase: 'f2 diagnóstico', sede: 'parla', mensajes: ['hola, te cuento'] } }], usage: { input_tokens: 1, output_tokens: 1 } }),
  });
  return { repo, setter, sal };
}

test('chat nuevo sin aviso: se recupera con la hora real del mensaje y Sofía lo atiende', async () => {
  const { repo, setter } = montar({ recientes: [{ id: 'c1', contactId: 'k-c1', ultimo: hace(10) }], mensajes: { c1: [wa('m1', 'c1')] } });
  const r = await setter.barrerConversacionesNuevas();
  assert.deepEqual(r, { revisadas: 1, recuperadas: 1 });
  const c = repo.getConv('c1');
  assert.equal(c.aislado_num, AISL.clave);
  assert.equal(c.last_inbound_at, hace(10));
  assert.equal(repo.db.prepare("SELECT created_at FROM messages WHERE conversation_id = 'c1'").get().created_at, hace(10));
  assert.ok(c.respond_at, 'queda programada la respuesta');
});

test('si el equipo ya contestó, el chat entra en pausa (no se contesta encima)', async () => {
  const equipo = { ...wa('o1', 'c1'), direccion: 'outbound', texto: 'te escribe el equipo', userId: 'u1', para: '+34600000000', de: PROPIO, fecha: hace(5) };
  const { repo, setter } = montar({ recientes: [{ id: 'c1', contactId: 'k-c1', ultimo: hace(5) }], mensajes: { c1: [wa('m1', 'c1'), equipo] } });
  await setter.barrerConversacionesNuevas();
  const c = repo.getConv('c1');
  assert.equal(c.ai_paused, 1);
  assert.equal(c.respond_at, null);
  const autores = repo.db.prepare("SELECT autor FROM messages WHERE conversation_id = 'c1' ORDER BY created_at").all().map((x) => x.autor);
  assert.deepEqual(autores, ['lead', 'humano'], 'orden real: primero el lead, luego el equipo');
});

test('no toca lo muy reciente (lo lleva el aviso), lo viejo, lo que ya está ni lo de otro número', async () => {
  const recientes = [
    { id: 'reciente', contactId: 'k-reciente', ultimo: hace(0.5) },
    { id: 'viejo', contactId: 'k-viejo', ultimo: hace(90) },
    { id: 'ya', contactId: 'k-ya', ultimo: hace(10) },
    { id: 'otro', contactId: 'k-otro', ultimo: hace(10) },
  ];
  const { repo, setter, sal } = montar({ recientes, mensajes: { otro: [wa('m9', 'otro', { para: OTRO })] } });
  repo.upsertConv({ id: 'ya', contact_id: 'k-ya', channel: 'whatsapp' });
  const r = await setter.barrerConversacionesNuevas();
  assert.deepEqual(r, { revisadas: 1, recuperadas: 0 });
  assert.deepEqual(Object.keys(sal.lecturas), ['otro']);
  assert.equal(repo.getConv('otro'), undefined);
  // Sin mensajes nuevos no se vuelve a leer
  await setter.barrerConversacionesNuevas();
  assert.equal(sal.lecturas.otro, 1);
});

test('GHL no contesta: no pasa nada y se reintenta en el siguiente barrido', async () => {
  const { setter, sal } = montar({ recientes: [{ id: 'c1', contactId: 'k-c1', ultimo: hace(10) }], mensajes: {} });
  setter.ghl.mensajes = async (id) => { sal.lecturas[id] = (sal.lecturas[id] || 0) + 1; throw new Error('caído'); };
  await setter.barrerConversacionesNuevas();
  await setter.barrerConversacionesNuevas();
  assert.equal(sal.lecturas.c1, 2);
  setter.ghl.conversacionesRecientes = async () => { throw new Error('caído'); };
  assert.deepEqual(await setter.barrerConversacionesNuevas(), { revisadas: 0, recuperadas: 0 });
});
