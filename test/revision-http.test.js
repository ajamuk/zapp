// Revisión de HTTP y operación (noviembre de 2026): cada test cubre un arreglo de server.js, probar.js, panel.js,
// actividad.js, archivos.js o arranque.js. Datos ficticios; sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { openDb, repo as crearRepo } from '../src/db.js';
import { config } from '../src/config.js';
import { crearApp } from '../src/server.js';
import { esRutaDeSubida } from '../src/probar.js';
import { enSegundoPlano, hayTrabajo } from '../src/arranque.js';
import * as panel from '../src/panel.js';
import * as archivos from '../src/archivos.js';
import * as recursos from '../src/recursos.js';

const CLAVE = 'clave-de-revision-http';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rev-http-'));
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

async function servidor(opciones = {}) {
  config.adminToken = CLAVE;
  const repo = opciones.repo || crearRepo(openDb(':memory:'));
  const srv = crearApp({ setter: {}, repo, ...opciones }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const api = (ruta, o = {}) => fetch(base + '/admin' + ruta, { ...o, headers: { authorization: `Bearer ${CLAVE}`, 'content-type': 'application/json', ...(o.headers || {}) } });
  return { repo, srv, base, api };
}

test('subidas: el cuerpo grande solo se lee en las tres rutas de subida y después de la clave', async () => {
  assert.ok(esRutaDeSubida('/admin/panel/recursos/adjunto'));
  assert.ok(esRutaDeSubida('/admin/panel/conversaciones/c1/adjunto'));
  assert.ok(esRutaDeSubida('/metrotools/api/probar/conversaciones/prueba-1/adjunto'));
  assert.ok(!esRutaDeSubida('/webhooks/ghl/adjunto'));
  assert.ok(!esRutaDeSubida('/cualquier/cosa/adjunto'));
  const dir = tmp();
  const { srv, base, api, repo } = await servidor({ medios: { base: dir } });
  repo.upsertConv({ id: 'c1', contact_id: 'k1', channel: 'whatsapp' });
  const sinClave = (ruta, cuerpo) => fetch(base + ruta, { method: 'POST', headers: { 'content-type': 'application/json' }, body: cuerpo });
  try {
    // Sin clave no se lee el cuerpo: un JSON roto da 401/403/404, no «Petición mal formada»
    assert.equal((await sinClave('/admin/panel/conversaciones/c1/adjunto', '{roto')).status, 401);
    assert.equal((await sinClave('/admin/panel/recursos/adjunto', '{roto')).status, 401);
    assert.equal((await sinClave('/metrotools/api/panel/recursos/adjunto', '{roto')).status, 403);
    // Otra ruta que acabe en /adjunto ya no tiene 36 MB: le toca el límite normal de 1 MB
    assert.equal((await sinClave('/cualquier/cosa/adjunto', JSON.stringify({ x: 'x'.repeat(1.5 * 1024 * 1024) }))).status, 413);
    // Con clave, la subida admite más de 1 MB…
    const grande = Buffer.concat([PNG, Buffer.alloc(1.5 * 1024 * 1024)]).toString('base64');
    const r = await api('/panel/recursos/adjunto', { method: 'POST', body: JSON.stringify({ nombre: 'Horario', descripcion: 'horario de clases', mime: 'image/png', archivo: 'h.png', datos: grande }) });
    assert.equal(r.status, 201);
    // …y el resto de rutas sigue con el límite de 1 MB
    const otra = await api('/panel/vistas', { method: 'POST', body: JSON.stringify({ nombre: 'v', relleno: 'x'.repeat(1.5 * 1024 * 1024) }) });
    assert.equal(otra.status, 413);
  } finally { srv.close(); }
});

test('/health: con un 503 dice cuántas respuestas van atrasadas y por qué', async () => {
  let s = { ok: false, bucles_parados: [], respuestas_atrasadas: 3 };
  const { srv, base } = await servidor({ salud: () => s });
  try {
    const r = await fetch(base + '/health');
    assert.equal(r.status, 503);
    const b = await r.json();
    assert.equal(b.respuestas_atrasadas, 3);
    assert.deepEqual(b.bucles_parados, []);
    assert.match(b.motivo, /3 respuestas llevan más de 5 minutos/);
    s = { ok: false, bucles_parados: ['respuestas'], respuestas_atrasadas: 0 };
    assert.match((await (await fetch(base + '/health')).json()).motivo, /tareas paradas: respuestas/);
    s = { ok: true, bucles_parados: [], respuestas_atrasadas: 0 };
    const ok = await fetch(base + '/health');
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, modo: config.mode, respuestas_atrasadas: 0 });
  } finally { srv.close(); }
});

test('exportar a CSV: un \\r suelto no abre una fila nueva que empiece por «=»', () => {
  const repo = crearRepo(openDb(':memory:'));
  repo.upsertConv({ id: 'c1', contact_id: 'k1', channel: 'whatsapp', nombre: '  =HYPERLINK(1)', telefono: '+34600111222' });
  repo.addMessage({ conversation_id: 'c1', autor: 'lead', texto: 'hola\r=1+1' });
  repo.addMessage({ conversation_id: 'c1', autor: 'lead', texto: 'uno\u2028@SUM(1)' });
  for (const csv of [panel.exportar(repo.db, {}), panel.exportar(repo.db, { formato: 'mensajes' })]) {
    assert.doesNotMatch(csv, /\r(?!\n)/, 'sin \\r sueltos');
    for (const fila of csv.split('\r\n')) assert.doesNotMatch(fila, /^[=+@]/);
    assert.match(csv, /;'  =HYPERLINK\(1\);/);
  }
  const mensajes = panel.exportar(repo.db, { formato: 'mensajes' });
  assert.match(mensajes, /;hola =1\+1;/);
  assert.match(mensajes, /;uno @SUM\(1\);/);
  assert.match(panel.exportar(repo.db, {}), /;\+34600111222;/); // el teléfono no se toca
});

test('panel: el JSON grande se comprime sin gzipSync (no para el servicio mientras comprime)', async () => {
  const repo = crearRepo(openDb(':memory:'));
  for (let i = 0; i < 40; i++) repo.upsertConv({ id: `g${i}`, contact_id: `kg${i}`, channel: 'whatsapp', nombre: `Lead ficticio ${i}` });
  const { srv, base } = await servidor({ repo });
  const original = zlib.gzipSync; let llamadas = 0;
  zlib.gzipSync = (...a) => { llamadas++; return original(...a); };
  try {
    const r = await fetch(base + '/admin/panel/conversaciones', { headers: { authorization: `Bearer ${CLAVE}`, 'accept-encoding': 'gzip' } });
    assert.equal(r.headers.get('content-encoding'), 'gzip');
    assert.equal((await r.json()).length, 40);
    assert.equal(llamadas, 0);
  } finally { zlib.gzipSync = original; srv.close(); }
});

test('actividad: el usuario de MetroTools solo cuenta por /metrotools; por /admin es la clave', async () => {
  const { srv, base, api } = await servidor();
  const metro = (ruta, o = {}) => fetch(base + '/metrotools/api' + ruta, { ...o, headers: { authorization: `Bearer ${CLAVE}`, 'x-cfmpo-admin': '1', 'x-metrotools-client': 'zapp', 'content-type': 'application/json', ...(o.headers || {}) } });
  try {
    await api('/panel/vistas', { method: 'POST', headers: { 'x-cfmpo-user': 'suplantada@ejemplo.test' }, body: JSON.stringify({ nombre: 'Por admin' }) });
    await metro('/panel/vistas', { method: 'POST', headers: { 'x-cfmpo-user': 'carlos' }, body: JSON.stringify({ nombre: 'Por MetroTools' }) });
    await metro('/panel/vistas', { method: 'POST', body: JSON.stringify({ nombre: 'Sin usuario' }) });
    await espera(20);
    const a = await (await api('/panel/actividad')).json();
    assert.deepEqual(a.actividad.map((x) => [x.quien, x.accion]).reverse(), [
      ['clave de administración', 'Creó la vista «Por admin»'], ['carlos', 'Creó la vista «Por MetroTools»'], ['MetroTools', 'Creó la vista «Sin usuario»']]);
  } finally { srv.close(); }
});

test('errores: un fallo del disco o de ffmpeg no enseña rutas del servidor', async () => {
  const { srv, api } = await servidor({ medios: { base: '/dev/null/medios' } });
  try {
    const r = await api('/panel/recursos/adjunto', { method: 'POST', body: JSON.stringify({ nombre: 'n', descripcion: 'd', mime: 'application/pdf', archivo: 'a.pdf', datos: Buffer.from('%PDF-1').toString('base64') }) });
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { error: 'Ha habido un error interno. Inténtalo otra vez.' });
  } finally { srv.close(); }
  const db = openDb(':memory:');
  await assert.rejects(archivos.subir(db, { mime: 'audio/webm', archivo: 'nota.webm', datos: Buffer.from('webm').toString('base64') }, {
    base: tmp(), convertir: async () => { throw new Error('ffmpeg: /ruta/secreta/2026-11/x.webm: Invalid data'); } }),
  (e) => /No se ha podido preparar el audio/.test(e.message) && !/ruta\/secreta/.test(e.message));
});

test('/r/: los archivos públicos salen con caché pública; un 404 no se guarda', async () => {
  const dir = tmp();
  const repo = crearRepo(openDb(':memory:'));
  const rec = recursos.crear(repo.db, { nombre: 'Foto', descripcion: 'foto del box', mime: 'image/png', archivo: 'f.png', datos: PNG.toString('base64') }, { base: dir });
  const sinArchivo = recursos.crear(repo.db, { nombre: 'Borrada', descripcion: 'ya no está', mime: 'image/png', archivo: 'b.png', datos: PNG.toString('base64') }, { base: dir });
  fs.rmSync(path.join(dir, sinArchivo.media_ruta));
  const { srv, base } = await servidor({ repo, medios: { base: dir } });
  try {
    const r = await fetch(`${base}/r/${rec.token}.png`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=3600');
    const no = await fetch(`${base}/r/${sinArchivo.token}.png`);
    assert.equal(no.status, 404);
    assert.notEqual(no.headers.get('cache-control'), 'public, max-age=3600');
  } finally { srv.close(); }
});

test('apagado: espera también a los trabajos en segundo plano (contestar preguntas)', async () => {
  assert.equal(hayTrabajo({}), false);
  let fin; const p = enSegundoPlano(new Promise((r) => { fin = r; }));
  assert.equal(hayTrabajo({}), true);
  fin(); await p; await espera(0);
  assert.equal(hayTrabajo({}), false);
  await enSegundoPlano(Promise.reject(new Error('falló'))).catch(() => {});
  await espera(0);
  assert.equal(hayTrabajo({}), false);
  assert.equal(hayTrabajo({ enCurso: new Set(['c1']) }), true);
});

test('Probar IA: el archivo se guarda solo si la prueba existe y hay modelo', async () => {
  const dir = tmp();
  const pruebas = crearRepo(openDb(':memory:'));
  const clave = config.ai.apiKey; config.ai.apiKey = '';
  const subir = (api, id) => api(`/probar/conversaciones/${id}/adjunto`, { method: 'POST', body: JSON.stringify({ datos: PNG.toString('base64'), mime: 'image/png', nombre: 'foto.png' }) });
  const archivosEn = (d) => fs.readdirSync(d, { recursive: true }).filter((f) => fs.statSync(path.join(d, f)).isFile());
  let s = await servidor({ pruebas, medios: { base: dir } }); // sin modelo
  try {
    assert.equal((await subir(s.api, 'prueba-noexiste')).status, 404);
    const c = await (await s.api('/probar/conversaciones', { method: 'POST', body: JSON.stringify({ canal: 'whatsapp' }) })).json();
    assert.equal((await subir(s.api, c.conv.id)).status, 503);
    assert.deepEqual(archivosEn(dir), []);
    s.srv.close();
    // Con modelo, la subida sigue funcionando: se guarda la imagen y Sofía contesta
    const complete = async () => ({ content: [{ type: 'tool_use', id: 't', name: 'responder', input: { mensajes: ['qué foto más chula'], fase: 'f2 diagnóstico' } }] });
    s = await servidor({ pruebas, medios: { base: dir }, complete });
    const r = await subir(s.api, c.conv.id);
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.ok(d.mensajes.some((m) => m.autor === 'lead' && m.tiene_medio));
    assert.equal(archivosEn(dir).length, 1);
  } finally { config.ai.apiKey = clave; s.srv.close(); }
});

test('/panel/estado lleva el perfil del negocio y la zona horaria', async () => {
  const { srv, api } = await servidor();
  try {
    const e = await (await api('/panel/estado')).json();
    assert.deepEqual(e.negocio, { nombre: config.negocio.nombre, asistente: config.negocio.asistente });
    assert.deepEqual(e.nombresSede, Object.fromEntries(config.negocio.sedes.map((x) => [x.id, x.nombre])));
    assert.equal(e.tz, config.tz);
  } finally { srv.close(); }
});
