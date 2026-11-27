import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import { procesarSeguimientos, programarManual, editarManual } from '../src/followups.js';
import * as archivos from '../src/archivos.js';
import { crearApp } from '../src/server.js';
import { config } from '../src/config.js';

config.adminToken = 'clave-test';

const T0 = new Date('2026-11-17T11:00:00Z'); // martes 12:00 en Madrid
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zapp-arch-'));

function montar() {
  const repo = crearRepo(openDb(':memory:'));
  const base = tmp();
  const sal = { textos: [], adjuntos: [], plantillas: [] };
  let reloj = new Date(T0);
  const setter = new Setter({
    repo, live: true, sleep: async () => {}, now: () => reloj, random: () => 0,
    ghl: {
      sendMessage: async ({ texto }) => { sal.textos.push(texto); return { messageId: `t${sal.textos.length}` }; },
      enviarAdjunto: async (a) => { sal.adjuntos.push(a); return { messageId: `a${sal.adjuntos.length}` }; },
      enviarPorPlantilla: async ({ texto }) => { sal.plantillas.push(texto); return { messageId: null }; },
      addTags: async () => {}, removeTags: async () => {}, assign: async () => {}, addNote: async () => {}, getContact: async () => ({ contact: {} }),
    },
    aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: false }) },
    complete: async () => { throw new Error('no debería llamar a la IA'); },
  });
  repo.upsertConv({ id: 'c1', contact_id: 'k1', channel: 'whatsapp', nombre: 'Ana' });
  repo.updateConv('c1', { last_inbound_at: new Date(T0.getTime() - 3600e3).toISOString() });
  return { repo, setter, sal, base, avanzar: (ms) => { reloj = new Date(reloj.getTime() + ms); }, ahora: () => reloj };
}
const subirPng = (repo, base) => archivos.subir(repo.db, { datos: PNG.toString('base64'), mime: 'image/png', archivo: 'horario.png' }, { base });

test('archivos del equipo: formato, tamaño y conversión del audio grabado', async () => {
  const repo = crearRepo(openDb(':memory:')); const base = tmp();
  const a = await subirPng(repo, base);
  assert.equal(a.tipo, 'imagen');
  assert.match(archivos.urlPublica(a), /\/r\/eq_[\w-]{24}\.png$/);
  assert.equal(archivos.porCodigo(repo.db, `eq_${a.token}`).id, a.id);
  assert.equal(archivos.porCodigo(repo.db, 'eq_otro'), null);
  await assert.rejects(archivos.subir(repo.db, { datos: 'AAAA', mime: 'application/zip', archivo: 'x.zip' }, { base }), /Formato no admitido/);
  await assert.rejects(archivos.subir(repo.db, { datos: Buffer.alloc(6 * 1024 * 1024).toString('base64'), mime: 'image/jpeg', archivo: 'g.jpg' }, { base }), /más de 5 MB/);
  const llamadas = [];
  const convertir = async (args) => { llamadas.push(args); fs.writeFileSync(args.at(-1), 'OggS'); };
  const v = await archivos.subir(repo.db, { datos: Buffer.from('webm').toString('base64'), mime: 'audio/webm;codecs=opus', archivo: 'nota-de-voz.webm' }, { base, convertir });
  assert.equal(v.mime, 'audio/ogg'); assert.equal(v.tipo, 'audio'); assert.match(v.media_ruta, /\.ogg$/);
  assert.ok(llamadas[0].includes('libopus'));
});

test('enviar un archivo desde el panel: sale con su pie, queda en el chat y aparta a Sofía', async () => {
  const { repo, setter, sal, base } = montar();
  const a = await subirPng(repo, base);
  const r = await setter.enviarArchivoDelEquipo('c1', a.id, 'te dejo el horario');
  assert.equal(sal.adjuntos.length, 1);
  assert.equal(sal.adjuntos[0].texto, 'te dejo el horario');
  assert.equal(sal.adjuntos[0].mime, 'image/png');
  const m = repo.db.prepare("SELECT * FROM messages WHERE conversation_id = 'c1' ORDER BY id DESC").get();
  assert.equal(m.autor, 'humano'); assert.equal(m.adjunto, 'imagen'); assert.equal(m.media_ruta, a.media_ruta); assert.equal(m.external_id, 'a1');
  assert.equal(r.pausada, true);
});

test('un audio con texto: el texto sale antes en su propio mensaje (WhatsApp no pone pie a los audios)', async () => {
  const { repo, setter, sal, base } = montar();
  const a = await archivos.subir(repo.db, { datos: Buffer.from('ID3').toString('base64'), mime: 'audio/mpeg', archivo: 'saludo.mp3' }, { base });
  await setter.enviarArchivoDelEquipo('c1', a.id, 'escucha esto');
  assert.deepEqual(sal.textos, ['escucha esto']);
  assert.equal(sal.adjuntos[0].texto, '');
});

test('fuera de las 24 h no se puede enviar un archivo desde el panel', async () => {
  const { repo, setter, base, avanzar } = montar();
  const a = await subirPng(repo, base);
  avanzar(24 * 3600e3);
  await assert.rejects(setter.enviarArchivoDelEquipo('c1', a.id, ''), /más de 24 h/);
});

test('mensaje programado: se edita (texto, hora y archivo) antes de salir y sale lo editado', async () => {
  const { repo, setter, sal, base, avanzar, ahora } = montar();
  const id = programarManual(repo, 'c1', 'hola ana, te escribo mañna', new Date(T0.getTime() + 2 * 3600e3).toISOString(), ahora());
  const a = await subirPng(repo, base);
  assert.ok(editarManual(repo, id, { texto: 'hola ana, te paso el horario', cuando: new Date(T0.getTime() + 3600e3).toISOString(), archivo: a.id }, ahora()));
  avanzar(3600e3 + 1000);
  await procesarSeguimientos(setter);
  assert.equal(sal.adjuntos.length, 1);
  assert.equal(sal.adjuntos[0].texto, 'hola ana, te paso el horario');
  assert.equal(sal.textos.length, 0);
  const s = repo.db.prepare('SELECT estado, detalle FROM scheduled WHERE id = ?').get(id);
  assert.deepEqual([s.estado, s.detalle], ['enviado', 'con imagen']);
  assert.equal(repo.db.prepare("SELECT adjunto FROM messages WHERE external_id = 'a1'").get().adjunto, 'imagen');
  // Ya enviado: no se puede cambiar
  assert.equal(editarManual(repo, id, { texto: 'otro', cuando: new Date(ahora().getTime() + 3600e3).toISOString() }, ahora()), false);
});

test('mensaje programado: validaciones (vacío, pasado, archivo fuera de las 24 h) y quitar el archivo', async () => {
  const { repo, base, ahora } = montar();
  const a = await subirPng(repo, base);
  assert.throws(() => programarManual(repo, 'c1', '  ', new Date(T0.getTime() + 3600e3).toISOString(), ahora()), /Escribe el mensaje o adjunta/);
  assert.throws(() => programarManual(repo, 'c1', 'hola', new Date(T0.getTime() - 3600e3).toISOString(), ahora()), /ya ha pasado/);
  assert.throws(() => programarManual(repo, 'c1', '', new Date(T0.getTime() + 30 * 3600e3).toISOString(), ahora(), { archivo: a.id }), /más de 24 h/);
  const id = programarManual(repo, 'c1', '', new Date(T0.getTime() + 3600e3).toISOString(), ahora(), { archivo: a.id });
  assert.throws(() => editarManual(repo, id, { texto: '', cuando: new Date(T0.getTime() + 3600e3).toISOString(), archivo: null }, ahora()), /Escribe el mensaje o adjunta/);
  assert.ok(editarManual(repo, id, { texto: 'al final solo texto', cuando: new Date(T0.getTime() + 3600e3).toISOString(), archivo: null }, ahora()));
  assert.equal(repo.db.prepare('SELECT contexto FROM scheduled WHERE id = ?').get(id).contexto, null);
});

test('mensaje programado con archivo que vence fuera de las 24 h: sale solo el texto por plantilla', async () => {
  const { repo, setter, sal, base, avanzar, ahora } = montar();
  const a = await subirPng(repo, base);
  const id = programarManual(repo, 'c1', 'te paso el horario', new Date(T0.getTime() + 3600e3).toISOString(), ahora(), { archivo: a.id });
  repo.updateConv('c1', { last_inbound_at: new Date(T0.getTime() - 23.5 * 3600e3).toISOString() }); // la ventana se cierra antes de que salga
  avanzar(3600e3 + 1000);
  await procesarSeguimientos(setter);
  assert.equal(sal.adjuntos.length, 0);
  const s = repo.db.prepare('SELECT estado, detalle FROM scheduled WHERE id = ?').get(id);
  assert.deepEqual(sal.plantillas, ['te paso el horario']);
  assert.deepEqual([s.estado, s.detalle], ['enviado', 'plantilla · sin el archivo (fuera de las 24 h)']);
});

test('API: subir, enviar con archivo, programar, editar y la URL pública del archivo', async () => {
  const { repo, setter, sal } = montar();
  const srv = crearApp({ setter, repo, medios: { base: tmp() } }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const api = (ruta, o = {}) => fetch(base + ruta, { ...o, headers: { authorization: 'Bearer clave-test', 'content-type': 'application/json' } });
  try {
    const sub = await api('/admin/panel/conversaciones/c1/adjunto', { method: 'POST', body: JSON.stringify({ datos: PNG.toString('base64'), mime: 'image/png', archivo: 'horario.png' }) });
    assert.equal(sub.status, 201);
    const a = await sub.json();
    assert.deepEqual(Object.keys(a).sort(), ['id', 'mime', 'nombre', 'tamano', 'tipo']);
    const env = await api('/admin/panel/conversaciones/c1/enviar', { method: 'POST', body: JSON.stringify({ texto: '', archivo: a.id }) });
    assert.equal(env.status, 200);
    assert.equal(sal.adjuntos.length, 1);
    const pub = await fetch(sal.adjuntos[0].url.replace(/^https?:\/\/[^/]+/, base));
    assert.equal(pub.status, 200); assert.equal(pub.headers.get('content-type'), 'image/png');
    assert.equal((await fetch(`${base}/r/eq_nonono0000000000000000000.png`)).status, 404);
    const cuando = new Date(Date.now() + 3600e3).toISOString();
    repo.updateConv('c1', { last_inbound_at: new Date().toISOString() });
    const p = await api('/admin/panel/conversaciones/c1/programar', { method: 'POST', body: JSON.stringify({ texto: 'hola', cuando, archivo: a.id }) });
    assert.equal(p.status, 201);
    const { id } = await p.json();
    const det = await (await api('/admin/panel/conversaciones/c1')).json();
    assert.equal(det.seguimientos.find((x) => x.id === id).archivo.nombre, 'horario.png');
    const ed = await api(`/admin/panel/seguimientos/${id}`, { method: 'PUT', body: JSON.stringify({ texto: 'hola, corregido', cuando, archivo: null }) });
    assert.equal(ed.status, 200);
    assert.equal(repo.db.prepare('SELECT texto_previsto FROM scheduled WHERE id = ?').get(id).texto_previsto, 'hola, corregido');
    repo.db.prepare("UPDATE scheduled SET estado = 'cancelado' WHERE id = ?").run(id);
    assert.equal((await api(`/admin/panel/seguimientos/${id}`, { method: 'PUT', body: JSON.stringify({ texto: 'x', cuando }) })).status, 409);
  } finally { srv.close(); }
});

// ---------- Plantillas de WhatsApp ----------
import * as plantillasWa from '../src/plantillas.js';
import { Ghl } from '../src/ghl.js';

const PLANTILLA = { nombre: 'sofia_seguimiento_v1', idioma: 'es', categoria: 'MARKETING', cuerpo: 'hola {{1}}, {{2}}' };

test('plantillas: catálogo con validación y variables', () => {
  const repo = crearRepo(openDb(':memory:'));
  const p = plantillasWa.crear(repo.db, PLANTILLA);
  assert.equal(p.variables, 2); assert.equal(p.activa, true);
  assert.throws(() => plantillasWa.crear(repo.db, PLANTILLA), /Ya hay una plantilla/);
  assert.throws(() => plantillasWa.crear(repo.db, { ...PLANTILLA, nombre: 'Con Mayúsculas' }), /minúsculas/);
  assert.throws(() => plantillasWa.crear(repo.db, { ...PLANTILLA, nombre: 'otra', idioma: 'español' }), /Idioma/);
  assert.throws(() => plantillasWa.crear(repo.db, { ...PLANTILLA, nombre: 'otra', cuerpo: 'hola {{2}}' }), /Falta la variable \{\{1\}\}/);
  assert.equal(plantillasWa.actualizar(repo.db, p.id, { activa: false }).activa, false);
  assert.throws(() => plantillasWa.prepararEnvio(repo.db, p.id, ['ana', 'x']), /desactivada/);
  plantillasWa.actualizar(repo.db, p.id, { activa: true });
  assert.throws(() => plantillasWa.prepararEnvio(repo.db, p.id, ['ana']), /Rellena la variable \{\{2\}\}/);
  const env = plantillasWa.prepararEnvio(repo.db, p.id, ['ana', 'te escribo\npor lo de parla']);
  assert.deepEqual(env.variables, ['ana', 'te escribo por lo de parla']);
  assert.equal(env.texto, 'hola ana, te escribo por lo de parla');
});

test('plantillas: el cuerpo que se manda a GHL (formato de la bandeja, número propio)', async () => {
  const peticiones = [];
  const ghl = new Ghl({ token: 't', baseUrl: 'https://ghl.test', aislamiento: { modo: 'activo', numero: '+34600000099' }, fetchImpl: async (url, o) => { peticiones.push({ url, body: JSON.parse(o.body) }); return new Response(JSON.stringify({ messageId: 'm1' }), { status: 200 }); } });
  const r = await ghl.enviarPlantillaWa({ contactId: 'k1', nombre: 'sofia_seguimiento_v1', idioma: 'es', categoria: 'MARKETING', variables: ['ana'], texto: 'hola ana' });
  assert.equal(r.messageId, 'm1');
  assert.equal(peticiones[0].url, 'https://ghl.test/conversations/messages');
  assert.deepEqual(peticiones[0].body, { type: 'WhatsApp', contactId: 'k1', message: 'hola ana', fromNumber: '+34600000099',
    whatsapp: { type: 'template', template: { name: 'sofia_seguimiento_v1', lang: 'es', category: 'MARKETING' }, placeholders: { header: [], body: ['ana'], buttons: [] } } });
});

test('plantillas: se envían desde el panel aunque hayan pasado 24 h, y también programadas y editadas', async () => {
  const { repo, setter, sal, avanzar, ahora } = montar();
  const enviadas = [];
  setter.ghl.enviarPlantillaWa = async (x) => { enviadas.push(x); return { messageId: `p${enviadas.length}` }; };
  const p = plantillasWa.crear(repo.db, PLANTILLA);
  avanzar(30 * 3600e3); // fuera de la ventana
  assert.match(setter.motivoNoEscribir(repo.getConv('c1')), /plantilla de WhatsApp/);
  assert.equal(setter.motivoNoPlantilla(repo.getConv('c1')), '');
  await setter.enviarPlantillaDelEquipo('c1', p.id, ['ana', 'qué tal']);
  assert.equal(enviadas[0].texto, 'hola ana, qué tal');
  const m = repo.db.prepare("SELECT * FROM messages WHERE external_id = 'p1'").get();
  assert.deepEqual([m.autor, m.tipo, m.texto], ['humano', 'plantilla', 'hola ana, qué tal']);
  await assert.rejects(setter.enviarPlantillaDelEquipo('c1', p.id, ['ana']), /Rellena la variable/);
  // Programada y corregida antes de salir
  const id = programarManual(repo, 'c1', '', new Date(ahora().getTime() + 3600e3).toISOString(), ahora(), { plantilla: p.id, variables: ['ana', 'te escribo mañna'] });
  assert.ok(editarManual(repo, id, { cuando: new Date(ahora().getTime() + 1800e3).toISOString(), plantilla: p.id, variables: ['ana', 'te escribo mañana'] }, ahora()));
  avanzar(1800e3 + 1000);
  await procesarSeguimientos(setter);
  assert.equal(enviadas[1].texto, 'hola ana, te escribo mañana');
  assert.equal(sal.plantillas.length, 0); // no usa el workflow
  assert.deepEqual(Object.values(repo.db.prepare('SELECT estado, detalle FROM scheduled WHERE id = ?').get(id)), ['enviado', 'plantilla sofia_seguimiento_v1']);
});

test('plantillas: API (catálogo, envío y lo que ve el chat)', async () => {
  const { repo, setter } = montar();
  const enviadas = [];
  setter.ghl.enviarPlantillaWa = async (x) => { enviadas.push(x); return { messageId: `p${enviadas.length}` }; };
  const srv = crearApp({ setter, repo, medios: { base: tmp() } }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const api = (ruta, o = {}) => fetch(base + ruta, { ...o, headers: { authorization: 'Bearer clave-test', 'content-type': 'application/json' } });
  try {
    const c = await api('/admin/panel/plantillas', { method: 'POST', body: JSON.stringify(PLANTILLA) });
    assert.equal(c.status, 201);
    const p = await c.json();
    assert.equal((await api('/admin/panel/plantillas', { method: 'POST', body: JSON.stringify({ ...PLANTILLA, nombre: 'mal nombre' }) })).status, 400);
    const det = await (await api('/admin/panel/conversaciones/c1')).json();
    assert.equal(det.plantillas.motivo, '');
    assert.deepEqual(det.plantillas.lista.map((x) => x.nombre), ['sofia_seguimiento_v1']);
    assert.equal((await api('/admin/panel/conversaciones/c1/plantilla', { method: 'POST', body: JSON.stringify({ plantilla: p.id, variables: ['ana', 'hola'] }) })).status, 200);
    assert.equal(enviadas.length, 1);
    assert.equal((await api('/admin/panel/conversaciones/c1/plantilla', { method: 'POST', body: JSON.stringify({ plantilla: p.id, variables: [] }) })).status, 409);
    setter.ghl.enviarPlantillaWa = async () => { throw new Error('GHL POST /conversations/messages → 400: template name does not exist'); };
    const err = await api('/admin/panel/conversaciones/c1/plantilla', { method: 'POST', body: JSON.stringify({ plantilla: p.id, variables: ['ana', 'hola'] }) });
    assert.equal(err.status, 502); assert.match((await err.json()).error, /template name does not exist/);
    assert.equal((await api(`/admin/panel/plantillas/${p.id}`, { method: 'DELETE' })).status, 200);
  } finally { srv.close(); }
});
