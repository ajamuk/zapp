// Revisión de noviembre de 2026: seguridad, fallos funcionales y velocidad. Cada test cubre un arreglo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import * as medios from '../src/medios.js';
import * as panel from '../src/panel.js';
import { config, clavesDebiles } from '../src/config.js';
import { crearApp } from '../src/server.js';
import { enviarMedio } from '../src/probar.js';

const T0 = new Date('2026-11-17T11:00:00Z'); // martes 12:00 en Madrid
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const responder = (mensajes) => ({ content: [{ type: 'tool_use', id: 't', name: 'responder', input: { mensajes, fase: 'f2 diagnóstico' } }] });

function montar({ complete, ghl = {}, aimharder = {} } = {}) {
  const repo = crearRepo(openDb(':memory:'));
  const sal = { enviados: [], avisos: [], tags: [] };
  const setter = new Setter({
    repo, live: true, sleep: async () => {}, now: () => new Date(T0), random: () => 0, complete,
    avisar: async (t) => sal.avisos.push(t),
    ghl: { sendMessage: async ({ texto }) => { sal.enviados.push(texto); return { messageId: `m${sal.enviados.length}` }; }, addTags: async (_, t) => { sal.tags.push(...t); }, removeTags: async () => {}, assign: async () => {}, addNote: async () => {}, getContact: async () => ({ contact: {} }), ...ghl },
    aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: false }), ...aimharder },
  });
  const chat = (id) => { repo.upsertConv({ id, contact_id: `k${id}`, channel: 'whatsapp' }); repo.updateConv(id, { tipo: 'captacion', respond_at: T0.toISOString(), last_inbound_at: T0.toISOString() }); repo.addMessage({ conversation_id: id, autor: 'lead', texto: 'hola', created_at: T0.toISOString() }); };
  return { repo, setter, sal, chat };
}

async function servidor(opciones = {}) {
  config.adminToken = 'clave-de-los-tests';
  const repo = opciones.repo || crearRepo(openDb(':memory:'));
  const srv = crearApp({ setter: {}, repo, ...opciones }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const api = (ruta, o = {}) => fetch(base + '/admin' + ruta, { ...o, headers: { authorization: 'Bearer clave-de-los-tests', 'content-type': 'application/json', ...(o.headers || {}) } });
  return { repo, srv, base, api };
}

// ---------- Seguridad ----------

test('adjuntos: solo https y nunca de una dirección interna, ni siguiendo una redirección', async () => {
  for (const u of ['http://storage.googleapis.com/a.ogg', 'https://127.0.0.1/a', 'https://localhost:3200/admin/costes', 'https://169.254.169.254/latest/meta-data', 'https://10.0.0.8/a', 'https://[::1]/a', 'https://[::ffff:127.0.0.1]/a', 'file:///etc/passwd', 'nada']) {
    await assert.rejects(medios.descargar(u, { fetchImpl: async () => { throw new Error('no debería pedirse'); } }), /https|interna|no válida/, u);
  }
  // Un nombre público que resuelve a una red interna
  await assert.rejects(medios.descargar('https://adjuntos.ejemplo.com/a.ogg', { fetchImpl: async () => { throw new Error('no debería pedirse'); }, resolver: async () => [{ address: '192.168.1.20' }] }), /interna/);
  // Redirección a este servidor: se corta antes de pedirla
  const pedidas = [];
  const fetchImpl = async (url) => { pedidas.push(url); return { ok: false, status: 302, headers: new Headers({ location: 'https://127.0.0.1:3200/admin/costes' }) }; };
  await assert.rejects(medios.descargar('https://cdn.ejemplo.com/a.jpg', { fetchImpl }), /interna/);
  assert.deepEqual(pedidas, ['https://cdn.ejemplo.com/a.jpg']);
});

test('adjuntos: el token de GHL solo se manda a GHL, y la descarga se corta al pasar del tamaño máximo', async () => {
  const cabeceras = [];
  const fetchImpl = async (url, { headers }) => { cabeceras.push([new URL(url).hostname, headers.Authorization || 'sin']); return { ok: false, status: 403, headers: new Headers() }; };
  await assert.rejects(medios.descargar('https://otro-servidor.com/a.ogg', { fetchImpl, token: 'tk' }), /descarga 403/);
  await assert.rejects(medios.descargar('https://falso-leadconnectorhq.com/a.ogg', { fetchImpl, token: 'tk' }), /descarga 403/);
  assert.deepEqual(cabeceras, [['otro-servidor.com', 'sin'], ['falso-leadconnectorhq.com', 'sin']]);
  assert.equal(medios.esHostGhl('services.leadconnectorhq.com'), true);
  // Sin content-length y con un cuerpo interminable: se deja de leer al pasar de 25 MB
  let leidos = 0;
  const trozo = new Uint8Array(1024 * 1024);
  const cuerpo = new ReadableStream({ pull(c) { leidos++; c.enqueue(trozo); } });
  await assert.rejects(medios.descargar('https://cdn.ejemplo.com/enorme.mp4', { fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers(), body: cuerpo }) }), /demasiado grande/);
  assert.ok(leidos < 40, `leyó ${leidos} MB`);
});

test('exportar a CSV: un nombre o un mensaje que empieza como fórmula sale como texto', () => {
  const repo = crearRepo(openDb(':memory:'));
  repo.upsertConv({ id: 'c1', contact_id: 'k1', channel: 'whatsapp', nombre: '=HYPERLINK("http://malo";"pulsa")', telefono: '+34600111222' });
  repo.addMessage({ conversation_id: 'c1', autor: 'lead', texto: '@SUM(1+1)*cmd|\' /C calc\'!A0' });
  repo.addMessage({ conversation_id: 'c1', autor: 'lead', texto: '-20 kilos quiero perder' });
  const chats = panel.exportar(repo.db, {});
  assert.match(chats, /"'=HYPERLINK\(""http:\/\/malo"";""pulsa""\)"/);
  assert.match(chats, /;\+34600111222;/); // el teléfono no se toca
  const mensajes = panel.exportar(repo.db, { formato: 'mensajes' });
  assert.match(mensajes, /;'@SUM\(1\+1\)/);
  assert.match(mensajes, /;'-20 kilos quiero perder;/);
  assert.doesNotMatch(mensajes, /;[=@]/);
});

test('cabeceras de seguridad, panel con política de contenido y archivos de leads que no se ejecutan', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-'));
  fs.writeFileSync(path.join(dir, 'malo.html'), '<script>alert(1)</script>');
  fs.writeFileSync(path.join(dir, 'foto.png'), 'png');
  const { srv, base, api, repo } = await servidor({ medios: { base: dir } });
  // Un lead manda un «adjunto» que en realidad es una página web
  repo.upsertConv({ id: 'c1', contact_id: 'k1', channel: 'whatsapp' });
  const malo = repo.addMessage({ conversation_id: 'c1', autor: 'lead', texto: '[documento]', media_ruta: 'malo.html', media_mime: 'text/html' }).lastInsertRowid;
  try {
    const salud = await fetch(base + '/health');
    assert.equal(salud.headers.get('x-powered-by'), null);
    assert.equal(salud.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(salud.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(salud.headers.get('referrer-policy'), 'no-referrer');
    const p = await fetch(base + '/panel');
    const csp = p.headers.get('content-security-policy');
    const script = /<script>([\s\S]*?)<\/script>/.exec(await p.text())[1];
    assert.ok(csp.includes(`script-src 'sha256-${crypto.createHash('sha256').update(script).digest('base64')}'`), 'la huella del script del panel coincide');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'self'/);
    // El HTML del lead se entrega como descarga, nunca como página
    const app = (await import('express')).default();
    app.get('/m', (_req, res) => enviarMedio(res, { media_ruta: 'malo.html', media_mime: 'text/html' }, dir));
    app.get('/i', (_req, res) => enviarMedio(res, { media_ruta: 'foto.png', media_mime: 'image/png' }, dir));
    const s2 = app.listen(0); await new Promise((r) => s2.once('listening', r));
    try {
      const m = await fetch(`http://127.0.0.1:${s2.address().port}/m`);
      assert.equal(m.headers.get('content-type'), 'application/octet-stream');
      assert.equal(m.headers.get('content-disposition'), 'attachment');
      assert.match((await fetch(`http://127.0.0.1:${s2.address().port}/i`)).headers.get('content-type'), /^image\/png/);
    } finally { s2.close(); }
    assert.ok(malo > 0);
    assert.equal((await api('/panel/estado', { headers: { authorization: 'Bearer otra' } })).status, 401);
  } finally { srv.close(); }
});

test('un cuerpo mal formado en el panel no da error interno ni tumba el servicio al apuntar la actividad', async () => {
  const { srv, api, repo } = await servidor();
  let caidas = 0; const alCaer = () => { caidas++; };
  process.on('uncaughtException', alCaer);
  try {
    assert.equal((await api('/panel/conversaciones?criterios=null')).status, 200);
    assert.equal((await api('/panel/conversaciones?criterios=%5B1%5D')).status, 200);
    assert.equal((await api('/panel/vistas/orden', { method: 'PUT', body: '{"ids":"abc"}' })).status, 200);
    assert.equal((await api('/panel/etiquetas/orden', { method: 'PUT', body: '{"ids":5}' })).status, 200);
    // Antes: el registro de actividad fallaba después de responder y el proceso se cerraba
    const r = await api('/panel/etiquetas/importar', { method: 'POST', body: '{"nombres":"abc"}' });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).creadas, []);
    assert.equal((await api('/panel/lanzamientos/previa', { method: 'POST', body: '{"canales":"whatsapp","excluir_etiquetas":{"a":1}}' })).status, 200);
    assert.equal((await api('/conversaciones/no-existe/reanudar', { method: 'POST' })).status, 404);
    await espera(30);
    assert.equal(caidas, 0);
    assert.ok(repo.db.prepare('SELECT 1').get());
  } finally { process.off('uncaughtException', alCaer); srv.close(); }
});

test('claves del servicio: se avisa si faltan o son cortas', () => {
  assert.equal(clavesDebiles({ webhookSecret: 'a'.repeat(32), adminToken: 'b'.repeat(48) }).length, 0);
  const avisos = clavesDebiles({ webhookSecret: '', adminToken: 'corta' });
  assert.equal(avisos.length, 2);
  assert.match(avisos[0], /Falta WEBHOOK_SECRET/);
  assert.match(avisos[1], /ADMIN_TOKEN tiene 5 caracteres/);
  assert.doesNotMatch(avisos.join(' '), /corta/); // nunca se enseña la clave
});

// ---------- Funcional ----------

test('dos mensajes casi a la vez de un chat nuevo: se clasifica una vez y no se avisa por Telegram', async () => {
  let consultas = 0;
  const { repo, setter, sal } = montar({ aimharder: { buscarSocioPorTelefono: async () => { consultas++; await espera(20); return { esSocio: true, sede: 'parla' }; } } });
  const evt = (n) => ({ evento: 'inbound', conversationId: 'c1', contactId: 'k1', canal: 'whatsapp', texto: `mensaje ${n}`, messageId: `m${n}`, telefono: '+34600111222' });
  const [a, b] = await Promise.all([setter.handleWebhook(evt(1)), setter.handleWebhook(evt(2))]);
  assert.deepEqual(a, { socio: true });
  assert.deepEqual(b, { pausada: true });
  assert.equal(consultas, 1);
  assert.equal(sal.avisos.length, 0);
  assert.equal(repo.history('c1').length, 2);
  // Otro chat no espera al primero, y un fallo no atasca la cola de ese chat
  setter.aimharder.buscarSocioPorTelefono = async () => ({ esSocio: false });
  setter.procesarEvento = async (e) => { if (e.messageId === 'x1') throw new Error('fallo suelto'); return { ok: e.messageId }; };
  await assert.rejects(setter.handleWebhook({ ...evt(1), messageId: 'x1' }), /fallo suelto/);
  assert.deepEqual(await setter.handleWebhook({ ...evt(1), messageId: 'x2' }), { ok: 'x2' });
  assert.equal(setter.colas.size, 0);
});

test('un webhook repetido no vuelve a pausar un chat que el equipo ya reanudó', async () => {
  const { repo, setter } = montar({});
  repo.guardarAjuste('palabrasParar', ['baja']);
  const evt = { conversationId: 'c1', contactId: 'k1', canal: 'whatsapp', texto: 'quiero la baja', messageId: 'm1' };
  await setter.onInbound(evt);
  assert.equal(repo.getConv('c1').ai_paused, 1);
  repo.updateConv('c1', { ai_paused: 0, pause_reason: null });
  assert.deepEqual(await setter.onInbound(evt), { ignorado: 'duplicado' });
  assert.equal(repo.getConv('c1').ai_paused, 0);
});

test('si el lead vuelve a escribir mientras Sofía piensa, no salen dos respuestas: contesta una vez con todo', async () => {
  let llamadas = 0; let vistos = [];
  const { repo, setter, sal, chat } = montar({ complete: async (req) => {
    llamadas++;
    vistos.push(req.messages.filter((m) => m.role === 'user').map((m) => m.content).join(' | '));
    if (llamadas === 1) await setter.onInbound({ conversationId: 'a', contactId: 'ka', canal: 'whatsapp', texto: 'y cuánto cuesta?', messageId: 'l2' });
    return responder([`respuesta ${llamadas}`]);
  } });
  chat('a');
  await setter.tick();
  assert.deepEqual(sal.enviados, []); // la primera, que no vio el segundo mensaje, no sale
  assert.ok(repo.getConv('a').respond_at, 'queda el turno nuevo en cola');
  repo.updateConv('a', { respond_at: T0.toISOString() });
  await setter.tick();
  assert.deepEqual(sal.enviados, ['respuesta 2']);
  assert.match(vistos[1], /y cuánto cuesta\?/);
});

test('si en ese turno Sofía ya derivó al equipo, la respuesta sí sale (no se pierde la gestión)', async () => {
  const { repo, setter, sal, chat } = montar({ complete: async () => {
    await setter.onInbound({ conversationId: 'a', contactId: 'ka', canal: 'whatsapp', texto: 'sigo aquí', messageId: 'l2' });
    return { content: [{ type: 'tool_use', id: 'd', name: 'derivar_a_equipo', input: { motivo: 'salud', resumen: 'lesión de rodilla' } }, { type: 'tool_use', id: 't', name: 'responder', input: { mensajes: ['te escribe una persona del equipo'], fase: 'f2 diagnóstico' } }] };
  } });
  chat('a');
  await setter.tick();
  assert.deepEqual(sal.enviados, ['te escribe una persona del equipo']);
  assert.equal(repo.getConv('a').derivado, 1);
});

test('una respuesta que pasa del tope queda anulada: no sale tarde ni repetida con el reintento', async () => {
  let soltar; const puerta = new Promise((x) => { soltar = x; });
  let llamadas = 0;
  const { repo, setter, sal, chat } = montar({ complete: async () => { llamadas++; if (llamadas === 1) await puerta; return responder([`respuesta ${llamadas}`]); } });
  setter.topeRespuestaMs = 20;
  chat('a');
  const vivo = setInterval(() => {}, 5); // el reloj del tope no mantiene vivo el proceso por sí solo
  try {
    await setter.tick(); // salta el tope y se programa el reintento
    assert.equal(repo.getConv('a').reintentos, 1);
    soltar(); await espera(15); // la primera llamada termina ahora, fuera de plazo
    assert.deepEqual(sal.enviados, []);
    repo.updateConv('a', { respond_at: T0.toISOString() });
    setter.topeRespuestaMs = 5000;
    await setter.tick();
    assert.deepEqual(sal.enviados, ['respuesta 2']);
  } finally { clearInterval(vivo); }
});

// ---------- Velocidad ----------

test('las respuestas grandes del panel van comprimidas y la lista de chats no arrastra campos que no usa', async () => {
  const repo = crearRepo(openDb(':memory:'));
  for (let i = 0; i < 40; i++) {
    repo.upsertConv({ id: `c${i}`, contact_id: `k${i}`, channel: 'whatsapp', nombre: `Lead ${i}` });
    repo.updateConv(`c${i}`, { resumen: 'r'.repeat(1200), analisis: 'a'.repeat(700), nota_ghl_texto: 'n'.repeat(1500), ultimo_turno: JSON.stringify({ herramientas: [{ nombre: 'consultar_tarifas', resultado: 'x'.repeat(2000) }] }) });
    repo.addMessage({ conversation_id: `c${i}`, autor: 'lead', texto: 'hola, quería información' });
  }
  const { srv, base, api } = await servidor({ repo });
  try {
    const r = await fetch(base + '/admin/panel/conversaciones', { headers: { authorization: 'Bearer clave-de-los-tests', 'accept-encoding': 'gzip' } });
    assert.equal(r.headers.get('content-encoding'), 'gzip');
    assert.match(r.headers.get('vary') || '', /accept-encoding/i);
    const filas = await r.json(); // fetch lo descomprime
    assert.equal(filas.length, 40);
    assert.equal(filas[0].ultimo_texto, 'hola, quería información');
    for (const campo of ['resumen', 'nota_ghl_texto', 'ultimo_turno', 'nota_ghl_id']) assert.equal(campo in filas[0], false, campo);
    assert.ok(JSON.stringify(filas).length < 40 * 1200, 'la lista pesa poco');
    // El detalle del chat sí lo lleva todo
    const d = await (await api('/panel/conversaciones/c1')).json();
    assert.equal(d.conv.resumen.length, 1200);
    // Sin gzip en la petición, o en respuestas pequeñas, no se comprime
    const sin = await fetch(base + '/admin/panel/conversaciones', { headers: { authorization: 'Bearer clave-de-los-tests', 'accept-encoding': 'identity' } });
    assert.equal(sin.headers.get('content-encoding'), null);
    assert.equal((await fetch(base + '/health', { headers: { 'accept-encoding': 'gzip' } })).headers.get('content-encoding'), null);
    // La exportación sigue llevando el análisis
    assert.match(panel.exportar(repo.db, {}), /a{700}/);
    assert.ok(zlib.gzipSync);
  } finally { srv.close(); }
});
