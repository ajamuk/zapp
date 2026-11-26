import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import { Ghl } from '../src/ghl.js';
import { crearApp } from '../src/server.js';
import { config } from '../src/config.js';
import * as plantillasWa from '../src/plantillas.js';
import { normalizarTelefono, validar, chatExistente } from '../src/primer-contacto.js';
import { estadoAislamiento } from '../src/aislamiento.js';

config.adminToken = 'clave-test';
const T0 = new Date('2026-11-17T11:00:00Z');
const PLANTILLA = { nombre: 'metro_primer_contacto_v1', idioma: 'es', categoria: 'MARKETING', cuerpo: 'Hola {{1}} 😊 Te escribimos de CrossFit MetroPolitano. {{2}} ¿Te cuento?' };
const DATOS = { telefono: '600 111 222', nombre: 'Laura Prueba', variables: ['Laura', 'Vimos que probaste una clase en Parla.'], motivo: 'vino a una prueba en 2025 y no se apuntó' };

function montar({ aislamiento } = {}) {
  const repo = crearRepo(openDb(':memory:'));
  const sal = { contactos: [], plantillas: [], notas: [] };
  const setter = new Setter({
    repo, live: true, sleep: async () => {}, now: () => T0, random: () => 0, ...(aislamiento ? { aislamiento } : {}),
    ghl: {
      upsertContacto: async (c) => { sal.contactos.push(c); return { id: `k-${c.telefono}`, nuevo: true }; },
      enviarPlantillaWa: async (p) => { sal.plantillas.push(p); return { messageId: 'm1', conversationId: `conv-${p.contactId}` }; },
      addNote: async (k, t) => { sal.notas.push(t); }, addTags: async () => {}, removeTags: async () => {},
    },
    aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: false }) },
    complete: async () => { throw new Error('no debería llamar a la IA'); },
  });
  const p = plantillasWa.crear(repo.db, PLANTILLA);
  return { repo, setter, sal, plantilla: p.id };
}

test('primer contacto: teléfonos y datos del formulario', () => {
  assert.equal(normalizarTelefono('600 111 222'), '+34600111222');
  assert.equal(normalizarTelefono('0034 600-111-222'), '+34600111222');
  assert.equal(normalizarTelefono('+351 912 345 678'), '+351912345678');
  assert.equal(normalizarTelefono('+34 500 111 222'), null); // no es móvil ni fijo español
  assert.equal(normalizarTelefono('1234'), null);
  assert.throws(() => validar({ ...DATOS, telefono: 'x' }), /móvil válido/);
  assert.throws(() => validar({ ...DATOS, nombre: ' ' }), /nombre/);
  assert.throws(() => validar({ ...DATOS }), /plantilla/);
  assert.throws(() => validar({ ...DATOS, plantilla: 1, motivo: '' }), /por qué le escribimos/);
  assert.equal(validar({ ...DATOS, plantilla: 1 }).sofiaResponde, true);
});

test('primer contacto: crea el contacto, envía la plantilla y deja el chat con el motivo para Sofía', async () => {
  const { repo, setter, sal, plantilla } = montar();
  const r = await setter.iniciarConversacion({ ...DATOS, plantilla });
  assert.equal(r.id, 'conv-k-+34600111222');
  assert.deepEqual(sal.contactos, [{ telefono: '+34600111222', nombre: 'Laura Prueba' }]);
  assert.equal(sal.plantillas[0].nombre, 'metro_primer_contacto_v1');
  assert.deepEqual(sal.plantillas[0].variables, DATOS.variables);
  const conv = repo.getConv(r.id);
  assert.equal(conv.channel, 'whatsapp'); assert.equal(conv.telefono, '+34600111222'); assert.equal(conv.nombre, 'Laura Prueba');
  assert.equal(conv.ai_paused, 0); // Sofía contestará cuando responda
  assert.equal(conv.tipo, null);   // al responder se sigue comprobando si es socio
  const m = repo.db.prepare('SELECT * FROM messages WHERE conversation_id = ?').all(r.id);
  assert.equal(m.length, 1); assert.equal(m[0].autor, 'humano'); assert.equal(m[0].tipo, 'plantilla'); assert.equal(m[0].external_id, 'm1');
  assert.match(m[0].texto, /^Hola Laura 😊 .*probaste una clase en Parla/);
  assert.match(sal.notas[0], /Primer contacto.*no se apuntó/);
  assert.match(setter.contexto(conv), /la empezamos nosotros.*vino a una prueba en 2025/);
});

test('primer contacto: sin Sofía queda en pausa; un número que ya tiene chat no recibe nada', async () => {
  const { repo, setter, sal, plantilla } = montar();
  const r = await setter.iniciarConversacion({ ...DATOS, plantilla, sofiaResponde: false });
  assert.equal(repo.getConv(r.id).ai_paused, 1);
  const otra = await setter.iniciarConversacion({ ...DATOS, telefono: '+34 600111222', plantilla });
  assert.equal(otra.existente, r.id);
  assert.equal(sal.plantillas.length, 1);
  assert.equal(chatExistente(repo.db, { telefono: '600111222' }).id, r.id);
});

test('primer contacto: con el número propio aislado, el chat queda verificado; mal configurado no sale nada', async () => {
  const aisl = estadoAislamiento({ numero: '+34604840858', locationId: 'loc1', locationCliente: 'loc1' });
  assert.equal(aisl.modo, 'activo');
  const { repo, setter, plantilla } = montar({ aislamiento: aisl });
  const r = await setter.iniciarConversacion({ ...DATOS, plantilla });
  assert.equal(repo.getConv(r.id).aislado_num, aisl.clave);
  assert.equal(setter.permitido(repo.getConv(r.id)), true);
  const { setter: mal, sal } = montar({ aislamiento: estadoAislamiento({ numero: '604', locationId: 'loc1', locationCliente: 'loc1' }) });
  await assert.rejects(mal.iniciarConversacion({ ...DATOS, plantilla: 1 }), /mal configurado/);
  assert.equal(sal.contactos.length, 0);
});

test('GHL: upsert del contacto por teléfono', async () => {
  const peticiones = [];
  const ghl = new Ghl({ token: 't', baseUrl: 'https://ghl.test', aislamiento: { modo: 'apagado' }, fetchImpl: async (url, o) => { peticiones.push({ url, body: JSON.parse(o.body) }); return new Response(JSON.stringify({ new: true, contact: { id: 'k9' } }), { status: 200 }); } });
  assert.deepEqual(await ghl.upsertContacto({ telefono: '+34600111222', nombre: 'Laura' }), { id: 'k9', nuevo: true });
  assert.equal(peticiones[0].url, 'https://ghl.test/contacts/upsert');
  assert.deepEqual({ ...peticiones[0].body, locationId: 'x' }, { locationId: 'x', phone: '+34600111222', firstName: 'Laura', source: 'Sofía · primer contacto' });
});

test('API: /panel/primer-contacto crea el chat, avisa del duplicado y explica los errores', async () => {
  const { repo, setter, plantilla } = montar();
  const srv = crearApp({ setter, repo }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const api = (b) => fetch(`http://127.0.0.1:${srv.address().port}/admin/panel/primer-contacto`, { method: 'POST', body: JSON.stringify(b), headers: { authorization: 'Bearer clave-test', 'content-type': 'application/json' } });
  try {
    const a = await api({ ...DATOS, plantilla });
    assert.equal(a.status, 201);
    const b = await api({ ...DATOS, plantilla });
    assert.equal(b.status, 200); assert.ok((await b.json()).existente);
    const c = await api({ ...DATOS, telefono: '12' , plantilla });
    assert.equal(c.status, 409); assert.match((await c.json()).error, /móvil válido/);
  } finally { srv.close(); }
});
