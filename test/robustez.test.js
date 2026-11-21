import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, repo as crearRepo, copiaSeguridad } from '../src/db.js';
import { Setter } from '../src/setter.js';
import { Ghl } from '../src/ghl.js';
import { procesarSeguimientos } from '../src/followups.js';
import { recuperar, bucle, buclesParados } from '../src/arranque.js';
import { config } from '../src/config.js';
import { crearApp } from '../src/server.js';

const T0 = new Date('2026-11-17T11:00:00Z'); // martes 12:00 en Madrid
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const responder = (mensajes) => ({ content: [{ type: 'tool_use', id: 't', name: 'responder', input: { mensajes, fase: 'f2 diagnóstico' } }] });

function montar({ complete, ghl = {}, live = true } = {}) {
  const repo = crearRepo(openDb(':memory:'));
  const sal = { enviados: [], avisos: [] };
  let reloj = new Date(T0);
  const setter = new Setter({
    repo, live, sleep: async () => {}, now: () => reloj, random: () => 0, complete,
    avisar: async (t) => sal.avisos.push(t),
    ghl: { sendMessage: async ({ texto }) => { sal.enviados.push(texto); return { messageId: `m${sal.enviados.length}` }; }, addTags: async () => {}, removeTags: async () => {}, assign: async () => {}, addNote: async () => {}, getContact: async () => ({ contact: {} }), ...ghl },
    aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: false }) },
  });
  const chat = (id) => { repo.upsertConv({ id, contact_id: `k${id}`, channel: 'whatsapp' }); repo.updateConv(id, { tipo: 'captacion', respond_at: T0.toISOString(), last_inbound_at: T0.toISOString() }); repo.addMessage({ conversation_id: id, autor: 'lead', texto: 'hola', created_at: T0.toISOString() }); };
  return { repo, setter, sal, chat, avanzar: (ms) => { reloj = new Date(reloj.getTime() + ms); } };
}

test('GHL: tiempo límite, reintenta lecturas y 429, pero nunca reenvía un mensaje tras un corte', async () => {
  const llamadas = [];
  const fetchCon = (respuestas) => async (url, o) => { llamadas.push(o.method); assert.ok(o.signal instanceof AbortSignal); const r = respuestas.shift(); if (r instanceof Error) throw r; return { ok: r < 400, status: r, headers: new Headers(), text: async () => '{}' }; };
  let g = new Ghl({ token: 't', baseUrl: 'https://x', fetchImpl: fetchCon([new Error('ECONNRESET'), 503, 200]) });
  await g.req('GET', '/a', null, { esperaMs: 1 });
  assert.equal(llamadas.length, 3);
  llamadas.length = 0;
  g = new Ghl({ token: 't', baseUrl: 'https://x', fetchImpl: fetchCon([new Error('ECONNRESET'), 200]) });
  await assert.rejects(g.sendMessage({ contactId: 'k', canal: 'whatsapp', texto: 'hola' }), /ECONNRESET/);
  assert.equal(llamadas.length, 1); // no se repite: podría salir duplicado
  llamadas.length = 0;
  g = new Ghl({ token: 't', baseUrl: 'https://x', fetchImpl: fetchCon([429, 200]) });
  await g.req('POST', '/conversations/messages', { a: 1 }, { esperaMs: 1 });
  assert.equal(llamadas.length, 2); // 429 = GHL no lo procesó: sí se reintenta
  g = new Ghl({ token: 't', baseUrl: 'https://x', fetchImpl: fetchCon([500]) });
  await assert.rejects(g.req('POST', '/x', {}), /500/);
});

test('varios chats a la vez: uno lento no retrasa a los demás, con un máximo en paralelo', async () => {
  let activos = 0; let pico = 0;
  const { repo, setter, sal, chat } = montar({ complete: async () => { activos++; pico = Math.max(pico, activos); await espera(40); activos--; return responder(['hola!']); } });
  setter.maxParalelo = 3;
  for (const id of ['a', 'b', 'c', 'd', 'e']) chat(id);
  await setter.tick();
  assert.equal(pico, 3); // los tres a la vez, no uno detrás de otro
  assert.equal(sal.enviados.length, 3);
  await setter.tick();
  assert.equal(sal.enviados.length, 5);
  assert.equal(repo.db.prepare('SELECT count(*) n FROM conversations WHERE respondiendo_desde IS NOT NULL OR respond_at IS NOT NULL').get().n, 0);
});

test('si la IA falla se reintenta a los 2 y 5 minutos; solo avisa al equipo cuando se rinde', async () => {
  let n = 0;
  const { repo, setter, sal, chat, avanzar } = montar({ complete: async () => { n++; if (n <= 2) throw new Error('API caída'); return responder(['ya estoy']); } });
  chat('a');
  await setter.tick();
  let c = repo.getConv('a');
  assert.equal(c.reintentos, 1);
  assert.equal(c.respond_at, new Date(T0.getTime() + 2 * 60000).toISOString());
  assert.equal(sal.avisos.length, 0);
  await setter.tick(); // todavía no toca
  assert.equal(n, 1);
  avanzar(2 * 60000 + 1000); await setter.tick();
  assert.equal(repo.getConv('a').reintentos, 2);
  avanzar(5 * 60000 + 1000); await setter.tick();
  assert.deepEqual(sal.enviados, ['ya estoy']);
  assert.equal(repo.getConv('a').reintentos, 0);
  // Si falla siempre: tres intentos, un aviso y no se queda en bucle
  const m = montar({ complete: async () => { throw new Error('API caída'); } });
  m.chat('z');
  await m.setter.tick(); m.avanzar(3 * 60000); await m.setter.tick(); m.avanzar(6 * 60000); await m.setter.tick();
  assert.equal(m.sal.avisos.length, 1);
  assert.equal(m.repo.getConv('z').respond_at, null);
});

test('si GHL falla a mitad de un envío, no se reintenta (no se repite lo que ya salió)', async () => {
  let k = 0;
  const { repo, setter, sal, chat } = montar({ complete: async () => responder(['uno', 'dos']), ghl: { sendMessage: async ({ texto }) => { if (++k === 2) throw new Error('GHL 500'); sal.enviados.push(texto); return { messageId: 'm' }; } } });
  chat('a');
  await setter.tick();
  assert.deepEqual(sal.enviados, ['uno']);
  assert.equal(repo.getConv('a').respond_at, null);
});

test('si alguien del equipo escribe mientras Sofía piensa, no se envía nada', async () => {
  const { repo, setter, sal, chat } = montar({ complete: async () => { await setter.onOutbound({ conversationId: 'a', userId: 'u', texto: 'te atiendo yo', messageId: 'h1' }); return responder(['hola!']); } });
  chat('a');
  await setter.tick();
  assert.deepEqual(sal.enviados, []);
  assert.equal(repo.getConv('a').ai_paused, 1);
});

test('reinicio a mitad: los chats que se estaban contestando vuelven a la cola; envíos y reportes a medias quedan marcados', () => {
  const repo = crearRepo(openDb(':memory:'));
  for (const id of ['a', 'b']) repo.upsertConv({ id, contact_id: id, channel: 'whatsapp' });
  repo.updateConv('a', { respondiendo_desde: T0.toISOString() });
  repo.updateConv('b', { respondiendo_desde: T0.toISOString(), ai_paused: 1 });
  repo.schedule('a', 'comercial-5h', T0.toISOString());
  repo.db.prepare("UPDATE scheduled SET estado = 'enviando'").run();
  repo.db.prepare("INSERT INTO reportes (origen, que_fallo, estado) VALUES ('general', 'x', 'analizando')").run();
  assert.deepEqual(recuperar(repo.db, T0), { chats: 1, seguimientos: 1, reportes: 1 });
  assert.equal(repo.getConv('a').respond_at, T0.toISOString());
  assert.equal(repo.getConv('b').respond_at, null);
  assert.equal(repo.getConv('b').respondiendo_desde, null);
  assert.equal(repo.db.prepare('SELECT estado FROM scheduled').get().estado, 'error');
  assert.equal(repo.db.prepare('SELECT estado FROM reportes').get().estado, 'error');
});

test('seguimientos: dos vueltas a la vez no lo envían dos veces, y si el lead escribe mientras se redacta no sale', async () => {
  let entrar; const dentro = new Promise((r) => { entrar = r; });
  let soltar; const puerta = new Promise((r) => { soltar = r; });
  const { repo, setter, sal, chat } = montar({ complete: async () => { entrar(); await puerta; return responder(['sigues ahí?']); } });
  chat('a'); repo.updateConv('a', { respond_at: null });
  repo.schedule('a', 'comercial-5h', T0.toISOString(), null, 'silencio');
  const v1 = procesarSeguimientos(setter); await dentro;
  const v2 = procesarSeguimientos(setter); // segunda vuelta mientras la primera redacta
  soltar(); await Promise.all([v1, v2]);
  assert.deepEqual(sal.enviados, ['sigues ahí?']);
  // El lead escribe mientras Sofía redacta: se cancela y no sale
  const m = montar({ complete: async () => { m.repo.cancelScheduled('b', 'el lead escribió', { soloCortos: true }); return responder(['hola?']); } });
  m.chat('b'); m.repo.updateConv('b', { respond_at: null });
  m.repo.schedule('b', 'comercial-5h', T0.toISOString(), null, 'silencio');
  await procesarSeguimientos(m.setter);
  assert.deepEqual(m.sal.enviados, []);
  assert.equal(m.repo.db.prepare('SELECT estado FROM scheduled').get().estado, 'cancelado');
});

test('bucles: no se solapan, sobreviven a los errores y se detecta si se paran', async () => {
  const registro = {}; let dentro = 0; let pico = 0; let vueltas = 0;
  const b = bucle('prueba', 5, async () => { vueltas++; dentro++; pico = Math.max(pico, dentro); await espera(25); dentro--; if (vueltas === 2) throw new Error('fallo suelto'); }, { registro });
  await espera(140); b.parar();
  assert.equal(pico, 1);
  assert.ok(vueltas >= 3, 'sigue después de un error');
  assert.ok(registro.prueba.ultima);
  assert.deepEqual(buclesParados({ x: { cadaMs: 5000, ultima: Date.now() - 10 * 60000 } }), ['x']);
  assert.deepEqual(buclesParados({ x: { cadaMs: 5000, ultima: Date.now() - 30000 } }), []);
  assert.deepEqual(buclesParados({ x: { cadaMs: 5000, ultima: null } }, Date.now(), 30000), []); // recién arrancado
});

test('copia de seguridad diaria: una por día y se borran las viejas', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-')); const ruta = path.join(dir, 'setter.db');
  const db = openDb(ruta); crearRepo(db).upsertConv({ id: 'a', contact_id: 'k', channel: 'whatsapp' });
  for (const d of ['2026-11-01', '2026-11-02', '2026-11-03']) await copiaSeguridad(db, ruta, { dias: 2, ahora: new Date(`${d}T03:00:00Z`) });
  assert.equal(await copiaSeguridad(db, ruta, { dias: 2, ahora: new Date('2026-11-03T09:00:00Z') }), null);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'backups')).sort(), ['setter-2026-11-02.db', 'setter-2026-11-03.db']);
  const copia = openDb(path.join(dir, 'backups', 'setter-2026-11-03.db'));
  assert.equal(copia.prepare('SELECT count(*) n FROM conversations').get().n, 1);
  db.close(); copia.close();
});

test('salud y errores de ruta: /health da 503 si un bucle está parado; un error interno responde JSON sin detalles', async () => {
  config.adminToken = 'k';
  const repo = crearRepo(openDb(':memory:'));
  let sano = true;
  const srv = crearApp({ setter: {}, repo, salud: () => ({ ok: sano, bucles_parados: sano ? [] : ['respuestas'] }) }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.deepEqual(await (await fetch(base + '/health')).json(), { ok: true, modo: config.mode });
    sano = false;
    const r = await fetch(base + '/health');
    assert.equal(r.status, 503);
    assert.deepEqual((await r.json()).bucles_parados, ['respuestas']);
    const mal = await fetch(base + '/admin/panel/vistas', { method: 'POST', headers: { authorization: 'Bearer k', 'content-type': 'application/json' }, body: '{mal json' });
    assert.equal(mal.status, 400);
    assert.deepEqual(await mal.json(), { error: 'Petición mal formada.' });
  } finally { srv.close(); }
});

// ---------- Hallazgos de la revisión de código ----------
import { runTurn } from '../src/llm.js';
import { parseWebhook } from '../src/ghl.js';
import * as etq from '../src/etiquetas.js';
import * as reglasSeg from '../src/reglas.js';
import { programarPorEtiqueta, destinatarios } from '../src/followups.js';
import { sincronizarSocios } from '../src/aimharder/index.js';

test('si el modelo pide otra herramienta junto a responder, también se ejecuta', async () => {
  const hechas = [];
  const r = await runTurn({ system: [], messages: [{ role: 'user', content: 'x' }], ejecutarHerramienta: async (n) => { hechas.push(n); return { ok: true }; },
    complete: async () => ({ content: [{ type: 'tool_use', id: 'a', name: 'derivar_a_equipo', input: { motivo: 'salud', resumen: 'x' } }, { type: 'tool_use', id: 'b', name: 'responder', input: { mensajes: ['te escribe el equipo'], fase: 'f2 diagnóstico' } }] }) });
  assert.deepEqual(hechas, ['derivar_a_equipo']);
  assert.deepEqual(r.respuesta.mensajes, ['te escribe el equipo']);
  await assert.rejects(runTurn({ system: [], messages: [{ role: 'user', content: 'x' }], ejecutarHerramienta: async () => ({}), complete: async () => ({ content: [], stop_reason: 'max_tokens' }) }), /cortó/);
});

test('webhook con etiquetas y adjuntos como texto', () => {
  const e = parseWebhook({ type: 'InboundMessage', conversationId: 'c', contactId: 'k', tags: 'parla, hot lead', attachments: 'https://x/a.ogg' });
  assert.deepEqual(e.tags, ['parla', 'hot lead']);
  assert.deepEqual(e.adjuntos, ['https://x/a.ogg']);
  assert.equal(parseWebhook({ conversationId: 'c', contactId: 'k' }).tags, null);
});

test('aplicar una etiqueta a chats de antes no pausa, no fuerza respuesta ni programa seguimientos; la inactividad no toca chats viejos', async () => {
  const repo = crearRepo(openDb(':memory:')); const db = repo.db; const avisos = [];
  const e = new etq.Etiquetador({ repo, avisar: async (t) => avisos.push(t), now: () => T0, alPoner: (c, id) => programarPorEtiqueta(repo, db, c, id, T0) });
  const lab = etq.crear(db, { nombre: 'Precio', reglas: [{ tipo: 'texto', patron: 'precio' }, { tipo: 'inactividad', horas: 24 }], acciones: { forzar_respuesta: true, avisar: true, pausar_ia: false } });
  reglasSeg.crear(db, { nombre: 'Tras precio', tipo: 'etiqueta', etiquetaId: lab.id, canales: ['whatsapp'], minutos: 60, instrucciones: 'x' });
  repo.upsertConv({ id: 'viejo', contact_id: 'k', channel: 'whatsapp' });
  repo.addMessage({ conversation_id: 'viejo', autor: 'lead', texto: 'qué precio tiene', created_at: '2026-06-01T10:00:00.000Z' });
  repo.addMessage({ conversation_id: 'viejo', autor: 'ia', texto: 'te cuento', created_at: '2026-06-01T10:01:00.000Z' });
  assert.equal(await e.revisarInactividad(), 0); // de junio: demasiado antiguo
  assert.deepEqual(await e.aplicarAAnteriores(lab.id), { aplicadas: 1, revisados: 1 });
  assert.equal(repo.getConv('viejo').respond_at, null);
  assert.equal(avisos.length, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM scheduled').get().n, 0);
});

test('seguimientos y lanzamientos no llegan a quien ya es socio, tiene el alta o pidió no recibir mensajes', async () => {
  const { repo, setter, sal, chat } = montar({ complete: async () => responder(['sigues ahí?']) });
  setter.aimharder.buscarSocioPorTelefono = async (t) => ({ esSocio: t === '600111222' });
  chat('a'); repo.updateConv('a', { respond_at: null, telefono: '600111222' });
  repo.schedule('a', 'comercial-5h', T0.toISOString(), null, 'silencio');
  await procesarSeguimientos(setter);
  assert.deepEqual(sal.enviados, []);
  assert.equal(repo.getConv('a').tipo, 'socio');
  const hace = new Date(Date.now() - 864e5).toISOString();
  for (const [id, extra] of [['ok', {}], ['alta', { alta_estado: 'preparada' }], ['stop', { ai_paused: 1, pause_reason: 'el lead escribió «baja»' }]]) { repo.upsertConv({ id, contact_id: id, channel: 'whatsapp' }); repo.updateConv(id, { last_inbound_at: hace, tipo: 'captacion', ...extra }); }
  assert.deepEqual(destinatarios(repo.db, { canales: ['whatsapp'] }).map((x) => x.id), ['ok']);
  // Aunque ya estuviera en la cola del lanzamiento, tampoco sale
  repo.schedule('stop', 'lanzamiento-1', T0.toISOString(), null, 'lanzamiento', 'oferta');
  await procesarSeguimientos(setter);
  assert.equal(repo.db.prepare("SELECT detalle FROM scheduled WHERE regla_id = 'lanzamiento-1'").get().detalle, 'pidió no recibir mensajes');
});

test('alta ya hecha no se repite, y un audio a medio transcribir no se contesta todavía', async () => {
  let altas = 0;
  const { repo, setter, chat } = montar({ complete: async () => responder(['ok']) });
  setter.aimharder.prepararAlta = async () => { altas++; return { estado: 'preparada', pendiente: 10 }; };
  chat('a'); repo.updateConv('a', { alta_estado: 'preparada' });
  const r = await setter.herramienta(repo.getConv('a'), 'preparar_alta', { sede: 'parla', tarifa: 'academy_2', nombre_completo: 'A', email: 'a@b.es', fecha_nacimiento: '1990-01-01', fecha_inicio: '2026-11-23' }, { tags: new Set() });
  assert.equal(r.estado, 'ya_preparada');
  assert.equal(altas, 0);
  // Audio en curso: tick lo salta sin borrar su turno
  let soltar; const puerta = new Promise((x) => { soltar = x; });
  setter.medios = { procesarAdjuntos: async () => { await puerta; return { adjunto: 'audio', media_ruta: 'm/a.ogg', media_mime: 'audio/ogg', transcripcion: 'quiero info', media_error: null }; } };
  const p = setter.onInbound({ conversationId: 'b', contactId: 'kb', canal: 'whatsapp', texto: '', messageId: 'au1', adjuntos: ['https://x/a.ogg'] });
  await espera(5);
  repo.updateConv('b', { respond_at: T0.toISOString(), tipo: 'captacion' }); // llega un texto después y lo pone en cola
  await setter.tick();
  assert.equal(repo.getConv('b').respond_at, T0.toISOString()); // sigue esperando al audio
  soltar(); await p;
  assert.equal(repo.history('b')[0].transcripcion, 'quiero info');
});

test('una lista de socios vacía o recortada de AimHarder no borra el índice', async () => {
  const repo = crearRepo(openDb(':memory:'));
  const cli = (n) => Array.from({ length: n }, (_, i) => ({ id: i, name: 'S', mobile_number: `6${String(10000000 + i)}`, current_memberships: [{ membership_name: 'L' }] }));
  await sincronizarSocios(repo, { parla: { clientes: async () => cli(40) } });
  await assert.rejects(sincronizarSocios(repo, { parla: { clientes: async () => [] } }), /no se actualiza/);
  assert.equal(repo.db.prepare('SELECT count(*) n FROM socios').get().n, 40);
  await sincronizarSocios(repo, { parla: { clientes: async () => cli(38) } });
  assert.equal(repo.db.prepare('SELECT count(*) n FROM socios').get().n, 38);
});

test('alta en El Cañaveral: inicio el 1 de febrero, descuento del tramo y primer pago en la fecha del alta', async () => {
  const { repo, setter, sal, chat } = montar({ complete: async () => responder(['ok']) });
  let navegador = 0; setter.aimharder.prepararAlta = async () => { navegador++; return { estado: 'preparada', pendiente: 1 }; };
  const datos = { sede: 'el_canaveral', tarifa: 'academy_2', nombre_completo: 'Lucía Pérez', email: 'lucia@ejemplo.es', telefono: '600111222', fecha_nacimiento: '1990-01-01', fecha_inicio: '2026-12-01' };
  chat('c1');
  const r = await setter.herramienta(repo.getConv('c1'), 'preparar_alta', datos, { tags: new Set() });
  assert.deepEqual([r.ok, r.estado, r.fecha_inicio, r.descuento_pct, r.primer_pago], [true, 'pendiente_equipo', '2027-02-01', 50, 47.5]);
  assert.equal(navegador, 0); // el alta automática de AimHarder no se usa en El Cañaveral
  assert.match(sal.avisos.at(-1), /Descuento de apertura 50 % \(plaza 1, tramo 1 a 10\).*47,5 €\/mes; desde mayo, 95 €\/mes/s);
  assert.match(sal.avisos.at(-1), /Primer recibo: 47,5 €, emitido hoy/);
  assert.equal(repo.getConv('c1').alta_estado, 'pendiente');
  // No se repite, y la siguiente persona cuenta las plazas ya ocupadas (9 apuntadas por el equipo + la de Sofía = plaza 11, 30 %)
  assert.equal((await setter.herramienta(repo.getConv('c1'), 'preparar_alta', datos, { tags: new Set() })).estado, 'ya_en_tramite');
  repo.guardarAjuste('canaveralPlazasOcupadas', 9);
  chat('c2');
  const r2 = await setter.herramienta(repo.getConv('c2'), 'preparar_alta', { ...datos, tarifa: 'XL', email: 'otra@ejemplo.es' }, { tags: new Set() });
  assert.deepEqual([r2.descuento_pct, r2.primer_pago, r2.cuota_desde_mayo], [30, 84, 120]);
  // Datos incompletos: se pide lo que falta y no ocupa plaza; academy_1 solo existe en El Cañaveral
  chat('c3');
  const r3 = await setter.herramienta(repo.getConv('c3'), 'preparar_alta', { ...datos, nombre_completo: 'Ana' }, { tags: new Set() });
  assert.equal(r3.ok, false);
  assert.equal(setter.plazasCanaveral(), 11);
  assert.equal((await setter.herramienta(repo.getConv('c3'), 'preparar_alta', { ...datos, sede: 'getafe', tarifa: 'academy_1' }, { tags: new Set() })).ok, false);
});

test('El Cañaveral: las plazas ocupadas salen del registro de AimHarder, sin contar dos veces las altas de Sofía', async () => {
  const { plazasCanaveral, leerRegistro } = await import('../src/canaveral.js');
  const { repo } = montar({ complete: async () => responder(['ok']) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-')); const ruta = path.join(dir, 'ledger.json');
  const fila = (tel) => ({ tab: 'Bloque 50%', row: ['1', 'Nombre', tel], assignment_id: 'a', receipt_id: 'r' });
  fs.writeFileSync(ruta, JSON.stringify({ 1: fila('600000001'), 2: fila('600000002'), 3: fila('+34 600 111 222') }));
  repo.guardarAjuste('canaveralPlazasOcupadas', 40);
  assert.equal(leerRegistro(ruta).anotados, 3);
  assert.deepEqual(plazasCanaveral(repo, { ruta }), { total: 3, origen: 'registro', base: 3, propias: 0, actualizado: leerRegistro(ruta).actualizado });
  // Un alta de Sofía que ya está en el registro (mismo teléfono) no suma; otra que aún no está, sí
  repo.addAlta('x1', { sede: 'el_canaveral', telefono: '600111222' }, 'pendiente');
  repo.addAlta('x2', { sede: 'el_canaveral', telefono: '+34600999888' }, 'pendiente');
  repo.addAlta('x3', { sede: 'getafe', telefono: '600555444' }, 'pendiente');
  assert.equal(plazasCanaveral(repo, { ruta }).total, 4);
  assert.equal(plazasCanaveral(repo, { ruta, sinConv: 'x2' }).total, 3);
  // Registro ilegible o con otra forma: vuelve al número apuntado a mano
  fs.writeFileSync(ruta, '[1,2]');
  assert.deepEqual([plazasCanaveral(repo, { ruta }).origen, plazasCanaveral(repo, { ruta }).total], ['manual', 42]);
  assert.equal(plazasCanaveral(repo, { ruta: path.join(dir, 'no-existe.json') }).total, 42);
});
