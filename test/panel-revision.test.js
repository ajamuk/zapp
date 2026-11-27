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
  // Un único script en línea: es el que lleva la huella de la política de contenido
  assert.equal([...html.matchAll(/<script>/g)].length, 1);
});

// Revisión del panel (2): micrófono, archivos, descargas y refrescos
const scriptPanel = () => /<script>([\s\S]*?)<\/script>/.exec(readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8'))[1];
const trozo = (js, re) => { const m = re.exec(js); assert.ok(m, `no se encuentra ${re}`); return m[0]; };

test('Panel: el chat se repinta cuando llega después el audio, la imagen o la transcripción de un mensaje', () => {
  const firmaHilo = new Function(`${trozo(scriptPanel(), /const firmaHilo = [\s\S]*?\]\)\]\);\n/)} return firmaHilo;`)();
  const d = (m) => ({ mensajes: [{ id: 1, autor: 'lead', texto: 'hola', enviado: 1 }, { id: 2, autor: 'lead', texto: '', enviado: 1, ...m }], conv: {}, etiquetas: [], seguimientos: [] });
  const antes = firmaHilo(d({}));
  assert.equal(firmaHilo(d({})), antes);
  for (const cambio of [{ adjunto: 'audio' }, { transcripcion: 'quiero probar' }, { media_error: 'no se pudo descargar' }, { texto: '[audio]' }])
    assert.notEqual(firmaHilo(d(cambio)), antes, JSON.stringify(cambio));
});

test('Panel: las subidas no se comparan por su contenido (cada una es una petición) y lo demás sí', () => {
  const pedidas = [];
  const api = new Function('precargadas', 'enCamino', 'pedir', `${trozo(scriptPanel(), /let subidas = 0;\nfunction api\([\s\S]*?\n}\n/)} return api;`)(
    new Map(), new Map(), (ruta, o) => { pedidas.push([ruta, o.body.length]); return new Promise(() => {}); });
  const grande = JSON.stringify({ datos: 'x'.repeat(100000) });
  api('/panel/conversaciones/c1/adjunto', { method: 'POST', body: grande });
  api('/panel/conversaciones/c1/adjunto', { method: 'POST', body: grande });
  api('/panel/conversaciones/c1/pausar', { method: 'POST', body: '{}' });
  api('/panel/conversaciones/c1/pausar', { method: 'POST', body: '{}' }); // doble clic: se une a la primera
  assert.deepEqual(pedidas.map(([r]) => r), ['/panel/conversaciones/c1/adjunto', '/panel/conversaciones/c1/adjunto', '/panel/conversaciones/c1/pausar']);
});

test('Panel: cada archivo se descarga una vez y su URL se libera cuando ya no está en la página', async () => {
  let enPagina = []; const revocadas = []; let creadas = 0; let pedidas = 0;
  const { urlMedio, liberarMedios } = new Function('peticion', 'document', 'URL',
    `${trozo(scriptPanel(), /const urlsMedios = new Map\(\);[\s\S]*?\n(?=function cargarMedios)/)} return { urlMedio, liberarMedios };`)(
    async () => { pedidas++; return { ok: true, blob: async () => 'datos' }; },
    { querySelectorAll: () => enPagina.map((media) => ({ dataset: { media } })) },
    { createObjectURL: () => `blob:${++creadas}`, revokeObjectURL: (u) => revocadas.push(u) });
  const a = await urlMedio('/panel/conversaciones/c1/media/1');
  assert.equal(await urlMedio('/panel/conversaciones/c1/media/1'), a); // el refresco del chat la reutiliza
  assert.equal(pedidas, 1);
  enPagina = ['/panel/conversaciones/c1/media/1'];
  liberarMedios(); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(revocadas, []);
  enPagina = []; // se ha cambiado de chat
  liberarMedios(); await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(revocadas, [a]);
  await urlMedio('/panel/conversaciones/c1/media/1');
  assert.equal(pedidas, 2); // ya liberada, se vuelve a pedir
});

test('Panel: una nota de voz descartada apaga el micrófono y no se adjunta; al pararla, sí', async () => {
  class Grabadora {
    static isTypeSupported(t) { return t.startsWith('audio/webm'); }
    constructor(_flujo, o) { this.mimeType = o?.mimeType || ''; this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['voz']) }); this.onstop?.(); }
  }
  const grabarNota = new Function('navigator', 'MediaRecorder', `${trozo(scriptPanel(), /async function grabarNota\([\s\S]*?\n}\n/)} return grabarNota;`);
  const microfono = () => { const pista = { parada: false, stop() { this.parada = true; } }; return { pista, navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [pista] }) } } }; };
  for (const accion of ['descartar', 'parar']) {
    const m = microfono(); const adjuntadas = [];
    const g = await grabarNota(m.navigator, Grabadora)((blob, nombre) => adjuntadas.push(nombre));
    assert.equal(m.pista.parada, false);
    g[accion]();
    assert.equal(m.pista.parada, true, `${accion}: el micrófono sigue encendido`);
    assert.deepEqual(adjuntadas, accion === 'parar' ? ['nota-de-voz.webm'] : []);
  }
  // Sin MediaRecorder que valga, se apaga el micrófono y se avisa
  const m = microfono();
  class Rota { static isTypeSupported() { return false; } constructor() { throw new Error('no'); } }
  await assert.rejects(grabarNota(m.navigator, Rota)(() => {}), /no permite grabar audio/);
  assert.equal(m.pista.parada, true);
});

test('Panel: lo que se revisó en micrófono, descargas, alertas y refrescos sigue en su sitio', () => {
  const js = scriptPanel();
  for (const pieza of ['function peticion', 'function descartarGrabacion', 'function descartarGrabacionPrueba', 'function repetirVisible', 'function aplicarNombresSede',
    "closest?.('[data-media-desc]')", 'aplicarNombresSede(estado.info.nombresSede)', 'resueltasAbiertas', 'estado.refPasada', 'URL.revokeObjectURL'])
    assert.ok(js.includes(pieza), `falta ${pieza}`);
  // Las páginas que se refrescan solas (reportes y batería) esperan a que la pestaña esté a la vista
  assert.doesNotMatch(js, /setTimeout\(\(\) => \{ if \(location\.hash === .*?, [46]000\);/);
  // Las descargas y los archivos usan la misma petición que el resto (sesión caducada o clave mal → login)
  assert.equal(js.match(/fetch\(\(integrado/g).length, 1);
});

test('Simulador: los «$» de los textos no se toman como patrones al montar la página', () => {
  const src = readFileSync(new URL('../scripts/build-simulador.js', import.meta.url), 'utf8');
  assert.match(src, /\.replace\('\/\*__DATOS__\*\/null', \(\) => json\)/);
  const json = JSON.stringify({ prompt: "precio: 30 $& o $' o $$" });
  assert.equal('a /*__DATOS__*/null b'.replace('/*__DATOS__*/null', () => json), `a ${json} b`);
});
