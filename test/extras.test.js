import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter, contienePalabra } from '../src/setter.js';
import { config } from '../src/config.js';
import { crearApp } from '../src/server.js';
import * as alertas from '../src/alertas.js';
import * as recursos from '../src/recursos.js';
import * as meta from '../src/meta.js';
import * as etq from '../src/etiquetas.js';
import { guardarAjustes, aplicarAjustes } from '../src/ajustes.js';
import { dentroDeHorario, siguienteApertura } from '../src/horario.js';
import { rendimiento, estadisticas, consumo, exportar, costeRun } from '../src/panel.js';
import { describir } from '../src/actividad.js';
import { resumenInstrucciones } from '../src/resumen.js';

const T0 = new Date('2026-11-17T11:00:00Z'); // martes 12:00 Madrid
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zx-'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const jwt = (exp) => `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`;

test('alertas: se abren, se agrupan, avisan una vez y se resuelven solas', async () => {
  const db = openDb(':memory:'); const repo = crearRepo(db); const avisos = [];
  const store = path.join(tmp(), 't.json');
  fs.writeFileSync(store, JSON.stringify({ centers: { parla: { accessToken: jwt(T0.getTime() / 1000 + 3600) }, getafe: { accessToken: jwt(T0.getTime() / 1000 + 86400) } } }));
  repo.logRun({ conversation_id: 'c', motivo: 'respuesta', modelo: 'm', error: 'boom' }); repo.logRun({ conversation_id: 'c', motivo: 'respuesta', modelo: 'm', error: 'boom 2' });
  repo.upsertConv({ id: 'c', contact_id: 'k', channel: 'whatsapp' }); repo.updateConv('c', { respond_at: new Date(T0.getTime() - 3600e3).toISOString() });
  const ghlMal = { req: async () => { throw new Error('GHL GET → 401'); } };
  let r = await alertas.vigilar(db, { ghl: ghlMal, avisar: async (t) => avisos.push(t), ahora: T0, tokenStore: store, entradaGhl: false, disco: ':memory:' });
  const mal = r.filter((x) => !x.ok).map((x) => x.clave).sort();
  assert.deepEqual(mal, ['aimharder-tokens', 'cola-atascada', 'ghl-token', 'ia-errores']);
  assert.match(r.find((x) => x.clave === 'aimharder-tokens').problema, /parla/);
  assert.equal(avisos.length, 4);
  await alertas.vigilar(db, { ghl: ghlMal, avisar: async (t) => avisos.push(t), ahora: T0, tokenStore: store, entradaGhl: false, disco: ':memory:' });
  assert.equal(avisos.length, 4); // no repite el aviso
  assert.equal(alertas.abiertas(db).find((a) => a.clave === 'ghl-token').veces, 2);
  r = await alertas.vigilar(db, { ghl: { req: async () => ({}) }, ahora: T0, tokenStore: store, entradaGhl: false, disco: ':memory:' });
  assert.ok(!alertas.abiertas(db).some((a) => a.clave === 'ghl-token'));
  assert.ok(alertas.recientes(db).some((a) => a.clave === 'ghl-token'));
});

test('recursos: Sofía los ve, los envía por URL pública en real y solo como borrador en prueba', async () => {
  const db = openDb(':memory:'); const repo = crearRepo(db); const base = tmp();
  assert.throws(() => recursos.crear(db, { nombre: 'x', descripcion: 'y', datos: 'eA==', mime: 'text/plain' }, { base }), /Formato/);
  const r = recursos.crear(db, { nombre: 'Horario Parla', descripcion: 'cuando pregunte por horarios de Parla', datos: PNG.toString('base64'), mime: 'image/png', archivo: 'h.png' }, { base });
  assert.match(recursos.urlPublica(r), /\/r\/[\w-]{20,}\.png$/);
  assert.match(recursos.contextoIA(db), /«Horario Parla» \(imagen\): cuando pregunte/);
  const enviados = []; const notas = [];
  const ghl = { sendMessage: async () => ({ messageId: 'm' }), enviarAdjunto: async (x) => { enviados.push(x); return { messageId: 'a1' }; }, addTags: async () => {}, removeTags: async () => {}, assign: async () => {}, addNote: async (_, n) => notas.push(n) };
  const cola = () => [[{ name: 'enviar_recurso', input: { nombre: 'horario parla' } }], [{ name: 'responder', input: { mensajes: ['te paso el horario'], fase: 'f3 presentación' } }]];
  for (const live of [true, false]) {
    repo.upsertConv({ id: `c${live}`, contact_id: 'k1', channel: 'whatsapp' }); repo.updateConv(`c${live}`, { tipo: 'captacion' });
    const q = cola(); const s = new Setter({ repo, ghl, live, sleep: async () => {}, now: () => T0, random: () => 0, aimharder: {}, complete: async () => ({ content: q.shift().map((b, i) => ({ type: 'tool_use', id: `t${i}`, ...b })) }) });
    await s.responder(`c${live}`);
  }
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].url, recursos.urlPublica(r));
  assert.match(notas.at(-1), /adjuntaría el archivo «Horario Parla»/);
  const m = db.prepare("SELECT * FROM messages WHERE conversation_id = 'ctrue' AND adjunto = 'imagen'").get();
  assert.equal(m.media_ruta, r.media_ruta);
  // Ruta pública
  config.adminToken = 'k';
  const srv = crearApp({ setter: {}, repo, medios: { base } }).listen(0); await new Promise((x) => srv.once('listening', x));
  try {
    const u = `http://127.0.0.1:${srv.address().port}/r/${r.token}.png`;
    assert.equal((await fetch(u)).status, 200);
    recursos.actualizar(db, r.id, { activo: false });
    assert.equal((await fetch(u)).status, 404);
  } finally { srv.close(); }
});

test('Imágenes de tarifas y horarios: salen solas con el texto, una vez por conversación y no si no da el dato', async () => {
  const db = openDb(':memory:'); const repo = crearRepo(db);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'info-'));
  const r = recursos.crear(db, { nombre: 'getafe-crossfit-hyrox-tarifas', descripcion: 'auto', datos: PNG.toString('base64'), mime: 'image/png', archivo: 'a.png' }, { base });
  const h = recursos.crear(db, { nombre: 'las-rosas-academy-horarios', descripcion: 'auto', datos: PNG.toString('base64'), mime: 'image/png', archivo: 'b.png' }, { base });
  assert.match(recursos.contextoIA(db), /envía solo.*imagen de tarifas/);
  assert.doesNotMatch(recursos.contextoIA(db), /getafe-crossfit/);
  assert.equal(recursos.nombreImagenInfo('tarifas', 'el_canaveral', 'crossfit_hyrox'), 'el-canaveral-crossfit-hyrox-tarifas');
  const enviados = [];
  const ghl = { sendMessage: async () => ({ messageId: 'm' }), enviarAdjunto: async (x) => { enviados.push(x.url); return { messageId: 'a' }; }, addTags: async () => {}, removeTags: async () => {}, assign: async () => {}, addNote: async () => {} };
  repo.upsertConv({ id: 'c1', contact_id: 'k1', channel: 'whatsapp' }); repo.updateConv('c1', { tipo: 'captacion' });
  const turno = async (consultas, texto) => {
    const q = [consultas, [{ name: 'responder', input: { mensajes: [texto], fase: 'f3 presentación' } }]];
    const s = new Setter({ repo, ghl, live: true, sleep: async () => {}, now: () => T0, random: () => 0, aimharder: {}, complete: async () => ({ content: q.shift().map((b, i) => ({ type: 'tool_use', id: `t${i}`, ...b })) }) });
    await s.responder('c1');
  };
  // Consulta precios pero no los da: no hay imagen
  await turno([{ name: 'consultar_tarifas', input: { sede: 'getafe', familia: 'crossfit_hyrox' } }], '¿Cuántos días a la semana te gustaría venir?');
  assert.equal(enviados.length, 0);
  // Da precios y horarios: las dos imágenes
  await turno([{ name: 'consultar_tarifas', input: { sede: 'getafe', familia: 'crossfit_hyrox', dias_por_semana: 2 } }, { name: 'consultar_horarios', input: { sede: 'las_rosas', modalidad: 'academy' } }], 'La M son 89 €/mes y hay clase a las 18:00');
  assert.deepEqual(enviados, [recursos.urlPublica(r), recursos.urlPublica(h)]);
  // Vuelve a darlos: no se repiten
  await turno([{ name: 'consultar_tarifas', input: { sede: 'getafe', familia: 'crossfit' } }], 'Te recuerdo: 89 euros al mes');
  assert.equal(enviados.length, 2);
});

test('Meta: simulado en prueba, sin configurar avisa, y en real manda el teléfono cifrado una sola vez', async () => {
  const db = openDb(':memory:'); const repo = crearRepo(db);
  repo.upsertConv({ id: 'c1', contact_id: 'k1', channel: 'whatsapp', telefono: '+34 611 222 333' });
  const conv = repo.getConv('c1');
  assert.throws(() => meta.validarAccion({ evento: 'Purchase' }), /valor/);
  const acc = meta.validarAccion({ evento: 'Schedule' });
  assert.equal((await meta.enviarEvento(db, conv, acc, { live: false })).estado, 'simulado');
  db.prepare('DELETE FROM meta_eventos').run();
  const viejo = { ...config.meta };
  try {
    config.meta.pixelId = ''; config.meta.token = '';
    assert.equal((await meta.enviarEvento(db, conv, acc, { live: true })).estado, 'sin_configurar');
    Object.assign(config.meta, { pixelId: '123', token: 'tok', testCode: 'TEST1' });
    const pedidas = [];
    const fetchImpl = async (url, o) => { pedidas.push([url, JSON.parse(o.body)]); return { ok: true, text: async () => '{"events_received":1}' }; };
    const e = await meta.enviarEvento(db, conv, acc, { live: true, fetchImpl, ahora: T0 });
    assert.equal(e.estado, 'enviado');
    const [url, body] = pedidas[0];
    assert.match(url, /graph\.facebook\.com\/v21\.0\/123\/events\?access_token=tok/);
    assert.equal(body.data[0].event_name, 'Schedule');
    assert.deepEqual(body.data[0].user_data.ph, [crypto.createHash('sha256').update('34611222333').digest('hex')]);
    assert.equal(body.test_event_code, 'TEST1');
    await meta.enviarEvento(db, conv, acc, { live: true, fetchImpl });
    assert.equal(pedidas.length, 1); // una vez por chat y evento
  } finally { Object.assign(config.meta, viejo); }
  // Desde una etiqueta
  const e2 = etq.crear(db, { nombre: 'Alta', acciones: { meta: { evento: 'Purchase', valor: 85 } } });
  assert.deepEqual(e2.acciones.meta, { evento: 'Purchase', valor: 85, valorAlta: false, moneda: 'EUR' });
  const llamadas = [];
  await new etq.Etiquetador({ repo, enviarMeta: async (_db, c, a) => llamadas.push([c.id, a.evento]) }).poner('c1', e2.id);
  assert.deepEqual(llamadas, [['c1', 'Purchase']]);
});

test('controles: palabras para parar y reanudar, el equipo no pausa si se configura, canales en pausa', async () => {
  assert.equal(contienePalabra('Vale, #Sofia sigue tú', ['#sofia']), '#sofia');
  assert.equal(contienePalabra('quiero hablar con una PERSONA', ['una persona']), 'una persona');
  assert.equal(contienePalabra('personaje', ['persona']), null);
  const db = openDb(':memory:'); const repo = crearRepo(db);
  guardarAjustes(repo, { palabrasReanudar: '#sofia', palabrasParar: ['stop ia'], canalesPausa: { instagram: true } });
  const s = new Setter({ repo, live: true, now: () => T0, random: () => 0, ghl: { addTags: async () => {}, removeTags: async () => {}, getContact: async () => ({ contact: {} }) }, aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: false }) } });
  await s.onInbound({ conversationId: 'ig', contactId: 'k', canal: 'instagram', texto: 'hola', messageId: 'a' });
  assert.match(repo.getConv('ig').pause_reason, /empiezan en pausa/);
  await s.onInbound({ conversationId: 'w', contactId: 'k2', canal: 'whatsapp', texto: 'hola', messageId: 'b' });
  assert.equal(repo.getConv('w').ai_paused, 0);
  await s.onOutbound({ conversationId: 'w', userId: 'u', texto: 'te escribo yo', messageId: 'c' });
  assert.equal(repo.getConv('w').ai_paused, 1);
  await s.onOutbound({ conversationId: 'w', userId: 'u', texto: 'listo #sofia', messageId: 'd' });
  assert.equal(repo.getConv('w').ai_paused, 0);
  guardarAjustes(repo, { pausarSiEquipoEscribe: false });
  await s.onOutbound({ conversationId: 'w', userId: 'u', texto: 'te mando la ubicación', messageId: 'e' });
  assert.equal(repo.getConv('w').ai_paused, 0);
  await s.onOutbound({ conversationId: 'w', userId: 'u', texto: 'stop ia', messageId: 'f' });
  assert.equal(repo.getConv('w').ai_paused, 1);
  await s.onInbound({ conversationId: 'w2', contactId: 'k3', canal: 'whatsapp', texto: 'por favor stop ia', messageId: 'g' });
  assert.match(repo.getConv('w2').pause_reason, /el lead escribió/);
  assert.throws(() => guardarAjustes(repo, { palabrasParar: ['#sofia'] }), /parar y reanudar/);
});

test('horario por día: un día cerrado y otro con su franja', () => {
  const dias = { domingo: null, sabado: { desde: 9, hasta: 14 } };
  assert.equal(dentroDeHorario(new Date('2026-11-22T11:00:00Z'), { dias }), false); // domingo
  assert.equal(dentroDeHorario(new Date('2026-11-21T10:00:00Z'), { dias }), true); // sábado 11:00
  assert.equal(dentroDeHorario(new Date('2026-11-21T15:00:00Z'), { dias }), false); // sábado 16:00
  assert.equal(dentroDeHorario(new Date('2026-11-17T21:00:00Z'), { dias, inicio: 8, fin: 0 }), true); // martes 22:00, horario normal
  assert.equal(siguienteApertura(new Date('2026-11-21T15:00:00Z'), { dias, inicio: 8, fin: 0 }).toISOString(), '2026-11-23T07:00:00.000Z'); // lunes 8:00
  const repo = crearRepo(openDb(':memory:'));
  guardarAjustes(repo, { horarioDias: { domingo: null, lunes: 'normal', sabado: { desde: 9, hasta: 14 } } });
  assert.deepEqual(aplicarAjustes(repo).horarioDias, { domingo: null, sabado: { desde: 9, hasta: 14 } });
  config.ai.horarioDias = {};
});

test('rendimiento por versión, estadísticas, consumo y exportar', async () => {
  const db = openDb(':memory:'); const repo = crearRepo(db);
  const crear = (id, v, extra = {}, canal = 'whatsapp') => { repo.upsertConv({ id, contact_id: id, channel: canal, nombre: id.toUpperCase(), telefono: '600' }); repo.updateConv(id, { prompt_v: v, tipo: 'captacion', ...extra }); repo.addMessage({ conversation_id: id, autor: 'lead', texto: 'hola; "precio"' }); repo.addMessage({ conversation_id: id, autor: 'ia', texto: 'te cuento' }); };
  crear('a', 1); crear('b', 1, { prueba_reservada: 1 }); crear('c', 2, { alta_estado: 'preparada', fase: 'f5 cierre', sede: 'parla' }, 'instagram');
  repo.addMessage({ conversation_id: 'b', autor: 'lead', texto: 'vale' });
  const r = rendimiento(db);
  assert.deepEqual(r.map((x) => [x.v, x.chats, x.contestan, x.prueba, x.alta]), [[2, 1, 0, 0, 1], [1, 2, 1, 1, 0]]);
  const e = estadisticas(db, { dias: 30 });
  assert.equal(e.total, 3);
  assert.equal(e.mapa.flat().reduce((a, b) => a + b, 0), 3);
  assert.deepEqual(e.embudo.map((x) => x[1]), [3, 3, 1, 2, 2, 1, 1]); // pedir prueba cuenta como haber llegado a presentación y cierre
  assert.equal(e.porCanal.find((x) => x.grupo === 'instagram').alta, 1);
  assert.equal(estadisticas(db, { sede: 'parla' }).total, 1);
  repo.logRun({ conversation_id: 'a', motivo: 'respuesta', modelo: 'claude-sonnet-5-5', tokens_in: 1e6, tokens_out: 1e5 });
  repo.logRun({ conversation_id: 'prueba-x', motivo: 'respuesta', modelo: 'claude-opus-5-5', tokens_in: 1e6 });
  assert.equal(costeRun({ modelo: 'claude-sonnet-5-5', tokens_in: 1e6, tokens_out: 1e5, tokens_cache_read: 1e6 }), 2 + 1 + 0.1);
  const c = consumo(db, { eurPorUsd: 0.9 });
  assert.equal(c.meses[0].usd, 3 + 4);
  assert.deepEqual(c.meses[0].motivos.map((x) => x.motivo).sort(), ['Probar IA', 'Respuestas a leads']);
  assert.ok(Math.abs(c.meses[0].eur - 6.3) < 1e-9);
  const csv = exportar(db, { criterios: {} });
  assert.ok(csv.startsWith('﻿chat;nombre'));
  assert.equal(csv.trim().split('\r\n').length, 4);
  assert.match(exportar(db, { formato: 'mensajes' }), /"hola; ""precio"""/);
});

test('registro de actividad: quién cambió qué', async () => {
  assert.equal(describir('PUT', '/panel/reglas/comercial-5h', { activo: false }), 'Apagó el seguimiento comercial-5h');
  assert.equal(describir('GET', '/panel/reglas', {}), null);
  assert.equal(describir('POST', '/probar/conversaciones/p/mensaje', {}), null);
  config.adminToken = 'k';
  const repo = crearRepo(openDb(':memory:'));
  const srv = crearApp({ setter: {}, repo }).listen(0); await new Promise((x) => srv.once('listening', x));
  try {
    const h = { authorization: 'Bearer k', 'content-type': 'application/json', 'x-cfmpo-user': 'carlos' };
    const base = `http://127.0.0.1:${srv.address().port}/admin`;
    await fetch(base + '/panel/etiquetas', { method: 'POST', headers: h, body: JSON.stringify({ nombre: 'VIP' }) });
    await fetch(base + '/panel/etiquetas', { method: 'POST', headers: h, body: JSON.stringify({ nombre: '' }) }); // error: no se apunta
    const a = await (await fetch(base + '/panel/actividad', { headers: h })).json();
    assert.deepEqual(a.actividad.map((x) => [x.quien, x.accion]), [['carlos', 'Creó la etiqueta «VIP»']]);
  } finally { srv.close(); }
});

test('resumen legible de las instrucciones: se guarda con la versión', async () => {
  const db = openDb(':memory:'); let n = 0;
  const completeJSON = async () => { n++; return { model: 'claude-opus-5-5', usage: { input_tokens: 5000, output_tokens: 800 }, content: [{ type: 'text', text: JSON.stringify({ apartados: [{ titulo: 'Lo que nunca hace', puntos: ['inventar precios'] }, { titulo: 'Quién es y cómo habla', puntos: ['Sofía, cercana'] }] }) }] }; };
  const r = await resumenInstrucciones(db, { completeJSON });
  assert.deepEqual(r.apartados.map((a) => a.titulo), ['Quién es y cómo habla', 'Lo que nunca hace']);
  await resumenInstrucciones(db, { completeJSON });
  assert.equal(n, 1); // segunda vez, de caché
  assert.equal(db.prepare("SELECT count(*) n FROM ai_runs WHERE motivo = 'resumen-instrucciones'").get().n, 1);
});
