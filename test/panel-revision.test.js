import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { openDb, repo as crearRepo } from '../src/db.js';
import { crearApp } from '../src/server.js';
import * as panel from '../src/panel.js';
import * as preguntas from '../src/preguntas.js';

config.adminToken = 'clave-test';

// Revisión del panel (noviembre de 2026): cifras reales, datos al día y velocidad.

const chat = (repo, id, creado, mensajes = []) => {
  repo.upsertConv({ id, contact_id: `k-${id}`, channel: 'whatsapp', nombre: id });
  repo.db.prepare('UPDATE conversations SET created_at = ?, updated_at = ? WHERE id = ?').run(creado, creado, id);
  for (const [autor, texto, cuando] of mensajes) repo.addMessage({ conversation_id: id, autor, texto, created_at: cuando });
};

test('desfase de Madrid: una hora en invierno y dos en verano', () => {
  assert.equal(panel.desfaseMadrid(new Date('2026-01-15T12:00:59Z')), 60);
  assert.equal(panel.desfaseMadrid(new Date('2026-07-15T12:00:59Z')), 120);
});

test('Resumen «Hoy» cuenta desde la medianoche de Madrid, no las últimas 24 horas', () => {
  const repo = crearRepo(openDb(':memory:'));
  const ahora = new Date('2026-11-22T09:00:59Z'); // las 10:00 en Madrid
  // Ayer a las 20:00 de Madrid (hace 14 h): dentro de las últimas 24 h, pero no es hoy
  chat(repo, 'ayer', '2026-11-21 19:00:00', [['lead', 'hola', '2026-11-21T19:00:00.000Z'], ['ia', 'hola!', '2026-11-21T19:01:00.000Z']]);
  // Hoy a las 00:30 de Madrid (ayer 23:30 UTC): es hoy aunque en UTC sea el día anterior
  chat(repo, 'madrugada', '2026-11-21 23:30:00', [['lead', 'precio?', '2026-11-21T23:30:00.000Z']]);
  // Hoy a las 09:30 de Madrid, con la fecha en el otro formato
  chat(repo, 'hoy', '2026-11-22T08:30:00.000Z', [['lead', 'buenas', '2026-11-22 08:30:00'], ['ia', 'buenas!', '2026-11-22T08:31:00.000Z']]);

  const hoy = panel.resumen(repo.db, 1, ahora);
  assert.equal(hoy.dias, 1);
  assert.equal(hoy.conversaciones.n, 2, 'el chat de ayer por la tarde no es de hoy');
  assert.equal(hoy.mensajes.lead, 2);
  assert.equal(hoy.mensajes.ia, 1);
  assert.equal(hoy.atendidas, 1);

  const dos = panel.resumen(repo.db, 2, ahora);
  assert.equal(dos.conversaciones.n, 3, 'con 2 días entra también ayer');
  // La serie va por día de Madrid: el mensaje de las 00:30 cuenta en el día 22, no en el 21
  assert.deepEqual(dos.serie.map((x) => [x.dia, x.lead]), [['2026-11-21', 1], ['2026-11-22', 2]]);
});

test('Resumen: medianoches y series correctas cuando cambia la hora de Madrid', () => {
  for (const { ahora, antes, principio, final, siguiente, dia, diaSiguiente } of [
    { ahora: '2026-03-30T09:00:59Z', antes: '2026-03-28T22:59:59Z', principio: '2026-03-28T23:00:00Z', final: '2026-03-29T21:59:59Z', siguiente: '2026-03-29T22:00:00Z', dia: '2026-03-29', diaSiguiente: '2026-03-30' },
    { ahora: '2026-10-26T09:00:59Z', antes: '2026-10-24T21:59:59Z', principio: '2026-10-24T22:00:00Z', final: '2026-10-25T22:59:59Z', siguiente: '2026-10-25T23:00:00Z', dia: '2026-10-25', diaSiguiente: '2026-10-26' },
  ]) {
    const repo = crearRepo(openDb(':memory:'));
    for (const [i, cuando] of [antes, principio, final, siguiente].entries()) chat(repo, `c${i}`, cuando, [['lead', 'hola', cuando]]);
    const r = panel.resumen(repo.db, 2, new Date(ahora));
    assert.equal(r.conversaciones.n, 3);
    assert.equal(r.mensajes.lead, 3);
    assert.deepEqual(r.serie.map((x) => [x.dia, x.lead]), [[dia, 2], [diaSiguiente, 1]]);
    repo.db.close();
  }
});

test('Resumen: un número de días raro no rompe la consulta', () => {
  const repo = crearRepo(openDb(':memory:'));
  for (const d of ['abc', -3, 0, 9999, '7; DROP TABLE messages']) assert.ok(panel.resumen(repo.db, d).dias >= 1);
  assert.equal(panel.resumen(repo.db, 9999).dias, 90);
});

test('Consumo: sumar en la base da lo mismo que sumar fila a fila, también con llamadas antiguas sin coste', () => {
  const repo = crearRepo(openDb(':memory:'));
  const ins = repo.db.prepare('INSERT INTO ai_runs (conversation_id, motivo, modelo, tokens_in, tokens_out, coste_usd, respaldo) VALUES (?, ?, ?, ?, ?, ?, ?)');
  ins.run('c1', 'respuesta', 'claude-sonnet-5-5', 1000, 100, 0.5, 0);
  ins.run('c1', 'respuesta', 'claude-sonnet-5-5', 1000, 100, 0.25, 1);
  ins.run('prueba-x', 'respuesta', 'claude-sonnet-5-5', 1000, 100, 0.1, 0);
  ins.run('c2', 'followup', 'claude-haiku-5-5', 50000, 0, null, 0); // antigua, sin coste guardado: 50.000 tokens de entrada de Haiku = 0,005 $
  ins.run('c3', 'respuesta', 'claude-sonnet-5-5', 0, 0, null, 0);     // sin uso: no cuenta
  const c = panel.consumo(repo.db, { eurPorUsd: 1 });
  const mes = c.meses[0];
  assert.equal(mes.llamadas, 4);
  assert.ok(Math.abs(mes.usd - 0.855) < 1e-9, `total ${mes.usd}`);
  assert.equal(c.respaldos, 1);
  const motivo = (n) => mes.motivos.find((m) => m.motivo === n);
  assert.ok(Math.abs(motivo('Respuestas a leads').usd - 0.75) < 1e-9);
  assert.equal(motivo('Respuestas a leads').llamadas, 2);
  assert.ok(Math.abs(motivo('Probar IA').usd - 0.1) < 1e-9);
  assert.ok(Math.abs(motivo('Seguimientos').usd - 0.005) < 1e-9);
  assert.equal(c.dias.length, 1);
  assert.ok(Math.abs(c.dias[0].usd - 0.855) < 1e-9);
});

test('Estado del panel: lleva lo que la cabecera refresca sola (chats, preguntas pendientes, cambio a euros)', async () => {
  const repo = crearRepo(openDb(':memory:'));
  chat(repo, 'c1', '2026-11-22 08:00:00');
  preguntas.apuntar(repo.db, { conversation_id: 'c1', pregunta: '¿Hay duchas?' });
  const srv = crearApp({ setter: {}, repo }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  try {
    const e = await (await fetch(`http://127.0.0.1:${srv.address().port}/admin/panel/estado`, { headers: { authorization: 'Bearer clave-test' } })).json();
    assert.equal(e.contadores.todos, 1);
    assert.equal(e.preguntas_pendientes, 1);
    assert.ok(e.eur_por_usd > 0);
  } finally { srv.close(); }
});

test('Lista de chats: «Ver más» pide más de 100 y el servidor los da (hasta 500)', () => {
  const repo = crearRepo(openDb(':memory:'));
  repo.db.transaction(() => { for (let i = 0; i < 230; i++) chat(repo, `c${i}`, '2026-11-22 08:00:00'); })();
  assert.equal(panel.conversaciones(repo.db, {}).length, 100);
  assert.equal(panel.conversaciones(repo.db, { limite: 200 }).length, 200);
  assert.equal(panel.conversaciones(repo.db, { limite: 300 }).length, 230);
  assert.equal(panel.conversaciones(repo.db, { limite: 'x' }).length, 100);
});

test('El script del panel no tiene errores de sintaxis y conserva lo que se revisó', () => {
  const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8');
  const js = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.doesNotThrow(() => new Function(js));
  for (const pieza of ['function pintarCabecera', 'function refrescarEstado', 'function cerrarHilo', 'function refrescarVistas', 'function precargar', 'enCamino', "'#chats/'", 'estPedido', 'id="lmas"'])
    assert.ok(js.includes(pieza), `falta ${pieza}`);
  // Sin manejadores en línea: la política de contenido de /panel solo deja ejecutar el script de la página
  assert.doesNotMatch(html.replace(js, ''), /\son(click|change|submit|input)=/);
});
