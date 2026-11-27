import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import { config } from '../src/config.js';
import { procesarSeguimientos } from '../src/followups.js';
import { reservarEnAimHarder, buscarSesion, ultimaPrueba, resultadoTrialOps, describirTrialOps, partirNombre, pruebaTrialOps } from '../src/clase-prueba.js';
import * as preguntas from '../src/preguntas.js';

const T0 = new Date('2026-11-17T11:00:00Z'); // martes 12:00 en Madrid
const SESIONES = [
  { schedule_id: 1, time: '19:30', name: 'CrossFit', cancelled: false },
  { schedule_id: 2, time: '18:30', name: 'CrossFit Academy ', cancelled: false },
  { schedule_id: 3, time: '20:30', name: 'Hyrox', cancelled: false },
  { schedule_id: 4, time: '10:00', name: 'CrossFit Partner', cancelled: false },
  { schedule_id: 5, time: '17:30', name: 'CrossFit', cancelled: true },
];
const apiFalsa = (extra = {}) => ({ llamadas: [], async calendario() { return SESIONES; }, async reservarInvitado(d) { this.llamadas.push(d); return { id: 991 }; }, ...extra });

function montar({ respuestas = [], aimharder = {}, live = true } = {}) {
  const repo = crearRepo(openDb(':memory:'));
  const sal = { enviados: [], requests: [], avisos: [], notas: [], tags: [] };
  let reloj = new Date(T0);
  const cola = [...respuestas];
  const ghl = {
    sendMessage: async ({ texto }) => { sal.enviados.push(texto); return { messageId: `m${sal.enviados.length}` }; },
    enviarPorPlantilla: async () => ({}), addTags: async (_, t) => { sal.tags.push(...t); }, removeTags: async () => {}, assign: async () => {},
    addNote: async (_, body) => { sal.notas.push(['nueva', body]); return { note: { id: `n${sal.notas.length}` } }; },
    updateNote: async (_, id, body) => { sal.notas.push(['actualiza', body, id]); return {}; },
    getContact: async () => ({ contact: {} }),
  };
  const setter = new Setter({
    repo, ghl, live, sleep: async () => {}, now: () => reloj, random: () => 0, avisar: async (t) => { sal.avisos.push(t); },
    aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: false }), ...aimharder },
    complete: async (req) => { sal.requests.push(req); const r = cola.shift(); if (!r) throw new Error('sin respuesta'); return { content: r.map((b, i) => ({ type: 'tool_use', id: `t${i}`, ...b })) }; },
  });
  repo.upsertConv({ id: 'c1', contact_id: 'k1', channel: 'whatsapp', nombre: 'Ana', telefono: '+34600111222' });
  repo.updateConv('c1', { tipo: 'captacion', sede: 'parla', last_inbound_at: T0.toISOString() });
  repo.addMessage({ conversation_id: 'c1', autor: 'lead', texto: 'hola', created_at: T0.toISOString() });
  return { repo, db: repo.db, setter, sal, avanzar: (ms) => { reloj = new Date(reloj.getTime() + ms); } };
}
const responder = (input) => [{ name: 'responder', input: { fase: 'f5 cierre', ...input } }];
const resultadoHerramienta = (req, nombre) => {
  const usos = req.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  const id = usos.find((b) => b.type === 'tool_use' && b.name === nombre)?.id;
  const r = usos.find((b) => b.type === 'tool_result' && b.tool_use_id === id);
  return r ? JSON.parse(typeof r.content === 'string' ? r.content : r.content[0].text) : null;
};

// ---------- Reserva en AimHarder ----------

test('la sesión se busca por modalidad y hora exactas (CrossFit no es Partner ni Academy; las anuladas no cuentan)', () => {
  assert.equal(buscarSesion(SESIONES, 'crossfit', '19:30').schedule_id, 1);
  assert.equal(buscarSesion(SESIONES, 'academy', '18:30').schedule_id, 2);
  assert.equal(buscarSesion(SESIONES, 'crossfit', '10:00'), null);
  assert.equal(buscarSesion(SESIONES, 'crossfit', '17:30'), null);
  assert.deepEqual(partirNombre('Ana López García'), { name: 'Ana', first_surname: 'López', second_surname: 'García' });
});

test('reserva en AimHarder: comprueba la clase, no escribe si no toca y manda los datos del invitado', async () => {
  const api = apiFalsa();
  const base = { modalidad: 'crossfit', fecha: '2026-11-19', hora: '19:30', nombre_completo: 'Ana López', telefono: '+34600111222', email: 'ana@x.es' };
  const no = await reservarEnAimHarder(api, { ...base, hora: '19:00' }, { escribir: true });
  assert.equal(no.estado, 'no_hay_clase');
  assert.deepEqual(no.horas, ['19:30']);
  assert.equal((await reservarEnAimHarder(api, base, { escribir: false })).estado, 'simulada');
  assert.equal(api.llamadas.length, 0);
  const ok = await reservarEnAimHarder(api, base, { escribir: true });
  assert.deepEqual([ok.estado, ok.booking_id], ['reservada', '991']);
  assert.deepEqual(api.llamadas[0], { schedule_id: 1, booking_date: '2026-11-19', name: 'Ana', first_surname: 'López', email: 'ana@x.es', phone: '+34600111222', booking_notes: 'Clase de prueba reservada por Sofía (WhatsApp/Instagram)' });
  const mal = await reservarEnAimHarder(apiFalsa({ async reservarInvitado() { throw new Error('clase completa'); } }), base, { escribir: true });
  assert.deepEqual([mal.estado, mal.detalle], ['fallida', 'clase completa']);
  // AimHarder contesta sin número de reserva (o con uno que no es un número): no consta como reservada
  for (const r of [{ ok: true }, { id: 'abc' }, null]) {
    const sinId = await reservarEnAimHarder(apiFalsa({ async reservarInvitado() { return r; } }), base, { escribir: true });
    assert.equal(sinId.estado, 'fallida', JSON.stringify(r));
    assert.match(sinId.detalle, /sin número de reserva/);
  }
});

test('metro-trial-ops: se reutiliza la conexión y se vuelve a abrir si sustituyen el archivo', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-ops-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ruta = path.join(dir, 'trial_ops.sqlite3');
  const crear = (clase) => {
    const db = new Database(ruta);
    db.exec('CREATE TABLE trials (contact_id TEXT, center TEXT, class_type TEXT, start_time TEXT, lifecycle TEXT, outcome TEXT, appointment_status TEXT)');
    db.prepare('INSERT INTO trials VALUES (?, ?, ?, ?, ?, ?, ?)').run('k1', 'Parla', clase, '2026-11-19T18:30:00Z', 'booked', null, 'confirmed');
    db.close();
  };
  crear('CrossFit');
  assert.equal(pruebaTrialOps('k1', ruta).class_type, 'CrossFit');
  assert.equal(pruebaTrialOps('k1', ruta).class_type, 'CrossFit');
  assert.equal(pruebaTrialOps('otro', ruta), null);
  fs.rmSync(ruta); crear('Hyrox'); // archivo nuevo (otro inodo)
  assert.equal(pruebaTrialOps('k1', ruta).class_type, 'Hyrox');
  fs.rmSync(ruta);
  assert.equal(pruebaTrialOps('k1', ruta), null, 'sin archivo, sin dato');
});

test('Sofía reserva la prueba en AimHarder (live + AIMHARDER_RESERVA_PRUEBA) y al cambiarla anula la anterior', async (t) => {
  const antes = config.aimharder.reservaPrueba; config.aimharder.reservaPrueba = true; t.after(() => { config.aimharder.reservaPrueba = antes; });
  const api = apiFalsa(); const anuladas = [];
  const { repo, db, setter, sal } = montar({
    aimharder: { reservarPrueba: (d, o) => reservarEnAimHarder(api, d, o), cancelarPrueba: async (p) => { anuladas.push(p.booking_id); return true; } },
    respuestas: [
      [{ name: 'reservar_prueba_parla', input: { modalidad: 'crossfit', fecha_hora: '2026-11-19 19:30', nombre_completo: 'Ana' } }],
      [{ name: 'reservar_prueba_parla', input: { modalidad: 'crossfit', fecha_hora: '2026-11-19 19:30', nombre_completo: 'Ana López', email: 'ana@example.com' } }],
      responder({ mensajes: ['listo, jueves a las 19:30'] }),
      [{ name: 'reservar_prueba_parla', input: { modalidad: 'hyrox', fecha_hora: '2026-11-19 20:30', nombre_completo: 'Ana López', email: 'ana@example.com' } }],
      responder({ mensajes: ['cambiada'] }),
    ],
  });
  await setter.responder('c1');
  assert.match(resultadoHerramienta(sal.requests[1], 'reservar_prueba_parla').error, /nombre y un apellido/);
  const p = ultimaPrueba(db, 'c1');
  assert.deepEqual([p.estado, p.booking_id, p.schedule_id], ['reservada', '991', 1]);
  assert.match(sal.avisos.at(-1), /Prueba reservada en AimHarder \(Parla\): Ana López · crossfit · jueves, 19 de noviembre a las 19:30/);
  assert.equal(repo.getConv('c1').prueba_reservada, 1);
  assert.ok(repo.db.prepare("SELECT 1 FROM scheduled WHERE conversation_id = 'c1' AND regla_id = 'tras-prueba' AND estado = 'pendiente'").get());
  repo.addMessage({ conversation_id: 'c1', autor: 'lead', texto: 'mejor hyrox a las 20:30' });
  await setter.responder('c1');
  assert.deepEqual(anuladas, ['991']);
  assert.equal(ultimaPrueba(db, 'c1').modalidad, 'hyrox');
  assert.equal(db.prepare("SELECT count(*) n FROM pruebas_clase WHERE estado = 'anulada'").get().n, 1);
  assert.match(setter.contexto(repo.getConv('c1')), /Clase de prueba de hyrox en Parla el jueves, 19 de noviembre a las 20:30: reservada en AimHarder/);
});

test('la prueba no se reserva sin email, ni sin teléfono si no escribe por WhatsApp', async () => {
  const reservas = [];
  const { repo, db, setter, sal } = montar({
    aimharder: { reservarPrueba: async (d) => { reservas.push(d); return { estado: 'simulada' }; } },
    respuestas: [
      [{ name: 'reservar_prueba_parla', input: { modalidad: 'academy', fecha_hora: '2026-11-19 19:30', nombre_completo: 'Ana López' } }],
      [{ name: 'reservar_prueba_parla', input: { modalidad: 'academy', fecha_hora: '2026-11-19 19:30', nombre_completo: 'Ana López', email: 'ana' } }],
      responder({ mensajes: ['pásame tu email y te la reservo'] }),
    ],
  });
  await setter.responder('c1');
  assert.match(resultadoHerramienta(sal.requests[1], 'reservar_prueba_parla').error, /email/);
  assert.equal(reservas.length, 0);
  assert.ok(!ultimaPrueba(db, 'c1'));
  // Instagram: sin teléfono en la conversación hace falta que lo dé
  repo.upsertConv({ id: 'c1', telefono: null }); repo.db.prepare("UPDATE conversations SET telefono = NULL, channel = 'instagram' WHERE id = 'c1'").run();
  const r = await setter.reservarPrueba(repo.getConv('c1'), { modalidad: 'academy', fecha_hora: '2026-11-19 19:30', nombre_completo: 'Ana López', email: 'ana@example.com' }, { tags: new Set() });
  assert.match(r.error, /teléfono/);
  const ok = await setter.reservarPrueba(repo.getConv('c1'), { modalidad: 'academy', fecha_hora: '2026-11-19 19:30', nombre_completo: 'Ana López', email: 'ana@example.com', telefono: '600111333' }, { tags: new Set() });
  assert.equal(ok.ok, true);
  assert.deepEqual([reservas[0].email, reservas[0].telefono], ['ana@example.com', '600111333']);
});

test('sin reserva directa (modo prueba) se comprueba la clase y se avisa al equipo como antes', async () => {
  const api = apiFalsa();
  const { db, setter, sal } = montar({ live: false, aimharder: { reservarPrueba: (d, o) => reservarEnAimHarder(api, d, o) }, respuestas: [
    [{ name: 'reservar_prueba_parla', input: { modalidad: 'crossfit', fecha_hora: '2026-11-19 19:00', nombre_completo: 'Ana López', email: 'ana@example.com' } }],
    [{ name: 'reservar_prueba_parla', input: { modalidad: 'crossfit', fecha_hora: '2026-11-19 19:30', nombre_completo: 'Ana López', email: 'ana@example.com' } }],
    responder({ mensajes: ['te la dejo apuntada'] }),
  ] });
  await setter.responder('c1');
  assert.deepEqual(resultadoHerramienta(sal.requests[1], 'reservar_prueba_parla').horas_ese_dia, ['19:30']);
  assert.equal(api.llamadas.length, 0);
  assert.equal(ultimaPrueba(db, 'c1').estado, 'simulada');
  assert.match(sal.avisos.at(-1), /Prueba en Parla pedida: .*Reservarla en AimHarder y confirmar al lead/);
});

// ---------- Seguimiento después de la prueba ----------

test('resultado de metro-trial-ops: alta, no show, asistencia o nada', () => {
  assert.equal(resultadoTrialOps({ outcome: 'converted', lifecycle: 'converted' }), 'alta');
  assert.equal(resultadoTrialOps({ outcome: 'no_show', lifecycle: 'no_show' }), 'no_vino');
  assert.equal(resultadoTrialOps({ outcome: 'attended', lifecycle: 'attended' }), 'asistio');
  assert.equal(resultadoTrialOps({ outcome: 'confirmed', lifecycle: 'awaiting_outcome' }), null);
});

async function trasPrueba(resultado, { socio = false } = {}) {
  const ctx = montar({
    aimharder: {
      reservarPrueba: async () => ({ estado: 'reservada', schedule_id: 1, booking_id: '77' }),
      resultadoPrueba: async () => resultado,
      buscarSocioPorTelefono: async () => ({ esSocio: false }),
    },
    respuestas: [
      [{ name: 'reservar_prueba_parla', input: { modalidad: 'crossfit', fecha_hora: '2026-11-19 19:30', nombre_completo: 'Ana López', email: 'ana@example.com' } }],
      responder({ mensajes: ['listo'] }),
      responder({ mensajes: ['qué tal fue?'] }),
    ],
  });
  await ctx.setter.responder('c1');
  ctx.db.prepare("UPDATE scheduled SET estado = 'omitido' WHERE regla_id != 'tras-prueba'").run();
  if (socio) ctx.setter.aimharder.buscarSocioPorTelefono = async () => ({ esSocio: true });
  ctx.avanzar(3 * 864e5 - 2 * 3600e3); // viernes 10:00 en Madrid (la clase fue el jueves a las 19:30)
  ctx.repo.updateConv('c1', { last_inbound_at: new Date(T0.getTime() + 2 * 864e5 + 3600e3).toISOString() });
  await procesarSeguimientos(ctx.setter);
  return ctx;
}

test('después de la prueba: si no vino, se le propone otro día (sin preguntar qué tal) y se etiqueta', async () => {
  const { sal, db } = await trasPrueba('no_vino');
  const tarea = sal.requests.at(-1).system.map((b) => b.text).join('\n');
  assert.match(tarea, /Resultado de la prueba \(comprobado ahora\): no vino a la clase/);
  assert.match(tarea, /No le preguntes qué tal la clase/);
  assert.deepEqual(sal.enviados.slice(-1), ['qué tal fue?']);
  assert.ok(sal.tags.includes('prueba no show'));
  assert.equal(ultimaPrueba(db, 'c1').resultado, 'no_vino');
});

test('después de la prueba: si vino y no tiene alta, qué tal y ofrecer el alta', async () => {
  const { sal } = await trasPrueba('sin_ausencia');
  assert.match(sal.requests.at(-1).system.map((b) => b.text).join('\n'), /si quiere que le dejes el alta preparada/);
});

test('después de la prueba: si ya se ha dado de alta, no sale', async () => {
  const { sal, db } = await trasPrueba('sin_ausencia', { socio: true });
  assert.deepEqual(sal.enviados, ['listo']);
  assert.deepEqual(db.prepare("SELECT estado, detalle FROM scheduled WHERE regla_id = 'tras-prueba'").get(), { estado: 'omitido', detalle: 'ya es socio' });
});

// ---------- Preguntas sin respuesta ----------

test('pregunta sin respuesta: se apunta una vez, avisa al equipo y, respondida, Sofía la sabe y se la cuenta al lead', async () => {
  const { db, setter, sal } = montar({ respuestas: [
    [{ name: 'pregunta_sin_respuesta', input: { pregunta: '¿Hay parking en Parla?' } }],
    responder({ mensajes: ['eso lo consulto con el equipo y te digo'] }),
    [{ name: 'pregunta_sin_respuesta', input: { pregunta: 'hay parking en parla' } }],
    responder({ mensajes: ['lo estoy mirando'] }),
    responder({ mensajes: ['ya me han dicho: hay zona azul gratis por la tarde en la calle'] }),
  ] });
  await setter.responder('c1');
  await setter.responder('c1');
  const lista = preguntas.listar(db);
  assert.equal(lista.length, 1);
  assert.equal(lista[0].veces, 2);
  assert.equal(sal.avisos.filter((a) => /no sabe responder/.test(a)).length, 1);
  assert.equal(setter.repo.getConv('c1').ai_paused, 0);
  const p = preguntas.responder(db, lista[0].id, { respuesta: 'Zona azul, gratis por la tarde', usar: true });
  assert.equal(await setter.contestarPregunta(p), 'enviada al lead');
  const req = sal.requests.at(-1);
  assert.match(req.system.map((b) => b.text).join('\n'), /Respuestas del equipo a preguntas de leads\n.*\n- \*\*¿Hay parking en Parla\?\*\* → Zona azul, gratis por la tarde/);
  assert.match(req.system.at(-1).text, /el equipo ha respondido una pregunta pendiente/);
  assert.deepEqual(sal.enviados.slice(-1), ['ya me han dicho: hay zona azul gratis por la tarde en la calle']);
  preguntas.responder(db, p.id, { respuesta: 'Zona azul, gratis por la tarde', usar: false });
  assert.equal(preguntas.bloqueConocimiento(db), '');
});

test('contestar una pregunta: no se escribe fuera de las 24 h ni en un chat pausado', async () => {
  const { db, setter, repo, avanzar } = montar();
  const { id } = preguntas.apuntar(db, { conversation_id: 'c1', pregunta: '¿Hay duchas?' });
  const p = preguntas.responder(db, id, { respuesta: 'Sí' });
  avanzar(25 * 3600e3);
  assert.match(await setter.contestarPregunta(p), /más de 24 h/);
  repo.updateConv('c1', { ai_paused: 1 });
  assert.match(await setter.contestarPregunta(p), /pausado/);
});

test('mientras Sofía cuenta la respuesta del equipo, el bucle no abre otro turno en ese chat', async () => {
  const { db, setter, repo, sal } = montar();
  let llamadas = 0; let soltar; const puerta = new Promise((r) => { soltar = r; });
  setter.complete = async () => { llamadas++; await puerta; return { content: [{ type: 'tool_use', id: 'r', name: 'responder', input: { fase: 'f2 diagnóstico', mensajes: ['sí, hay duchas'] } }] }; };
  const { id } = preguntas.apuntar(db, { conversation_id: 'c1', pregunta: '¿Hay duchas?' });
  const p = preguntas.responder(db, id, { respuesta: 'Sí' });
  repo.updateConv('c1', { respond_at: T0.toISOString() }); // además le tocaba una respuesta normal
  const envio = setter.contestarPregunta(p);
  await setter.tick();
  assert.equal(llamadas, 1, 'un solo turno a la vez');
  soltar();
  assert.equal(await envio, 'enviada al lead');
  assert.deepEqual(sal.enviados, ['sí, hay duchas']);
  assert.equal(setter.enCurso.has('c1'), false);
});

test('la prueba antigua del calendario se fecha en la zona del negocio', (t) => {
  const antes = config.tz; t.after(() => { config.tz = antes; });
  const prueba = { center: 'Parla', class_type: 'CrossFit', start_time: '2026-10-19T23:30:00Z', outcome: 'attended' };
  assert.match(describirTrialOps(prueba, T0), /del 20 de octubre de 2026/); // 01:30 en Madrid
  config.tz = 'America/New_York';
  assert.match(describirTrialOps(prueba, T0), /del 19 de octubre de 2026/);
});

// ---------- Valoración y resumen en la ficha ----------

test('valoración y resumen: una nota en la ficha de GHL que se actualiza, y sin llamada si no cambia', async () => {
  const { repo, setter, sal } = montar({ respuestas: [
    responder({ mensajes: ['hola!'], valoracion: { nota: 4, motivo: 'solo pregunta precios' }, resumen: 'Pregunta por CrossFit en Parla.' }),
    responder({ mensajes: ['genial'], valoracion: { nota: 8, motivo: 'quiere la prueba' }, resumen: 'Quiere probar CrossFit en Parla el jueves.' }),
    responder({ mensajes: ['vale'], valoracion: { nota: 8, motivo: 'quiere la prueba' }, resumen: 'Quiere probar CrossFit en Parla el jueves.' }),
  ] });
  await setter.responder('c1');
  assert.equal(sal.notas.length, 1);
  assert.equal(sal.notas[0][0], 'nueva');
  assert.match(sal.notas[0][1], /^⭐ Valoración de Sofía: 4\/10 · solo pregunta precios\n\n📝 Resumen de la conversación: Pregunta por CrossFit en Parla\./);
  await setter.responder('c1');
  assert.deepEqual([sal.notas[1][0], sal.notas[1][2]], ['actualiza', 'n1']);
  assert.match(sal.notas[1][1], /8\/10/);
  await setter.responder('c1');
  assert.equal(sal.notas.length, 2);
  const c = repo.getConv('c1');
  assert.deepEqual([c.valoracion, c.nota_ghl_id], [8, 'n1']);
});

test('si la nota se borró en GHL, se crea otra', async () => {
  const { setter, sal, repo } = montar({ respuestas: [responder({ mensajes: ['hola'], valoracion: { nota: 6 }, resumen: 'x' })] });
  repo.updateConv('c1', { nota_ghl_id: 'vieja' });
  setter.ghl.updateNote = async () => { throw new Error('GHL PUT → 404: not found'); };
  await setter.responder('c1');
  assert.deepEqual([sal.notas.at(-1)[0], repo.getConv('c1').nota_ghl_id], ['nueva', 'n1']);
});

test('prueba del calendario de GHL: la que ya pasó no se cuenta como pendiente', () => {
  const ahora = new Date('2026-11-22T12:00:00Z');
  const vieja = describirTrialOps({ center: 'Las Rosas', class_type: 'Academy', start_time: '2026-08-24T18:00:00+02:00', lifecycle: 'awaiting_outcome', outcome: 'confirmed' }, ahora);
  assert.match(vieja, /antigua \(Las Rosas, Academy\) del 24 de agosto de 2026 \(no consta si vino\)\. Ya pasó/);
  assert.doesNotMatch(vieja, /^Tiene una clase/);
  assert.match(describirTrialOps({ center: 'Parla', class_type: 'CrossFit', start_time: '2026-10-01T19:00:00+02:00', lifecycle: 'no_show', outcome: 'no_show' }, ahora), /y no vino\. Ya pasó/);
  const futura = describirTrialOps({ center: 'Parla', class_type: 'Academy', start_time: '2026-11-25T19:30:00+01:00', lifecycle: 'confirmed', outcome: 'confirmed' }, ahora);
  assert.match(futura, /^Tiene una clase de prueba en el calendario \(Parla, Academy\) el miércoles, 25 de noviembre, 19:30\. No le reserves otra/);
  assert.match(describirTrialOps({ center: 'Parla', class_type: 'Academy', start_time: '2026-11-25T19:30:00+01:00', lifecycle: 'cancelled', appointment_status: 'cancelled' }, ahora), /pero está anulada/);
});
