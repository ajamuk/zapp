import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { openDb, repo as crearRepo } from '../src/db.js';
import { crearApp } from '../src/server.js';
import * as etq from '../src/etiquetas.js';
import { simular } from '../src/probar.js';

config.adminToken = 'clave-test';

async function montar(respuestas) {
  const repo = crearRepo(openDb(':memory:'));
  const pruebas = crearRepo(openDb(':memory:'));
  const cola = [...respuestas];
  const peticiones = [];
  const complete = async (req) => {
    peticiones.push(req);
    const r = cola.shift();
    if (!r) throw new Error('sin respuesta');
    return { content: r.map((b, i) => ({ type: 'tool_use', id: `t${i}`, ...b })), usage: {} };
  };
  const srv = crearApp({ setter: {}, repo, pruebas, complete }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}/admin/probar`;
  const api = async (ruta, metodo = 'GET', body) => {
    const r = await fetch(base + ruta, { method: metodo, headers: { authorization: 'Bearer clave-test', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? JSON.parse(t) : t };
  };
  return { repo, pruebas, srv, api, peticiones };
}

const responder = (input) => [{ name: 'responder', input: { fase: 'f1 apertura', ...input } }];

test('Probar IA: varias pruebas guardadas, análisis, etiquetas reales en el sandbox y exportar', async () => {
  const { repo, pruebas, srv, api, peticiones } = await montar([
    [{ name: 'consultar_tarifas', input: { sede: 'parla' } }],
    responder({ mensajes: ['hola!', 'qué te interesa'], sede: 'parla', etiquetas: ['Interesado'], analisis: 'lead nuevo de parla', siguiente_paso: 'saber objetivo' }),
    responder({ mensajes: ['me alegro'], fase: 'f2 diagnóstico' }),
  ]);
  try {
    const interesado = etq.crear(repo.db, { nombre: 'Interesado', criterio_ia: 'Pregunta precios', acciones: { avisar: true } });
    const a = await api('/conversaciones', 'POST', { canal: 'whatsapp' });
    assert.equal(a.status, 201);
    assert.equal(a.body.conv.nombre, 'Prueba 1');
    const b = await api('/conversaciones', 'POST', { canal: 'instagram', nombre: 'Lead IG' });
    assert.equal((await api('/conversaciones')).body.length, 2);

    const id = a.body.conv.id;
    const r = await api(`/conversaciones/${id}/mensaje`, 'POST', { texto: 'cuánto cuesta en parla?' });
    assert.equal(r.status, 200);
    const d = r.body;
    assert.deepEqual(d.mensajes.filter((m) => m.autor === 'ia').map((m) => m.texto), ['hola!', 'qué te interesa']);
    assert.equal(d.conv.analisis, 'lead nuevo de parla');
    assert.equal(d.conv.siguiente_paso, 'saber objetivo');
    assert.equal(d.conv.sede, 'parla');
    assert.deepEqual(d.conv.ultimo_turno.herramientas.map((h) => h.nombre), ['consultar_tarifas']);
    assert.deepEqual(d.etiquetas.map((e) => e.nombre), ['Interesado']);
    assert.equal(d.etiquetas[0].origen, 'ia');
    assert.ok(d.mensajes.some((m) => m.autor === 'sistema' && /aviso equipo.*Interesado/.test(m.texto)));
    assert.ok(d.seguimientos.length > 0);
    assert.match(peticiones[0].system.at(-1).text, /Interesado/);
    // Nada en la base real
    assert.equal(repo.db.prepare('SELECT count(*) n FROM conversations').get().n, 0);
    assert.equal(repo.db.prepare('SELECT count(*) n FROM conv_etiquetas').get().n, 0);

    // Segundo mensaje: la etiqueta ya no se ofrece
    await api(`/conversaciones/${id}/mensaje`, 'POST', { texto: 'genial' });
    assert.doesNotMatch(peticiones.at(-1).system.at(-1).text, /Interesado/);

    // Quitar y poner etiqueta a mano
    let e = await api(`/conversaciones/${id}/etiquetas/${interesado.id}`, 'DELETE');
    assert.equal(e.body.etiquetas.length, 0);
    e = await api(`/conversaciones/${id}/etiquetas`, 'POST', { etiqueta: interesado.id });
    assert.equal(e.body.etiquetas[0].origen, 'manual');

    // Exportar
    const txt = await api(`/conversaciones/${id}/exportar`);
    assert.match(txt.body, /PRUEBA DE SOFÍA · WHATSAPP/);
    assert.match(txt.body, /Lead: cuánto cuesta en parla\?/);
    assert.match(txt.body, /Análisis: lead nuevo de parla/);
    assert.doesNotMatch((await api(`/conversaciones/${id}/exportar?analisis=0`)).body, /Análisis|Sistema:/);

    // Borrar una y todas
    await api(`/conversaciones/${b.body.conv.id}`, 'DELETE');
    assert.equal((await api('/conversaciones')).body.length, 1);
    await api('/conversaciones', 'DELETE');
    assert.equal((await api('/conversaciones')).body.length, 0);
    assert.equal(pruebas.db.prepare('SELECT count(*) n FROM messages').get().n, 0);
  } finally { srv.close(); }
});

test('Probar IA: IA inicia, forzar seguimiento, fecha simulada y teléfono de socio', async () => {
  const { repo, srv, api, peticiones } = await montar([
    responder({ mensajes: ['hola! vi que te interesó el box'] }),
    responder({ mensajes: [] }),
  ]);
  try {
    repo.reemplazarSocios('getafe', [{ telefono: '611111111', sede: 'getafe', aimharder_id: 1, nombre: 'Socio', activo: 1, tarifa: 'L' }]);
    const c = (await api('/conversaciones', 'POST', { canal: 'whatsapp', fecha: '2026-12-24T19:30:00+01:00' })).body.conv;
    const r = await api(`/conversaciones/${c.id}/iniciar`, 'POST');
    assert.deepEqual(r.body.mensajes.filter((m) => m.autor === 'ia').map((m) => m.texto), ['hola! vi que te interesó el box']);
    assert.match(peticiones[0].system.at(-1).text, /2026-12-24/); // la IA cree que es Nochebuena
    assert.match(peticiones[0].system.at(-1).text, /outbound/);

    const s = await api(`/conversaciones/${c.id}/seguimiento`, 'POST', { regla: r.body.seguimientos[0].id });
    assert.ok(s.body.mensajes.some((m) => m.autor === 'sistema' && /decide no enviarlo/.test(m.texto)));
    assert.equal((await api(`/conversaciones/${c.id}/seguimiento`, 'POST', { regla: 'nada' })).status, 400);

    // Teléfono de un socio real: Sofía no contesta
    const p = await api(`/conversaciones/${c.id}`, 'PATCH', { telefono: '+34 611 111 111' });
    assert.equal(p.body.conv.simulacion.telefono, '+34 611 111 111');
    const m = await api(`/conversaciones/${c.id}/mensaje`, 'POST', { texto: 'hola, una duda de mi cuota' });
    assert.ok(m.body.mensajes.some((x) => x.autor === 'sistema' && /socio/.test(x.texto)));
    assert.equal(peticiones.length, 2); // no se llamó al modelo
  } finally { srv.close(); }
});

test('simulación de fecha: desfase respecto a la hora real', () => {
  const s = simular({ fecha: new Date(Date.now() + 3600e3).toISOString(), telefono: ' 600 ' });
  assert.equal(s.telefono, '600');
  assert.ok(Math.abs(s.offset_ms - 3600e3) < 1000);
  assert.deepEqual(simular({ fecha: 'no es fecha' }), {});
});

test('Probar IA: borrar una prueba no borra el archivo de un recurso que Sofía envió en ella', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const recursos = await import('../src/recursos.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'medios-'));
  const repo = crearRepo(openDb(':memory:'));
  const pruebas = crearRepo(openDb(':memory:'));
  const srv = crearApp({ setter: {}, repo, pruebas, complete: async () => { throw new Error('sin modelo'); }, medios: { base } }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}/admin/probar`;
  const api = async (ruta, method = 'GET', body) => (await fetch(url + ruta, { method, headers: { authorization: 'Bearer clave-test', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
  try {
    const rec = recursos.crear(repo.db, { nombre: 'academy-video', descripcion: 'vídeo de una clase', mime: 'video/mp4', archivo: 'clase.mp4', datos: Buffer.from('mp4').toString('base64') }, { base });
    const propio = path.join(path.dirname(rec.media_ruta), 'audio-de-la-prueba.ogg');
    fs.writeFileSync(path.join(base, propio), 'ogg');
    const { conv } = await api('/conversaciones', 'POST', { canal: 'whatsapp' });
    pruebas.addMessage({ conversation_id: conv.id, autor: 'ia', texto: '[video: academy-video]', adjunto: 'video', media_ruta: rec.media_ruta, media_mime: 'video/mp4' });
    pruebas.addMessage({ conversation_id: conv.id, autor: 'lead', texto: '', adjunto: 'audio', media_ruta: propio, media_mime: 'audio/ogg' });
    await api(`/conversaciones/${conv.id}`, 'DELETE');
    assert.ok(fs.existsSync(path.join(base, rec.media_ruta)), 'el archivo del recurso sigue en disco');
    assert.ok(!fs.existsSync(path.join(base, propio)), 'el audio propio de la prueba sí se borra');
  } finally {
    srv.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
