import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import * as medios from '../src/medios.js';
import { config } from '../src/config.js';
import { crearApp } from '../src/server.js';

const T0 = new Date('2026-11-17T11:00:00Z');
const base = () => fs.mkdtempSync(path.join(os.tmpdir(), 'medios-'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('tipo de adjunto por content-type o extensión', () => {
  assert.equal(medios.tipoDe('audio/ogg'), 'audio');
  assert.equal(medios.tipoDe('', 'https://x/y/IMG_1.JPG?alt=media'), 'imagen');
  assert.equal(medios.tipoDe('application/pdf', 'x.pdf'), 'documento');
});

test('descarga: reintenta con el token de GHL si pide autenticación', async () => {
  const pedidas = [];
  const fetchImpl = async (url, { headers }) => {
    pedidas.push(headers.Authorization || 'sin');
    if (!headers.Authorization) return { ok: false, status: 403, headers: new Headers() };
    return { ok: true, status: 200, headers: new Headers({ 'content-type': 'audio/ogg; codecs=opus' }), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  const r = await medios.descargar('https://x/a.ogg', { fetchImpl, token: 'tk' });
  assert.deepEqual(pedidas, ['sin', 'Bearer tk']);
  assert.equal(r.mime, 'audio/ogg');
  assert.equal(r.buffer.length, 3);
});

test('procesar adjuntos: guarda el audio y lo transcribe (una cola)', async () => {
  const b = base();
  const r = await medios.procesarAdjuntos(['https://x/nota.ogg'], {
    base: b,
    descargarImpl: async () => ({ buffer: Buffer.from('audio'), mime: 'audio/ogg' }),
    transcribirImpl: async (ruta) => { assert.ok(fs.existsSync(ruta)); return 'quiero apuntarme en parla'; },
  });
  assert.equal(r.adjunto, 'audio');
  assert.equal(r.transcripcion, 'quiero apuntarme en parla');
  assert.match(r.media_ruta, /^\d{4}-\d{2}\/.+\.ogg$/);
  const fallo = await medios.procesarAdjuntos(['https://x/foto.jpg'], { base: b, descargarImpl: async () => { throw new Error('descarga 404'); } });
  assert.equal(fallo.adjunto, 'imagen');
  assert.equal(fallo.media_error, 'descarga 404');
});

test('transcribir: usa faster-whisper y, si falla, el transcriptor de reserva', async () => {
  const llamadas = [];
  const viejo = { ...config.media };
  config.media.python = process.execPath; config.media.reserva = process.execPath;
  try {
    const t = await medios.transcribir('/tmp/a.ogg', { ejecutarImpl: async (cmd, args) => { llamadas.push(args[0]); if (args[0] === '-I') throw new Error('sin modelo'); return 'hola'; } });
    assert.equal(t, 'hola');
    assert.deepEqual(llamadas, ['-I', '/tmp/a.ogg']);
  } finally { Object.assign(config.media, viejo); }
});

test('Sofía oye la nota de voz y ve la imagen', async () => {
  const repo = crearRepo(openDb(':memory:'));
  const b = base();
  fs.mkdirSync(path.join(b, 'm'), { recursive: true });
  fs.writeFileSync(path.join(b, 'm', 'foto.png'), PNG);
  let n = 0;
  const fake = {
    procesarAdjuntos: async (adj) => (String(adj[0]).endsWith('.ogg')
      ? { adjunto: 'audio', media_ruta: 'm/nota.ogg', media_mime: 'audio/ogg', transcripcion: 'hola, tengo una lesión de hombro', media_error: null }
      : { adjunto: 'imagen', media_ruta: 'm/foto.png', media_mime: 'image/png', transcripcion: null, media_error: null }),
    imagenParaModelo: async (ruta) => ({ data: fs.readFileSync(path.join(b, ruta)).toString('base64'), media_type: 'image/png' }),
  };
  const peticiones = [];
  const setter = new Setter({
    repo, medios: fake, live: true, sleep: async () => {}, now: () => T0, random: () => 0,
    ghl: { sendMessage: async () => ({}), addTags: async () => {}, removeTags: async () => {}, assign: async () => {}, addNote: async () => {}, getContact: async () => ({ contact: {} }) },
    aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: false }) },
    complete: async (req) => { peticiones.push(req); n++; return { content: [{ type: 'tool_use', id: 't', name: 'responder', input: { mensajes: ['vale'], fase: 'f2 diagnóstico' } }] }; },
  });
  await setter.onInbound({ conversationId: 'c1', contactId: 'k1', canal: 'whatsapp', texto: '', messageId: 'a1', adjuntos: ['https://x/nota.ogg'], telefono: '+34600000000' });
  await setter.onInbound({ conversationId: 'c1', contactId: 'k1', canal: 'whatsapp', texto: 'mira mi horario', messageId: 'a2', adjuntos: ['https://x/horario.png'] });
  const guardado = repo.history('c1');
  assert.equal(guardado[0].transcripcion, 'hola, tengo una lesión de hombro');
  assert.equal(guardado[0].texto, '[audio]');
  assert.equal(guardado[1].media_ruta, 'm/foto.png');
  await setter.responder('c1');
  const user = peticiones[0].messages[0];
  assert.equal(user.role, 'user');
  assert.match(user.content[0].text, /nota de voz.*lesión de hombro/);
  assert.equal(user.content[1].type, 'image');
  assert.equal(user.content[1].source.media_type, 'image/png');
  assert.ok(user.content.some((x) => x.text === 'mira mi horario'));
  assert.match(peticiones[0].system.at(-1).text, /notas de voz ya transcritas/);
});

test('solo las 3 últimas imágenes van como imagen', async () => {
  const repo = crearRepo(openDb(':memory:'));
  const setter = new Setter({ repo, medios: { imagenParaModelo: async () => ({ data: 'eA==', media_type: 'image/png' }) } });
  const hist = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, autor: 'lead', adjunto: 'imagen', media_ruta: `m/${i}.png`, texto: '[imagen]' }));
  const m = await setter.mensajesModelo(hist);
  assert.equal(m[0].content.filter((b) => b.type === 'image').length, 3);
  assert.equal(m[0].content.filter((b) => b.text === '[imagen enviada antes]').length, 2);
  // sin imágenes, el formato de texto de siempre
  assert.deepEqual(await setter.mensajesModelo([{ id: 1, autor: 'lead', texto: 'hola' }]), [{ role: 'user', content: 'hola' }]);
});

test('Probar IA: subir un audio lo transcribe y Sofía contesta; el panel sirve el archivo', async () => {
  config.adminToken = 'clave-test';
  const b = base();
  const repo = crearRepo(openDb(':memory:'));
  const pruebas = crearRepo(openDb(':memory:'));
  const peticiones = [];
  const complete = async (req) => { peticiones.push(req); return { content: [{ type: 'tool_use', id: 't', name: 'responder', input: { mensajes: ['claro, en parla tenemos'], fase: 'f2 diagnóstico' } }] }; };
  const srv = crearApp({ setter: {}, repo, pruebas, complete, medios: { base: b, transcribirImpl: async () => 'hola qué horarios tenéis en parla' } }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}/admin/probar`;
  const h = { authorization: 'Bearer clave-test', 'content-type': 'application/json' };
  try {
    const c = (await (await fetch(url + '/conversaciones', { method: 'POST', headers: h, body: '{"canal":"whatsapp"}' })).json()).conv;
    const grande = Buffer.alloc(2 * 1024 * 1024, 1).toString('base64'); // > 1 MB: pasa por el parser grande
    const d = await (await fetch(`${url}/conversaciones/${c.id}/adjunto`, { method: 'POST', headers: h, body: JSON.stringify({ datos: grande, mime: 'audio/ogg', nombre: 'nota.ogg' }) })).json();
    assert.ok(d.mensajes.some((m) => m.autor === 'sistema' && /Transcripción: «hola qué horarios/.test(m.texto)));
    assert.ok(d.mensajes.some((m) => m.autor === 'ia' && m.texto === 'claro, en parla tenemos'));
    const audio = d.mensajes.find((m) => m.adjunto === 'audio');
    assert.equal(audio.tiene_medio, 1);
    assert.match(peticiones[0].messages[0].content, /nota de voz.*horarios/);
    const f = await fetch(`${url}/conversaciones/${c.id}/media/${audio.id}`, { headers: h });
    assert.equal(f.status, 200);
    assert.equal((await f.arrayBuffer()).byteLength, 2 * 1024 * 1024);
    const ficheros = () => fs.readdirSync(b, { recursive: true }).filter((x) => /\.ogg$/.test(x)).length;
    assert.equal(ficheros(), 1);
    await fetch(`${url}/conversaciones/${c.id}`, { method: 'DELETE', headers: h });
    assert.equal(ficheros(), 0);
    const c2 = (await (await fetch(url + '/conversaciones', { method: 'POST', headers: h, body: '{"canal":"whatsapp"}' })).json()).conv;
    const mal = await fetch(`${url}/conversaciones/${c2.id}/adjunto`, { method: 'POST', headers: h, body: JSON.stringify({ datos: 'eA==', mime: 'application/pdf', nombre: 'x.pdf' }) });
    assert.equal(mal.status, 400);
  } finally { srv.close(); }
});
