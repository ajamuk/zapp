import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import * as etq from '../src/etiquetas.js';
import { filtrosSql, conversaciones, vistas, guardarVista, limpiarCriterios } from '../src/panel.js';

const T0 = new Date('2026-11-17T11:00:00Z'); // martes 12:00 en Madrid

function montar() {
  const repo = crearRepo(openDb(':memory:'));
  const sal = { tags: [], quitadas: [], avisos: [] };
  const ghl = { addTags: async (_, t) => sal.tags.push(...t), removeTags: async (_, t) => sal.quitadas.push(...t) };
  let reloj = new Date(T0);
  const e = new etq.Etiquetador({ repo, ghl, avisar: async (t) => sal.avisos.push(t), now: () => reloj });
  repo.upsertConv({ id: 'c1', contact_id: 'k1', channel: 'whatsapp', nombre: 'Ana' });
  return { repo, db: repo.db, e, sal, avanzar: (h) => { reloj = new Date(reloj.getTime() + h * 3600e3); } };
}

test('validación: nombre obligatorio y único, reglas saneadas', () => {
  const { db } = montar();
  assert.throws(() => etq.crear(db, { nombre: '  ' }), /nombre/);
  const a = etq.crear(db, { nombre: 'Hot lead', reglas: [{ tipo: 'texto', patron: 'precio' }, { tipo: 'rara' }] });
  assert.deepEqual(a.reglas, [{ tipo: 'texto', quien: 'lead', operador: 'contiene', patron: 'precio' }]);
  assert.equal(a.acciones.ghl, true);
  assert.throws(() => etq.crear(db, { nombre: 'hot LEAD' }), /Ya existe/);
  assert.throws(() => etq.crear(db, { nombre: 'x', reglas: [{ tipo: 'texto', patron: '' }] }), /palabra/);
  assert.throws(() => etq.crear(db, { nombre: 'y', reglas: [{ tipo: 'inactividad', horas: 0 }] }), /horas/);
});

test('reglas de texto: palabra completa, sin tildes ni mayúsculas, y quién escribe', () => {
  const r = { tipo: 'texto', quien: 'lead', operador: 'contiene', patron: 'precio' };
  assert.ok(etq.cumpleMensaje(r, { autor: 'lead', texto: '¿Qué PRECIO tiene?' }));
  assert.ok(!etq.cumpleMensaje(r, { autor: 'lead', texto: 'preciosa la web' }));
  assert.ok(!etq.cumpleMensaje(r, { autor: 'ia', texto: 'el precio es 85' }));
  assert.ok(etq.cumpleMensaje({ ...r, quien: 'nosotros', patron: 'alta' }, { autor: 'humano', texto: 'te hago el alta' }));
  assert.ok(etq.cumpleMensaje({ ...r, operador: 'exacto', patron: 'baja' }, { autor: 'lead', texto: ' Baja ' }));
  assert.ok(etq.cumpleMensaje({ ...r, operador: 'empieza', patron: 'hola' }, { autor: 'lead', texto: 'Hola, info' }));
  assert.ok(etq.cumpleMensaje({ ...r, operador: 'termina', patron: 'gracias' }, { autor: 'lead', texto: 'vale, gracias' }));
  assert.ok(etq.cumpleMensaje({ tipo: 'adjunto', quien: 'lead', media: 'audio' }, { autor: 'lead', adjunto: 'audio' }));
  assert.ok(!etq.cumpleMensaje({ tipo: 'adjunto', quien: 'lead', media: 'audio' }, { autor: 'lead', adjunto: 'imagen' }));
  assert.equal(etq.tipoAdjunto(['https://x/y/nota.OGG?x=1']), 'audio');
  assert.equal(etq.tipoAdjunto([{ url: 'https://x/a.pdf' }]), 'documento');
});

test('poner por regla: condiciones solo si / nunca si, acciones y copia a GHL', async () => {
  const { db, repo, e, sal } = montar();
  const compro = etq.crear(db, { nombre: 'Ha comprado' });
  const interesado = etq.crear(db, { nombre: 'Interesado' });
  const urgente = etq.crear(db, {
    nombre: 'Urgente', reglas: [{ tipo: 'texto', patron: 'hoy' }], solo_si: [interesado.id], nunca_si: [compro.id],
    acciones: { pausar_ia: true, avisar: true },
  });
  assert.deepEqual(await e.alMensaje('c1', { autor: 'lead', texto: 'puedo ir hoy' }), []); // falta «Interesado»
  await e.poner('c1', interesado.id, 'manual');
  assert.deepEqual(await e.alMensaje('c1', { autor: 'lead', texto: 'puedo ir hoy' }), ['Urgente']);
  const c = repo.getConv('c1');
  assert.equal(c.ai_paused, 1);
  assert.match(c.pause_reason, /Urgente/);
  assert.deepEqual(sal.tags, ['Interesado', 'Urgente']);
  assert.equal(sal.avisos.length, 1);
  // «Nunca si»
  repo.upsertConv({ id: 'c2', contact_id: 'k2', channel: 'whatsapp' });
  await e.poner('c2', interesado.id, 'manual');
  await e.poner('c2', compro.id, 'manual');
  assert.deepEqual(await e.alMensaje('c2', { autor: 'lead', texto: 'hoy' }), []);
  // A mano se pone siempre
  assert.equal((await e.poner('c2', urgente.id, 'manual')).puesta, true);
  // Quitar
  await e.quitar('c2', urgente.id);
  assert.deepEqual(sal.quitadas, ['Urgente']);
});

test('forzar respuesta y reanudar IA', async () => {
  const { db, repo, e } = montar();
  const reanudar = etq.crear(db, { nombre: 'Reanudar', acciones: { reanudar_ia: true, forzar_respuesta: true } });
  repo.updateConv('c1', { ai_paused: 1, derivado: 1, pause_reason: 'x' });
  await e.poner('c1', reanudar.id, 'manual');
  const c = repo.getConv('c1');
  assert.equal(c.ai_paused, 0);
  assert.equal(c.derivado, 0);
  assert.equal(c.respond_at, T0.toISOString());
});

test('inactividad: el lead no contesta a nuestro último mensaje en X horas', async () => {
  const { db, repo, e, avanzar } = montar();
  const sin = etq.crear(db, { nombre: 'No contesta', reglas: [{ tipo: 'inactividad', horas: 24 }], acciones: { forzar_respuesta: true } });
  repo.addMessage({ conversation_id: 'c1', autor: 'lead', texto: 'hola', created_at: T0.toISOString() });
  repo.addMessage({ conversation_id: 'c1', autor: 'ia', texto: 'qué tal', created_at: T0.toISOString() });
  assert.equal(await e.revisarInactividad(), 0);
  avanzar(25);
  assert.equal(await e.revisarInactividad(), 1);
  assert.equal(repo.getConv('c1').respond_at, null); // forzar no actúa con inactividad
  assert.equal(await e.revisarInactividad(), 0); // no se repite
  assert.equal(etq.deChats(db, ['c1']).c1[0].nombre, sin.nombre);
});

test('aplicar a chats de antes', async () => {
  const { db, repo, e } = montar();
  repo.upsertConv({ id: 'c2', contact_id: 'k2', channel: 'instagram' });
  repo.addMessage({ conversation_id: 'c1', autor: 'lead', texto: 'tengo una lesión de rodilla' });
  repo.addMessage({ conversation_id: 'c2', autor: 'lead', texto: 'hola' });
  const lesion = etq.crear(db, { nombre: 'Lesión', reglas: [{ tipo: 'texto', patron: 'lesion' }] });
  assert.deepEqual(await e.aplicarAAnteriores(lesion.id), { aplicadas: 1, revisados: 1 });
  assert.equal(etq.deChats(db, ['c1', 'c2']).c2, undefined);
});

test('Sofía: ve el catálogo con criterio IA y sus etiquetas se aplican con condiciones', async () => {
  const { db, repo, e } = montar();
  const compro = etq.crear(db, { nombre: 'Ha comprado' });
  etq.crear(db, { nombre: 'Interesado en Hyrox', criterio_ia: 'Pregunta por Hyrox o competir' });
  etq.crear(db, { nombre: 'Precio alto', criterio_ia: 'Dice que es caro', nunca_si: [compro.id] });
  etq.crear(db, { nombre: 'Solo manual' });
  const ctx = e.contextoIA('c1');
  assert.match(ctx, /Interesado en Hyrox.*Hyrox o competir/);
  assert.doesNotMatch(ctx, /Solo manual/);

  const cola = [[{ name: 'responder', input: { mensajes: ['hola'], fase: 'f2 diagnóstico', etiquetas: ['Interesado en Hyrox', 'solo manual', 'hot lead'], analisis: 'quiere competir', siguiente_paso: 'preguntar nivel' } }]];
  const tags = [];
  const setter = new Setter({
    repo, etiquetas: e, live: true, sleep: async () => {}, now: () => T0, random: () => 0,
    ghl: { sendMessage: async () => ({}), addTags: async (_, t) => tags.push(...t), removeTags: async () => {}, assign: async () => {}, addNote: async () => {} },
    complete: async (req) => {
      assert.match(req.system.at(-1).text, /Etiquetas que puedes poner/);
      return { content: cola.shift().map((b, i) => ({ type: 'tool_use', id: `t${i}`, ...b })), usage: {} };
    },
    aimharder: {},
  });
  repo.updateConv('c1', { tipo: 'captacion' });
  const r = await setter.responder('c1');
  assert.deepEqual(r.turno.etiquetas, ['Interesado en Hyrox']);
  assert.ok(tags.includes('hot lead')); // las que no son del catálogo siguen yendo a GHL
  assert.ok(!tags.includes('solo manual')); // del catálogo sin criterio IA: Sofía no la pone
  const c = repo.getConv('c1');
  assert.equal(c.analisis, 'quiere competir');
  assert.equal(c.siguiente_paso, 'preguntar nivel');
  // Ya la lleva: deja de ofrecérsela
  assert.doesNotMatch(e.contextoIA('c1'), /Interesado en Hyrox/);
  // «Nunca si»
  await e.poner('c1', compro.id, 'manual');
  assert.doesNotMatch(e.contextoIA('c1') || '', /Precio alto/);
});

test('filtros combinados: estado, etiquetas (alguna/todas/excluir), sede, canal, espera y búsqueda', async () => {
  const { db, repo, e } = montar();
  repo.upsertConv({ id: 'c2', contact_id: 'k2', channel: 'instagram', nombre: 'Bea' });
  repo.upsertConv({ id: 'c3', contact_id: 'k3', channel: 'whatsapp', nombre: 'Carla' });
  repo.upsertConv({ id: 'prueba-x', contact_id: 'p', channel: 'whatsapp' });
  repo.updateConv('c1', { sede: 'parla', fase: 'f5 cierre' });
  repo.updateConv('c2', { sede: 'getafe', ai_paused: 1 });
  repo.addMessage({ conversation_id: 'c1', autor: 'lead', texto: 'quiero apuntarme' });
  repo.addMessage({ conversation_id: 'c2', autor: 'lead', texto: 'hola' });
  repo.addMessage({ conversation_id: 'c2', autor: 'ia', texto: 'dime' });
  const a = etq.crear(db, { nombre: 'A' }); const b = etq.crear(db, { nombre: 'B' });
  await e.poner('c1', a.id); await e.poner('c1', b.id); await e.poner('c2', a.id);
  const ids = (crit) => conversaciones(db, { criterios: crit }).map((c) => c.id).sort();
  assert.deepEqual(ids({}), ['c1', 'c2', 'c3']);
  assert.deepEqual(ids({ etiquetas: [a.id, b.id] }), ['c1', 'c2']);
  assert.deepEqual(ids({ etiquetas: [a.id, b.id], modo: 'todas' }), ['c1']);
  assert.deepEqual(ids({ sin_etiquetas: [b.id] }), ['c2', 'c3']);
  assert.deepEqual(ids({ sin_ninguna: true }), ['c3']);
  assert.deepEqual(ids({ sede: ['parla', 'sin_sede'] }), ['c1', 'c3']);
  assert.deepEqual(ids({ canal: ['instagram'] }), ['c2']);
  assert.deepEqual(ids({ estado: ['pausadas'] }), ['c2']);
  assert.deepEqual(ids({ espera: 'equipo' }), ['c1']);
  assert.deepEqual(ids({ espera: 'lead' }), ['c2']);
  assert.deepEqual(ids({ fase: ['f5 cierre'] }), ['c1']);
  assert.deepEqual(ids({ q: 'apuntarme' }), ['c1']);
  assert.deepEqual(conversaciones(db, { criterios: JSON.stringify({ canal: 'instagram' }) }).map((c) => c.id), ['c2']);
  assert.equal(conversaciones(db, { criterios: {} }).find((c) => c.id === 'c1').etiquetas.length, 2);
  assert.deepEqual(limpiarCriterios({ estado: ['nada'], sede: [] }), {});
  assert.doesNotThrow(() => filtrosSql({ fase: ["x'; DROP TABLE conversations;--"] }));
  assert.ok(db.prepare('SELECT count(*) n FROM conversations').get().n > 0);

  // Vistas guardadas con contador
  const id = guardarVista(db, { nombre: 'Parla con A', criterios: { sede: ['parla'], etiquetas: [a.id] } });
  const v = vistas(db).find((x) => x.id === id);
  assert.equal(v.total, 1);
  assert.equal(vistas(db).find((x) => x.id === 'todos').total, 3);
  assert.deepEqual(conversaciones(db, { vista: String(id) }).map((c) => c.id), ['c1']);
  // Borrar la etiqueta la quita de las vistas
  etq.borrar(db, a.id);
  assert.deepEqual(vistas(db).find((x) => x.id === id).criterios, { sede: ['parla'] });
});
