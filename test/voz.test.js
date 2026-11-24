import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import { config } from '../src/config.js';
import { guardarAjustes, leerAjustes } from '../src/ajustes.js';
import * as voz from '../src/voz.js';

const T0 = new Date('2026-11-18T10:00:00Z');
const NORMAS = voz.ajustesVoz({ activo: true, soloPruebas: false });
const base = { ajustes: NORMAS, canal: 'whatsapp', clave: true, vozId: 'v1', esPrueba: false, ultimoLeadAudio: true, mensajes: ['claro que sí 😊', 'te espero el lunes'] };

test('normas: apagado por defecto y cada norma corta el paso', () => {
  assert.equal(voz.ajustesVoz().activo, false);
  assert.equal(voz.decidirVoz({ ...base, ajustes: voz.ajustesVoz() }).motivo, 'apagado');
  const si = voz.decidirVoz(base);
  assert.equal(si.voz, true);
  assert.equal(si.texto, 'claro que sí. te espero el lunes.', 'sin emojis y con pausa entre burbujas');
  assert.equal(voz.decidirVoz({ ...base, clave: false }).voz, false);
  assert.equal(voz.decidirVoz({ ...base, vozId: '' }).voz, false);
  assert.equal(voz.decidirVoz({ ...base, canal: 'instagram' }).motivo, 'solo por WhatsApp');
  assert.equal(voz.decidirVoz({ ...base, ajustes: { ...NORMAS, soloPruebas: true } }).motivo, 'solo teléfonos de prueba');
  assert.equal(voz.decidirVoz({ ...base, ajustes: { ...NORMAS, soloPruebas: true }, esPrueba: true }).voz, true);
  assert.equal(voz.decidirVoz({ ...base, ultimoLeadAudio: false }).motivo, 'el lead no ha mandado un audio');
  assert.equal(voz.decidirVoz({ ...base, enviadasConv: 2 }).motivo, 'máximo por conversación');
  assert.equal(voz.decidirVoz({ ...base, mensajes: ['a'.repeat(400)] }).motivo, 'respuesta demasiado larga');
  for (const t of ['mira https://crossfitmpo.com', 'escribe a hola@box.es']) assert.equal(voz.decidirVoz({ ...base, mensajes: [t] }).motivo, 'lleva enlaces o correos', t);
  for (const t of ['son 59 € al mes', 'la clase es el miércoles a las 18:30']) assert.equal(voz.decidirVoz({ ...base, mensajes: [t] }).voz, true, t);
  assert.equal(voz.decidirVoz({ ...base, caracteresMes: 24990 }).motivo, 'tope mensual');
});

test('ajustes: se guardan validados y el identificador de voz raro se rechaza', () => {
  const repo = crearRepo(openDb(':memory:'));
  assert.equal(leerAjustes(repo).voz.activo, false);
  guardarAjustes(repo, { voz: { activo: true, maxPorConversacion: 1, vozId: ' JBFqnCBsd6RMkjVDRZzb ' } });
  assert.deepEqual({ ...leerAjustes(repo).voz }, { ...voz.ajustesVoz(), activo: true, maxPorConversacion: 1, vozId: 'JBFqnCBsd6RMkjVDRZzb' });
  assert.throws(() => guardarAjustes(repo, { voz: { vozId: '../x' } }), /Voice ID/);
  assert.throws(() => guardarAjustes(repo, { voz: { maxCaracteres: 5 } }), /letras por nota/);
  assert.equal(leerAjustes(repo).voz.velocidad, 100);
  assert.equal(guardarAjustes(repo, { voz: { velocidad: 108 } }).voz.velocidad, 108);
  assert.throws(() => guardarAjustes(repo, { voz: { velocidad: 300 } }), /velocidad/);
});

test('sintetizar: pide el MP3 a ElevenLabs, lo convierte a OGG y da una URL pública que solo abre notas de voz', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voz-'));
  const antes = { ...config.voz };
  Object.assign(config.voz, { apiKey: 'clave', vozId: 'v1' });
  try {
    const pedidos = [];
    const fetchImpl = async (url, o) => { pedidos.push({ url, o }); return { ok: true, arrayBuffer: async () => Buffer.alloc(500, 1) }; };
    const convertir = async (args) => { assert.ok(args.includes('libopus')); fs.writeFileSync(args.at(-1), 'ogg'); };
    const r = await voz.sintetizar('hola', { base: dir, fetchImpl, convertir });
    assert.match(pedidos[0].url, /\/v1\/text-to-speech\/v1\?output_format=mp3_44100_128$/);
    assert.equal(pedidos[0].o.headers['xi-api-key'], 'clave');
    assert.deepEqual(JSON.parse(pedidos[0].o.body), { text: 'hola', model_id: config.voz.modelo });
    assert.match(r.url, /\/r\/voz_[\w-]{24}\.ogg$/);
    assert.equal(r.media_mime, 'audio/ogg');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'voz')), [path.basename(r.media_ruta)], 'el MP3 intermedio se borra');
    assert.equal(voz.rutaDeCodigo(r.url.split('/').pop().replace('.ogg', '')), r.media_ruta);
    // La velocidad se aplica al convertir (atempo); a 100 no se toca el audio
    const vistos = [];
    const espia = async (args) => { vistos.push(args.join(' ')); fs.writeFileSync(args.at(-1), 'ogg'); };
    await voz.sintetizar('hola', { base: dir, fetchImpl, convertir: espia, velocidad: 108 });
    await voz.sintetizar('hola', { base: dir, fetchImpl, convertir: espia });
    assert.match(vistos[0], /-filter:a atempo=1\.08 /);
    assert.doesNotMatch(vistos[1], /atempo/);
    for (const f of fs.readdirSync(path.join(dir, 'voz'))) if (f !== path.basename(r.media_ruta)) fs.rmSync(path.join(dir, 'voz', f));
    for (const malo of ['voz_../../setter', 'voz_corto', 'otra-cosa', '']) assert.equal(voz.rutaDeCodigo(malo), null);
    await assert.rejects(() => voz.sintetizar('hola', { base: dir, fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'no' }), convertir }), /ElevenLabs → 401/);
    await assert.rejects(() => voz.sintetizar('hola', { base: dir, fetchImpl, convertir: async () => { throw new Error('ffmpeg: roto'); } }), /roto/);
    assert.equal(fs.readdirSync(path.join(dir, 'voz')).length, 1, 'un fallo no deja archivos sueltos');
  } finally { Object.assign(config.voz, antes); }
});

function montar({ ajustes = { activo: true, soloPruebas: false }, live = true, sintetizar = null, fallaGhl = false } = {}) {
  const repo = crearRepo(openDb(':memory:'));
  guardarAjustes(repo, { voz: ajustes });
  const sal = { textos: [], audios: [], sintesis: [], notas: [] };
  const ghl = {
    sendMessage: async ({ texto }) => { sal.textos.push(texto); return { messageId: `m${sal.textos.length}` }; },
    enviarAdjunto: async (x) => { sal.audios.push(x); if (fallaGhl) throw new Error('GHL 500'); return { messageId: 'a1' }; },
    addTags: async () => {}, removeTags: async () => {}, assign: async () => {}, addNote: async (_, n) => sal.notas.push(n),
  };
  const falsa = { ...voz, hayClave: () => true, vozElegida: () => 'v1',
    sintetizar: sintetizar || (async (texto) => { sal.sintesis.push(texto); return { media_ruta: 'voz/abc.ogg', media_mime: 'audio/ogg', url: 'https://ejemplo.invalid/r/voz_abc.ogg' }; }) };
  const setter = new Setter({ repo, ghl, live, voz: falsa, sleep: async () => {}, now: () => T0, random: () => 0, avisar: async () => {}, aimharder: {}, complete: async () => { throw new Error('no se usa'); } });
  repo.upsertConv({ id: 'c1', contact_id: 'k1', channel: 'whatsapp', telefono: '+34600000000' });
  const lead = (adjunto = 'audio') => repo.addMessage({ conversation_id: 'c1', autor: 'lead', texto: adjunto ? `[${adjunto}]` : 'hola', adjunto });
  return { repo, setter, sal, lead, conv: () => repo.getConv('c1') };
}

test('con las normas cumplidas la respuesta sale como una sola nota de voz y queda guardada con su texto', async () => {
  const m = montar(); m.lead();
  const ids = await m.setter.enviar(m.conv(), ['claro que sí 😊', 'te espero el lunes']);
  assert.deepEqual(ids, ['a1']);
  assert.deepEqual(m.sal.textos, []);
  assert.deepEqual(m.sal.sintesis, ['claro que sí. te espero el lunes.']);
  assert.deepEqual(m.sal.audios, [{ contactId: 'k1', canal: 'whatsapp', url: 'https://ejemplo.invalid/r/voz_abc.ogg', mime: 'audio/ogg', nombre: 'nota-de-voz.ogg' }]);
  const fila = m.repo.db.prepare("SELECT texto, adjunto, media_ruta, external_id FROM messages WHERE autor = 'ia'").get();
  assert.deepEqual({ ...fila }, { texto: 'claro que sí 😊\nte espero el lunes', adjunto: 'audio', media_ruta: 'voz/abc.ogg', external_id: 'a1' });
  assert.equal(voz.uso(m.repo.db, 'c1', T0).enviadasConv, 1);
  assert.ok(voz.uso(m.repo.db, 'c1', T0).caracteresMes > 20);
});

test('apagado, sin audio del lead, en modo prueba o al llegar al máximo: sale el texto de siempre', async () => {
  const apagado = montar({ ajustes: { activo: false } }); apagado.lead();
  await apagado.setter.enviar(apagado.conv(), ['hola']);
  assert.deepEqual([apagado.sal.textos, apagado.sal.audios], [['hola'], []]);

  const sinAudio = montar(); sinAudio.lead(null);
  await sinAudio.setter.enviar(sinAudio.conv(), ['hola']);
  assert.deepEqual([sinAudio.sal.textos, sinAudio.sal.audios], [['hola'], []]);

  const sombra = montar({ live: false }); sombra.lead();
  await sombra.setter.enviar(sombra.conv(), ['hola']);
  assert.deepEqual([sombra.sal.textos, sombra.sal.audios, sombra.sal.sintesis], [[], [], []], 'en modo prueba no se gasta ElevenLabs');

  const tope = montar({ ajustes: { activo: true, soloPruebas: false, maxPorConversacion: 1 } }); tope.lead();
  await tope.setter.enviar(tope.conv(), ['uno']); tope.lead();
  await tope.setter.enviar(tope.conv(), ['dos']);
  assert.deepEqual([tope.sal.textos, tope.sal.audios.length], [['dos'], 1]);
});

test('si ElevenLabs o GHL fallan, la respuesta sale por escrito', async () => {
  const sinVoz = montar({ sintetizar: async () => { throw new Error('ElevenLabs → 429'); } }); sinVoz.lead();
  await sinVoz.setter.enviar(sinVoz.conv(), ['hola', 'qué tal']);
  assert.deepEqual([sinVoz.sal.textos, sinVoz.sal.audios], [['hola', 'qué tal'], []]);

  const sinGhl = montar({ fallaGhl: true }); sinGhl.lead();
  await sinGhl.setter.enviar(sinGhl.conv(), ['hola']);
  assert.deepEqual([sinGhl.sal.textos, sinGhl.sal.audios.length], [['hola'], 1]);
  assert.equal(voz.uso(sinGhl.repo.db, 'c1', T0).enviadasConv, 0);
});

test('ruta pública: /r/voz_<código>.ogg entrega la nota de voz y nada más de la carpeta', async () => {
  const { crearApp } = await import('../src/server.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voz-'));
  const codigo = 'A'.repeat(24);
  fs.mkdirSync(path.join(dir, 'voz')); fs.writeFileSync(path.join(dir, 'voz', `${codigo}.ogg`), 'OggS');
  fs.writeFileSync(path.join(dir, 'audio-de-un-lead.ogg'), 'privado');
  const repo = crearRepo(openDb(':memory:'));
  const srv = crearApp({ setter: {}, repo, medios: { base: dir } }).listen(0); await new Promise((x) => srv.once('listening', x));
  try {
    const u = `http://127.0.0.1:${srv.address().port}/r/`;
    const r = await fetch(`${u}voz_${codigo}.ogg`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /audio\/ogg/);
    assert.equal(await r.text(), 'OggS');
    for (const malo of [`voz_${'B'.repeat(24)}.ogg`, 'audio-de-un-lead.ogg', 'voz_..%2Faudio-de-un-lead.ogg']) assert.equal((await fetch(u + malo)).status, 404, malo);
  } finally { srv.close(); }
});
