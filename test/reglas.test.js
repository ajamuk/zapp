import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import * as reglas from '../src/reglas.js';
import * as etq from '../src/etiquetas.js';
import { procesarSeguimientos, programarPorEtiqueta, cancelarPorEtiqueta, programarManual, cancelarCita, horaMadrid, destinatarios, cancelarLanzamiento, respetaPlantillaFija, textoPrevisto } from '../src/followups.js';
import { guardarAjustes, leerAjustes } from '../src/ajustes.js';

const T0 = new Date('2026-11-17T11:00:00Z'); // martes 12:00 en Madrid

function montar({ respuestas = [] } = {}) {
  const repo = crearRepo(openDb(':memory:'));
  const sal = { enviados: [], plantillas: [], requests: [] };
  let reloj = new Date(T0);
  const cola = [...respuestas];
  const ghl = {
    sendMessage: async ({ texto }) => { sal.enviados.push(texto); return { messageId: `m${sal.enviados.length}` }; },
    enviarPorPlantilla: async ({ texto }) => { sal.plantillas.push(texto); return {}; },
    addTags: async () => {}, removeTags: async () => {}, assign: async () => {}, addNote: async () => {}, getContact: async () => ({ contact: {} }),
  };
  const etiquetas = new etq.Etiquetador({ repo, ghl, now: () => reloj, alPoner: (c, e) => programarPorEtiqueta(repo, repo.db, c, e, reloj), alQuitar: (c, e) => cancelarPorEtiqueta(repo, repo.db, c, e) });
  const setter = new Setter({
    repo, ghl, etiquetas, live: true, sleep: async () => {}, now: () => reloj, random: () => 0,
    aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: false }) },
    complete: async (req) => { sal.requests.push(req); const r = cola.shift(); if (!r) throw new Error('sin respuesta'); return { content: r.map((b, i) => ({ type: 'tool_use', id: `t${i}`, ...b })) }; },
  });
  repo.upsertConv({ id: 'c1', contact_id: 'k1', channel: 'whatsapp', nombre: 'Ana' });
  repo.updateConv('c1', { tipo: 'captacion', last_inbound_at: T0.toISOString() });
  repo.addMessage({ conversation_id: 'c1', autor: 'lead', texto: 'hola', created_at: T0.toISOString() });
  return { repo, db: repo.db, setter, etiquetas, sal, avanzar: (ms) => { reloj = new Date(reloj.getTime() + ms); }, ahora: () => reloj };
}
const pend = (repo) => repo.db.prepare("SELECT regla_id, tipo, due_at, texto_previsto FROM scheduled WHERE estado = 'pendiente' ORDER BY due_at").all();
const responder = (input) => [{ name: 'responder', input: { fase: 'f2 diagnóstico', ...input } }];

test('las reglas se copian del archivo la primera vez, con el recordatorio de prueba', () => {
  const db = openDb(':memory:');
  const r = reglas.listar(db);
  assert.deepEqual(r.map((x) => x.id), ['comercial-5h', 'info-tras-reserva', 'ultimo-intento-24h', 'cierre-4-dias', 'largo-plazo', 'largo-plazo-2', 'recordatorio-prueba', 'tras-prueba']);
  assert.equal(reglas.obtener(db, 'tras-prueba').tipo, 'tras-cita');
  assert.equal(reglas.obtener(db, 'largo-plazo').dias, 21);
  assert.equal(reglas.obtener(db, 'cierre-4-dias').plantilla, true);
  assert.equal(reglas.obtener(db, 'comercial-5h').plantilla, false);
  // Los interruptores de Ajustes cambian la regla
  const repo = crearRepo(db);
  guardarAjustes(repo, { seguimientos: { 'comercial-5h': false } });
  assert.equal(reglas.obtener(db, 'comercial-5h').activo, false);
  assert.equal(leerAjustes(repo).seguimientos['comercial-5h'], false);
});

test('crear, editar y borrar reglas con validación', () => {
  const db = openDb(':memory:');
  assert.throws(() => reglas.crear(db, { nombre: 'x', tipo: 'etiqueta', canales: ['whatsapp'], minutos: 60, instrucciones: 'y' }), /etiqueta que lo dispara/);
  const e = etq.crear(db, { nombre: 'Interesado' });
  const r = reglas.crear(db, { nombre: 'Retomar interesados', tipo: 'etiqueta', etiquetaId: e.id, canales: ['whatsapp'], minutos: 2 * 1440, instrucciones: 'retoma' });
  assert.equal(r.id, 'retomar-interesados');
  assert.throws(() => reglas.crear(db, { nombre: 'z', tipo: 'silencio', canales: ['whatsapp'], minutos: 60, modo: 'fijo', textoFijo: '[a] [b] [c] [d]' }), /3 huecos/);
  const r2 = reglas.actualizar(db, r.id, { minutos: 60, excluir: { calladasHoras: 12 } });
  assert.equal(r2.minutos, 60);
  assert.equal(r2.excluir.calladasHoras, 12);
  assert.equal(r2.excluir.pausada, true);
  assert.throws(() => reglas.actualizar(db, 'largo-plazo', { tipo: 'silencio' }), /largo plazo/);
  assert.ok(reglas.borrar(db, r.id));
});

test('seguimiento por etiqueta: se programa al ponerla, sobrevive a que el lead escriba y se cancela al quitarla', async () => {
  const { repo, db, setter, etiquetas, sal, avanzar } = montar({ respuestas: [responder({ mensajes: ['hola Ana! sigues pensando en Hyrox?'] })] });
  const e = etq.crear(db, { nombre: 'Interesado en Hyrox' });
  reglas.crear(db, { nombre: 'Hyrox a 2 días', tipo: 'etiqueta', etiquetaId: e.id, canales: ['whatsapp'], minutos: 2 * 1440, instrucciones: 'retoma lo de hyrox', excluir: { pausada: false } });
  await etiquetas.poner('c1', e.id, 'ia');
  assert.deepEqual(pend(repo).map((x) => [x.regla_id, x.tipo]), [['hyrox-a-2-dias', 'etiqueta']]);
  // Una vez por chat y etiqueta
  await etiquetas.quitar('c1', e.id);
  assert.equal(pend(repo).length, 0);
  await etiquetas.poner('c1', e.id, 'manual');
  assert.equal(pend(repo).length, 1);
  // El lead escribe y una persona del equipo toma el chat: el de etiqueta sigue (no depende de la pausa)
  repo.cancelScheduled('c1', 'el lead escribió', { soloCortos: true });
  repo.cancelScheduled('c1', 'humano escribió');
  repo.updateConv('c1', { ai_paused: 1 });
  assert.equal(pend(repo).length, 1);
  avanzar(2 * 864e5 + 60000);
  repo.updateConv('c1', { last_inbound_at: new Date(T0.getTime() + 2 * 864e5).toISOString() }); // ventana abierta
  await procesarSeguimientos(setter);
  assert.deepEqual(sal.enviados, ['hola Ana! sigues pensando en Hyrox?']);
});

test('recordatorio de la clase de prueba: 3 h antes, con la clase en la tarea; se cancela si se anula', async () => {
  const { repo, setter, sal, avanzar } = montar({ respuestas: [
    [{ name: 'reservar_prueba_parla', input: { modalidad: 'hyrox', fecha_hora: '2026-11-19 19:00', nombre_completo: 'Ana López', email: 'ana@example.com' } }],
    responder({ mensajes: ['te la dejo apuntada'] }),
    responder({ mensajes: ['recuerda tu prueba de hoy a las 19:00 en Parla 💪'] }),
  ] });
  await setter.responder('c1');
  const p = pend(repo).find((x) => x.tipo === 'cita');
  assert.equal(p.due_at, '2026-11-19T15:00:00.000Z'); // 19:00 Madrid (UTC+1) − 3 h
  assert.equal(repo.getConv('c1').prueba_fecha, '2026-11-19T18:00:00.000Z');
  avanzar(2 * 864e5 + 4 * 3600e3);
  for (const x of ['comercial-5h', 'info-tras-reserva', 'ultimo-intento-24h', 'cierre-4-dias']) repo.db.prepare("UPDATE scheduled SET estado='omitido' WHERE regla_id = ?").run(x);
  repo.updateConv('c1', { last_inbound_at: new Date(T0.getTime() + 2 * 864e5).toISOString() });
  await procesarSeguimientos(setter);
  assert.deepEqual(sal.enviados.slice(-1), ['recuerda tu prueba de hoy a las 19:00 en Parla 💪']);
  assert.match(sal.requests.at(-1).system.at(-1).text, /Su clase de prueba: jueves, 19 de noviembre/);
  cancelarCita(repo, 'c1');
  assert.equal(repo.getConv('c1').prueba_fecha, null);
});

test('después de la clase de prueba: sale 3 h después de la clase, con la clase en la tarea; se cancela si se anula', async () => {
  const { repo, setter, sal } = montar({ respuestas: [
    [{ name: 'reservar_prueba_parla', input: { modalidad: 'academy', fecha_hora: '2026-11-19 10:00', nombre_completo: 'Ana López', email: 'ana@example.com' } }],
    responder({ mensajes: ['te la dejo apuntada'] }),
  ] });
  await setter.responder('c1');
  const tras = pend(repo).find((x) => x.regla_id === 'tras-prueba');
  assert.equal(tras.tipo, 'cita');
  assert.equal(tras.due_at, '2026-11-19T12:00:00.000Z'); // 10:00 Madrid (UTC+1) + 3 h
  assert.equal(pend(repo).find((x) => x.regla_id === 'recordatorio-prueba').due_at, '2026-11-19T06:00:00.000Z');
  const regla = reglas.obtener(repo.db, 'tras-prueba');
  const tarea = (await import('../src/followups.js')).contextoTarea(regla, { contexto: JSON.stringify({ prueba: 'jueves, 19 de noviembre, 10:00' }) });
  assert.match(tarea, /ya ha pasado/);
  assert.match(tarea, /Su clase de prueba: jueves/);
  cancelarCita(repo, 'c1');
  assert.ok(!pend(repo).some((x) => ['tras-prueba', 'recordatorio-prueba'].includes(x.regla_id)));
  assert.deepEqual(sal.enviados, ['te la dejo apuntada']);
});

test('bases que ya existían reciben la regla de después de la prueba una sola vez', () => {
  const db = openDb(':memory:');
  db.prepare("DELETE FROM reglas_seguimiento WHERE id = 'tras-prueba'").run();
  db.prepare("DELETE FROM ajustes WHERE clave = 'semilla_tras_prueba'").run();
  reglas.sembrarReglas(db);
  assert.equal(reglas.obtener(db, 'tras-prueba').minutos, 180);
  assert.equal(reglas.listar(db).length, 8);
  // Si el equipo la borra, no vuelve
  reglas.borrar(db, 'tras-prueba');
  reglas.sembrarReglas(db);
  assert.equal(reglas.obtener(db, 'tras-prueba'), null);
});

test('hora de Madrid con cambio de horario', () => {
  assert.equal(horaMadrid('2026-07-01 19:00').toISOString(), '2026-07-01T17:00:00.000Z');
  assert.equal(horaMadrid('2026-12-01 19:00').toISOString(), '2026-12-01T18:00:00.000Z');
  assert.equal(horaMadrid('mañana'), null);
});

test('mensaje programado a mano: sale tal cual a su hora (sin IA ni horario) y por plantilla si no hay ventana', async () => {
  const { repo, setter, sal, avanzar, ahora } = montar();
  assert.throws(() => programarManual(repo, 'c1', '', ahora()), /Escribe/);
  assert.throws(() => programarManual(repo, 'c1', 'x', new Date(T0.getTime() - 3600e3)), /pasado/);
  programarManual(repo, 'c1', 'te espero mañana a las 7!', new Date(T0.getTime() + 3600e3), ahora());
  programarManual(repo, 'c1', 'hola de nuevo, te escribo como quedamos', '2026-11-20T23:30:00Z', ahora()); // de madrugada en Madrid y fuera de ventana
  avanzar(3600e3 + 1000);
  await procesarSeguimientos(setter);
  assert.deepEqual(sal.enviados, ['te espero mañana a las 7!']);
  avanzar(4 * 864e5);
  await procesarSeguimientos(setter);
  assert.deepEqual(sal.plantillas, ['hola de nuevo, te escribo como quedamos']);
  assert.equal(sal.requests.length, 0); // nunca pasa por la IA
});

test('texto fijo con huecos: Sofía solo rellena los corchetes; si cambia el texto, no sale', async () => {
  assert.ok(respetaPlantillaFija('hola [nombre], te esperamos el [día]', 'hola Ana, te esperamos el jueves'));
  assert.ok(!respetaPlantillaFija('hola [nombre], te esperamos el [día]', 'hola Ana! te espero el jueves'));
  assert.ok(!respetaPlantillaFija('hola [nombre]', 'hola [nombre]'));
  const { repo, db, setter } = montar({ respuestas: [responder({ mensajes: ['hola Ana, te paso los horarios de Parla'] }), responder({ mensajes: ['buenas Ana! te paso horarios'] })] });
  reglas.crear(db, { nombre: 'Fijo', tipo: 'silencio', canales: ['whatsapp'], minutos: 60, modo: 'fijo', textoFijo: 'hola [nombre], te paso los horarios de [sede]' });
  const s = { id: null, conversation_id: 'c1', regla_id: 'fijo', tipo: 'silencio', due_at: new Date(T0.getTime() + 3600e3).toISOString() };
  assert.equal((await textoPrevisto(setter, s)).texto, 'hola Ana, te paso los horarios de Parla');
  assert.equal((await textoPrevisto(setter, s, { forzar: true })).texto, '');
  // Sin huecos ni condición: no se llama a la IA
  reglas.crear(db, { nombre: 'Fijo sin huecos', tipo: 'silencio', canales: ['whatsapp'], minutos: 60, modo: 'fijo', textoFijo: 'sigo por aquí 😊' });
  assert.equal((await textoPrevisto(setter, { ...s, regla_id: 'fijo-sin-huecos' })).texto, 'sigo por aquí 😊');
});

test('exclusiones y etiqueta al enviar', async () => {
  const { repo, db, setter, sal, avanzar } = montar({ respuestas: [responder({ mensajes: ['sigues interesada?'] })] });
  const e = etq.crear(db, { nombre: 'Seguimiento enviado' });
  reglas.crear(db, { nombre: 'Silencio 1h', tipo: 'silencio', canales: ['whatsapp'], minutos: 60, instrucciones: 'retoma', ponerEtiqueta: e.id, excluir: { calladasHoras: 2 } });
  for (const r of reglas.listar(db)) if (r.id !== 'silencio-1h') reglas.actualizar(db, r.id, { activo: false });
  repo.schedule('c1', 'silencio-1h', new Date(T0.getTime() + 3600e3).toISOString(), null, 'silencio');
  avanzar(3600e3 + 1000);
  await procesarSeguimientos(setter);
  assert.match(repo.db.prepare("SELECT detalle FROM scheduled WHERE regla_id = 'silencio-1h'").get().detalle, /menos de 2 h/);
  repo.schedule('c1', 'silencio-1h', new Date(T0.getTime() + 3 * 3600e3).toISOString(), null, 'silencio');
  avanzar(2 * 3600e3);
  await procesarSeguimientos(setter);
  assert.deepEqual(sal.enviados, ['sigues interesada?']);
  assert.equal(etq.deChats(db, ['c1']).c1[0].nombre, 'Seguimiento enviado');
  // Ya es cliente: no sale
  repo.updateConv('c1', { alta_estado: 'preparada' });
  repo.schedule('c1', 'silencio-1h', new Date(T0.getTime() + 4 * 3600e3).toISOString(), null, 'silencio');
  avanzar(3600e3);
  await procesarSeguimientos(setter);
  assert.match(repo.db.prepare("SELECT detalle FROM scheduled WHERE regla_id = 'silencio-1h' ORDER BY id DESC").get().detalle, /cliente/);
});

test('lanzamientos: destinatarios filtrados, envío repartido con texto fijo, y cancelar', async () => {
  const { repo, db, setter, sal, avanzar } = montar();
  const vip = etq.crear(db, { nombre: 'VIP' }); const baja = etq.crear(db, { nombre: 'Baja' });
  const hace = (d) => new Date(Date.now() - d * 864e5).toISOString();
  for (const [id, canal, dias, tipo] of [['a', 'whatsapp', 2], ['b', 'whatsapp', 40], ['c', 'instagram', 1], ['d', 'whatsapp', 1, 'socio'], ['e', 'whatsapp', 3]]) {
    repo.upsertConv({ id, contact_id: `k${id}`, channel: canal, nombre: id.toUpperCase() });
    repo.updateConv(id, { last_inbound_at: hace(dias), tipo: tipo || 'captacion' });
  }
  repo.updateConv('c1', { last_inbound_at: hace(5) });
  await new etq.Etiquetador({ repo }).poner('e', baja.id);
  const d = destinatarios(db, { dias_actividad: 30, canales: ['whatsapp'], excluir_etiquetas: [baja.id] });
  assert.deepEqual(d.map((x) => x.id).sort(), ['a', 'c1']);
  db.prepare(`INSERT INTO lanzamientos (nombre, texto, programado_at, dias_actividad, canales, excluir_etiquetas) VALUES ('Black Friday', 'este viernes 20% en tu primer mes 🎉', ?, 30, '["whatsapp"]', ?)`)
    .run(new Date(T0.getTime() + 60000).toISOString(), JSON.stringify([baja.id]));
  avanzar(61000);
  await procesarSeguimientos(setter);
  const l = db.prepare('SELECT * FROM lanzamientos').get();
  assert.equal(l.estado, 'enviando');
  assert.equal(l.total, 2);
  assert.equal(sal.enviados.length + sal.plantillas.length, 1); // el primero ya; el siguiente 20 s después
  avanzar(21000);
  await procesarSeguimientos(setter);
  assert.equal(sal.enviados.length + sal.plantillas.length, 2);
  assert.ok([...sal.enviados, ...sal.plantillas].every((t) => t === 'este viernes 20% en tu primer mes 🎉'));
  assert.equal(db.prepare('SELECT estado FROM lanzamientos').get().estado, 'enviado');
  assert.equal(sal.requests.length, 0);
  // Cancelar uno programado
  db.prepare(`INSERT INTO lanzamientos (nombre, texto, programado_at) VALUES ('x', 'y', ?)`).run(new Date(T0.getTime() + 864e5).toISOString());
  assert.ok(cancelarLanzamiento(db, 2));
  assert.equal(db.prepare('SELECT estado FROM lanzamientos WHERE id = 2').get().estado, 'cancelado');
  void vip;
});
