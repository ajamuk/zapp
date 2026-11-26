// Contestar al lead desde el panel. Datos sintéticos: ningún teléfono ni id es real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import { crearApp } from '../src/server.js';
import { estadoAislamiento } from '../src/aislamiento.js';
import { guardarAjustes } from '../src/ajustes.js';

config.adminToken = 'clave-test';
const T0 = new Date('2026-11-17T11:00:00Z');
const AISL = estadoAislamiento({ numero: '+34910000001', locationId: 'loc', locationCliente: 'loc' });

async function montar({ live = true, aislamiento = undefined, canal = 'whatsapp', falla = null, lista = [] } = {}) {
  const repo = crearRepo(openDb(':memory:'));
  const enviados = [];
  const ghl = {
    sendMessage: async (x) => { if (falla) throw new Error(falla); enviados.push(x); return { messageId: `s${enviados.length}` }; },
    mensajes: async () => lista, addNote: async () => {}, addTags: async () => {}, removeTags: async () => {},
  };
  const setter = new Setter({ repo, ghl, live, aislamiento, telefonosPrueba: [], sleep: async () => {}, now: () => new Date(T0.getTime() + 3600e3), avisar: async () => {} });
  repo.upsertConv({ id: 'c1', contact_id: 'k1', channel: canal, nombre: 'Lead Sintético', telefono: '+34600000000' });
  repo.updateConv('c1', { last_inbound_at: T0.toISOString(), respond_at: T0.toISOString(), ...(aislamiento ? { aislado_num: aislamiento.clave } : {}) });
  repo.addMessage({ conversation_id: 'c1', autor: 'lead', texto: 'hola, precio?' });
  repo.schedule('c1', 'comercial-5h', new Date(T0.getTime() + 5 * 3600e3).toISOString());
  const srv = crearApp({ setter, repo }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const api = (ruta, o = {}) => fetch(`http://127.0.0.1:${srv.address().port}/admin/panel/conversaciones/c1${ruta}`, { ...o, headers: { authorization: 'Bearer clave-test', 'content-type': 'application/json' } });
  const enviar = (texto) => api('/enviar', { method: 'POST', body: JSON.stringify({ texto }) });
  return { repo, setter, srv, api, enviar, enviados };
}
const humanos = (repo) => repo.db.prepare("SELECT texto, external_id, enviado FROM messages WHERE autor = 'humano'").all();

test('el mensaje sale por GHL, queda como del equipo y Sofía se aparta', async () => {
  const { repo, srv, api, enviar, enviados, setter } = await montar();
  try {
    const d = await (await api('')).json();
    assert.deepEqual(d.escribir, { motivo: '', pausa: true });
    const r = await enviar('  Hola, soy Carlos  ');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, pausada: true });
    assert.deepEqual(enviados, [{ contactId: 'k1', canal: 'whatsapp', texto: 'Hola, soy Carlos' }]);
    assert.deepEqual(humanos(repo), [{ texto: 'Hola, soy Carlos', external_id: 's1', enviado: 1 }]);
    const c = repo.getConv('c1');
    assert.deepEqual([c.ai_paused, c.respond_at], [1, null]);
    assert.equal(repo.db.prepare("SELECT count(*) n FROM scheduled WHERE estado = 'pendiente'").get().n, 0);
    // El eco de GHL (nativo, con su id, y la copia del conector, sin él) no lo duplica
    await setter.procesarEvento({ evento: 'outbound', conversationId: 'c1', canal: 'whatsapp', texto: 'Hola, soy Carlos', messageId: 's1', userId: 'u1' });
    await setter.procesarEvento({ evento: 'outbound', conversationId: 'c1', canal: 'sms', texto: 'Hola, soy Carlos', messageId: 'x9', userId: 'u1' });
    assert.equal(humanos(repo).length, 1);
  } finally { srv.close(); }
});

test('con «pausar si escribe el equipo» apagado, o en modo prueba, se envía y Sofía sigue', async () => {
  for (const caso of ['ajuste', 'shadow']) {
    const { repo, srv, api, enviar, enviados } = await montar({ live: caso !== 'shadow' });
    try {
      if (caso === 'ajuste') guardarAjustes(repo, { pausarSiEquipoEscribe: false });
      assert.equal((await (await api('')).json()).escribir.pausa, false);
      assert.deepEqual(await (await enviar('te cuento')).json(), { ok: true, pausada: false });
      assert.equal(enviados.length, 1, 'sale de verdad también en modo prueba');
      assert.equal(repo.getConv('c1').ai_paused, 0);
    } finally { srv.close(); }
  }
});

test('fuera de las 24 h, vacío o demasiado largo: no sale nada', async () => {
  const { repo, srv, api, enviar, enviados } = await montar();
  try {
    assert.equal((await enviar('   ')).status, 400);
    assert.equal((await enviar('a'.repeat(2001))).status, 400);
    repo.updateConv('c1', { last_inbound_at: new Date(T0.getTime() - 30 * 3600e3).toISOString() });
    assert.match((await (await api('')).json()).escribir.motivo, /24 h/);
    const r = await enviar('hola');
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /plantilla/);
    assert.deepEqual([enviados.length, humanos(repo).length, repo.getConv('c1').ai_paused], [0, 0, 0]);
  } finally { srv.close(); }
});

test('aislamiento: solo chats verificados del número de Sofía y solo WhatsApp', async () => {
  const a = await montar({ aislamiento: AISL });
  try {
    assert.equal((await a.enviar('hola')).status, 200);
    a.repo.updateConv('c1', { aislado_num: null });
    const r = await a.enviar('hola otra vez');
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /CRM/);
    assert.equal(a.enviados.length, 1);
  } finally { a.srv.close(); }
  const b = await montar({ aislamiento: AISL, canal: 'instagram' });
  try {
    assert.equal((await b.enviar('hola')).status, 409);
    assert.equal(b.enviados.length, 0);
  } finally { b.srv.close(); }
});

test('si GHL falla no queda registrado; si no confirma pero salió, sí', async () => {
  const a = await montar({ falla: 'GHL 500' });
  try {
    const r = await a.enviar('hola');
    assert.equal(r.status, 502);
    assert.deepEqual([humanos(a.repo).length, a.repo.getConv('c1').ai_paused], [0, 0]);
  } finally { a.srv.close(); }
  const fecha = new Date(T0.getTime() + 3600e3).toISOString();
  const b = await montar({ falla: 'sin respuesta en 20 s', lista: [{ id: 'g7', direccion: 'outbound', canal: 'whatsapp', texto: 'hola', fecha }] });
  try {
    assert.equal((await b.enviar('hola')).status, 200);
    assert.deepEqual(humanos(b.repo), [{ texto: 'hola', external_id: 'g7', enviado: 1 }]);
  } finally { b.srv.close(); }
});
