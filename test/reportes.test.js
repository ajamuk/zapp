import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import * as docs from '../src/documentos.js';
import * as reportes from '../src/reportes.js';
import { config } from '../src/config.js';
import { crearApp } from '../src/server.js';

const nuevoReporte = (db, extra = {}) => reportes.crear(db, {
  origen: 'prueba', respuesta_ia: 'te cuento los precios ahora mismo',
  contexto: [{ autor: 'lead', texto: 'cuánto cuesta en parla?' }, { autor: 'ia', texto: 'te cuento los precios ahora mismo' }],
  meta: { channel: 'whatsapp', sede: 'parla' }, que_fallo: 'promete los precios y no los da', que_esperaba: 'que pregunte si es principiante explicando que es para el precio', ...extra,
});

// Modelo de Sofía simulado (para repetir la conversación): responde según el prompt que recibe
const sofia = (req) => {
  const sys = req.system.map((b) => b.text).join('\n');
  const t = /NUNCA PROMETAS/.test(sys) ? 'para pasarte el precio exacto, has hecho CrossFit alguna vez?' : 'te cuento los precios ahora mismo';
  return { content: [{ type: 'tool_use', id: 't', name: 'responder', input: { mensajes: [t], fase: 'f2 diagnóstico' } }] };
};
const optimizador = (respuestas) => { const cola = [...respuestas]; const llamadas = []; const f = async (req) => { llamadas.push(req); return { content: [{ type: 'text', text: JSON.stringify(cola.shift()) }] }; }; f.llamadas = llamadas; return f; };

test('documentos: se copian del repo, versiones, borradores y volver atrás', () => {
  const db = openDb(':memory:');
  const p1 = docs.enProduccion(db, 'prompt');
  assert.equal(p1.version, 1);
  assert.match(p1.texto, /Sofía/);
  assert.ok(docs.enProduccion(db, 'negocio'));
  const b = docs.crearVersion(db, 'prompt', p1.texto + '\nregla nueva', { nota: 'prueba' });
  assert.equal(b.estado, 'borrador');
  assert.equal(docs.textosActivos(db).prompt, p1.texto);
  assert.match(docs.textosActivos(db, { prompt: b.id }).prompt, /regla nueva/);
  docs.activar(db, b.id);
  assert.equal(docs.enProduccion(db, 'prompt').version, 2);
  docs.activar(db, p1.id); // volver atrás
  assert.equal(docs.enProduccion(db, 'prompt').version, 1);
  assert.throws(() => docs.crearVersion(db, 'prompt', 'corto'), /corto/);
  assert.equal(docs.aplicarCambios('a b c', [{ buscar: 'b', reemplazar: 'B' }]), 'a B c');
  assert.throws(() => docs.aplicarCambios('a b b', [{ buscar: 'b', reemplazar: 'B' }]), /2 veces/);
  assert.throws(() => docs.aplicarCambios('a', [{ buscar: 'x', reemplazar: 'y' }]), /no aparece/);
  assert.match(docs.aplicarCambios('a', [{ buscar: '', reemplazar: 'nueva' }]), /a\n\nnueva/);
});

test('reporte → cambio comprobado → aplicar crea versión en producción', async () => {
  const db = openDb(':memory:');
  const linea = docs.enProduccion(db, 'prompt').texto.split('\n').find((l) => l.startsWith('- **Precio:**'));
  const id = nuevoReporte(db);
  const opt = optimizador([
    { clasificacion: 'cambiar', explicacion: 'La regla no prohibía prometer.', pregunta: '', documento: 'prompt', cambios: [{ buscar: linea, reemplazar: `${linea} NUNCA PROMETAS lo que no das en el mismo mensaje.` }], resumen: 'No prometer precios sin darlos' },
    { arreglado: true, motivo: 'Ahora pregunta sin prometer.', problemas_nuevos: '' },
  ]);
  const r = await reportes.analizar(db, id, { complete: sofia, completeJSON: opt });
  assert.equal(r.estado, 'propuesto');
  assert.equal(r.comprobacion.antes, 'te cuento los precios ahora mismo');
  assert.equal(r.comprobacion.despues, 'para pasarte el precio exacto, has hecho CrossFit alguna vez?');
  assert.match(opt.llamadas[0].messages[0].content, /<respuesta_reportada>\nte cuento los precios/);
  assert.equal(opt.llamadas[0].output_config.format.type, 'json_schema');
  // Nada cambia hasta aplicar
  assert.equal(docs.enProduccion(db, 'prompt').version, 1);
  const v = reportes.aplicar(db, id);
  assert.equal(v.version, 2);
  assert.match(docs.enProduccion(db, 'prompt').texto, /NUNCA PROMETAS/);
  assert.match(v.nota, /Reporte #1/);
  assert.equal(reportes.obtener(db, id).estado, 'aplicado');
  assert.throws(() => reportes.aplicar(db, id), /no se puede aplicar/);
});

test('si el primer cambio no funciona, prueba otro con lo aprendido; si tampoco, queda como fallido', async () => {
  const db = openDb(':memory:');
  const linea = docs.enProduccion(db, 'prompt').texto.split('\n').find((l) => l.startsWith('- **Precio:**'));
  const id = nuevoReporte(db);
  const cambio = (t) => ({ clasificacion: 'cambiar', explicacion: 'x', pregunta: '', documento: 'prompt', cambios: [{ buscar: linea, reemplazar: `${linea} ${t}` }], resumen: 'r' });
  const opt = optimizador([cambio('sé claro'), { arreglado: false, motivo: 'sigue prometiendo', problemas_nuevos: '' }, cambio('sé muy claro'), { arreglado: false, motivo: 'igual', problemas_nuevos: '' }]);
  const r = await reportes.analizar(db, id, { complete: sofia, completeJSON: opt });
  assert.equal(r.estado, 'fallido');
  assert.equal(r.comprobacion.intentos, 2);
  assert.match(opt.llamadas[2].messages[0].content, /<intento_anterior>[\s\S]*sigue prometiendo/);
  assert.throws(() => reportes.aplicar(db, id), /no se puede aplicar/);
  assert.equal(reportes.aplicar(db, id, { aunqueFallido: true }).version, 2); // se puede forzar
});

test('duda: pregunta, el equipo responde y se vuelve a analizar con el dato; ya cubierto y no es del prompt', async () => {
  const db = openDb(':memory:');
  const id = nuevoReporte(db, { que_fallo: 'no dijo el precio del bono' });
  let r = await reportes.analizar(db, id, { complete: sofia, completeJSON: optimizador([{ clasificacion: 'duda', explicacion: 'No consta el precio del bono.', pregunta: '¿Cuánto cuesta el bono de 10 clases en Parla?', documento: 'negocio', cambios: [], resumen: '' }]) });
  assert.equal(r.estado, 'duda');
  assert.match(r.pregunta, /bono/);
  reportes.responder(db, id, '120 €');
  const opt = optimizador([{ clasificacion: 'ya_cubierto', explicacion: 'Ya está en la base de conocimiento.', pregunta: '', documento: 'negocio', cambios: [], resumen: '' }]);
  r = await reportes.analizar(db, id, { complete: sofia, completeJSON: opt });
  assert.match(opt.llamadas[0].messages[0].content, /el equipo respondió: «120 €»/);
  assert.equal(r.estado, 'sin_cambio');
  const id2 = nuevoReporte(db, { que_fallo: 'no le llegó el follow-up' });
  r = await reportes.analizar(db, id2, { complete: sofia, completeJSON: optimizador([{ clasificacion: 'no_prompt', explicacion: 'Es de los seguimientos.', pregunta: '', documento: 'prompt', cambios: [], resumen: '' }]) });
  assert.equal(r.estado, 'no_prompt');
});

test('un cambio que no encaja se corrige una vez; si las instrucciones cambian antes de aplicar, avisa', async () => {
  const db = openDb(':memory:');
  const linea = docs.enProduccion(db, 'prompt').texto.split('\n').find((l) => l.startsWith('- **Precio:**'));
  const id = nuevoReporte(db);
  const opt = optimizador([
    { clasificacion: 'cambiar', explicacion: 'x', pregunta: '', documento: 'prompt', cambios: [{ buscar: 'texto que no existe', reemplazar: 'y' }], resumen: 'r' },
    { clasificacion: 'cambiar', explicacion: 'x', pregunta: '', documento: 'prompt', cambios: [{ buscar: linea, reemplazar: `${linea} NUNCA PROMETAS` }], resumen: 'r' },
    { arreglado: true, motivo: 'ok', problemas_nuevos: '' },
  ]);
  const r = await reportes.analizar(db, id, { complete: sofia, completeJSON: opt });
  assert.equal(r.estado, 'propuesto');
  assert.match(opt.llamadas[1].messages[0].content, /error_de_tu_propuesta/);
  // Alguien edita el prompt quitando esa línea
  docs.crearVersion(db, 'prompt', docs.enProduccion(db, 'prompt').texto.replace(linea, '- precio: distinto'), { produccion: true });
  assert.throws(() => reportes.aplicar(db, id), /han cambiado/);
});

test('API: reportar desde Probar IA, ver el reporte y usar un borrador en la prueba', async () => {
  config.adminToken = 'clave-test';
  const repo = crearRepo(openDb(':memory:'));
  const pruebas = crearRepo(openDb(':memory:'));
  const linea = docs.enProduccion(repo.db, 'prompt').texto.split('\n').find((l) => l.startsWith('- **Precio:**'));
  const completeJSON = optimizador([
    { clasificacion: 'cambiar', explicacion: 'x', pregunta: '', documento: 'prompt', cambios: [{ buscar: linea, reemplazar: `${linea} NUNCA PROMETAS` }], resumen: 'No prometer' },
    { arreglado: true, motivo: 'ok', problemas_nuevos: '' },
  ]);
  const srv = crearApp({ setter: {}, repo, pruebas, complete: async (req) => sofia(req), completeJSON }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}/admin`;
  const h = { authorization: 'Bearer clave-test', 'content-type': 'application/json' };
  const post = async (r, b) => (await fetch(base + r, { method: 'POST', headers: h, body: JSON.stringify(b || {}) })).json();
  const get = async (r) => (await fetch(base + r, { headers: h })).json();
  try {
    const c = (await post('/probar/conversaciones', { canal: 'whatsapp' })).conv;
    const d = await post(`/probar/conversaciones/${c.id}/mensaje`, { texto: 'cuánto cuesta en parla?' });
    const ia = d.mensajes.find((m) => m.autor === 'ia');
    const { id } = await post(`/probar/conversaciones/${c.id}/reportar`, { message_id: ia.id, que_fallo: 'promete y no da el precio' });
    let r; for (let i = 0; i < 50; i++) { r = await get(`/panel/reportes/${id}`); if (r.estado === 'propuesto') break; await new Promise((x) => setTimeout(x, 20)); }
    assert.equal(r.estado, 'propuesto');
    assert.equal(r.contexto.mensajes.length, 2);
    assert.equal((await get('/panel/reportes')).contadores.propuesto, 1);
    // Borrador manual y probarlo en la prueba
    const borr = await post('/panel/instrucciones', { doc: 'prompt', texto: docs.enProduccion(repo.db, 'prompt').texto.replace(linea, `${linea} NUNCA PROMETAS`), nota: 'borrador' });
    assert.equal(borr.estado, 'borrador');
    const p = await (await fetch(`${base}/probar/conversaciones/${c.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ borradores: { prompt: borr.id } }) })).json();
    assert.equal(p.instrucciones.prompt.version, 2);
    const d2 = await post(`/probar/conversaciones/${c.id}/mensaje`, { texto: 'y en getafe?' });
    assert.ok(d2.mensajes.some((m) => m.autor === 'ia' && /precio exacto/.test(m.texto)));
    // Aplicar el reporte
    const v = await post(`/panel/reportes/${id}/aplicar`);
    assert.equal(v.version, 3);
    const lista = await get('/panel/instrucciones');
    assert.deepEqual(lista.prompt.versiones.map((x) => [x.version, x.estado]), [[3, 'produccion'], [2, 'borrador'], [1, 'archivada']]);
  } finally { srv.close(); }
});
