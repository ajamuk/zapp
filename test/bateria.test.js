import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import * as bat from '../src/bateria.js';
import * as docs from '../src/documentos.js';
import * as reportes from '../src/reportes.js';

const sofia = (texto) => async (req) => {
  const t = typeof texto === 'function' ? texto(req) : texto;
  return { content: [{ type: 'tool_use', id: 't', name: 'responder', input: { mensajes: Array.isArray(t) ? t : [t], fase: 'f2 diagnóstico' } }], usage: { input_tokens: 1000, output_tokens: 100 } };
};
const juez = (cumple) => async (req) => {
  const n = (req.messages[0].content.match(/^\d+\. /gm) || []).length;
  const c = typeof cumple === 'function' ? cumple(req.messages[0].content) : cumple;
  return { content: [{ type: 'text', text: JSON.stringify({ criterios: Array.from({ length: n }, (_, i) => ({ n: i + 1, cumple: Array.isArray(c) ? c[i] : c, motivo: 'm' })) }) }], usage: { input_tokens: 500, output_tokens: 50 } };
};
const lead = (frases) => { const cola = [...frases]; return async () => ({ content: [{ type: 'text', text: cola.shift() ?? '[FIN]' }], usage: {} }); };

test('casos: se cargan los reales de Zapp (anonimizados) y los escenarios, con reparto estable en reserva', () => {
  const db = openDb(':memory:');
  assert.equal(bat.sembrarCasos(db), 61);
  assert.equal(bat.sembrarCasos(db), 0); // no duplica
  const c = bat.listarCasos(db);
  assert.equal(c.filter((x) => x.origen === 'zapp').length, 32);
  assert.equal(c.filter((x) => x.tipo === 'escenario').length, 29);
  const reserva = c.filter((x) => x.grupo === 'reserva').length;
  assert.ok(reserva >= 8 && reserva <= 22, `reserva: ${reserva}`);
  assert.ok(!c.some((x) => /\d{9}|@\w+\.\w+/.test(JSON.stringify(x.contexto)) && x.origen === 'zapp'));
  assert.equal(bat.grupoDe('x1'), bat.grupoDe('x1'));
  assert.throws(() => bat.guardarCaso(db, { nombre: 'x', tipo: 'escenario', criterios: ['a'] }), /primer mensaje/);
  assert.throws(() => bat.guardarCaso(db, { nombre: 'x', tipo: 'momento', contexto: [['lead', 'hola']], criterios: '' }), /criterio/);
  const n = bat.guardarCaso(db, { nombre: 'Nuevo', tipo: 'momento', contexto: [['lead', 'hola']], criterios: 'Saluda\nPregunta la sede' });
  assert.deepEqual(n.criterios, ['Saluda', 'Pregunta la sede']);
  assert.equal(bat.guardarCaso(db, { activo: false }, n.id).activo, false);
});

test('un momento: Sofía contesta una vez; pasa solo si no hay fallos automáticos y el juez da todo por bueno', async () => {
  const db = openDb(':memory:');
  const caso = bat.guardarCaso(db, { nombre: 'Precio', tipo: 'momento', contexto: [['lead', 'hola'], ['ia', 'hola, soy Sofía'], ['lead', 'qué es academy']], criterios: ['Explica Academy', 'No inventa'] });
  let r = await bat.ejecutarCaso(db, caso, { complete: sofia('es nuestro programa para empezar de cero'), completeJSON: juez(true) });
  assert.equal(r.pasa, true);
  assert.deepEqual(r.conversacion.at(-1), { autor: 'ia', texto: 'es nuestro programa para empezar de cero' });
  assert.ok(r.usd > 0);
  r = await bat.ejecutarCaso(db, caso, { complete: sofia('es nuestro programa para empezar de cero'), completeJSON: juez([true, false]) });
  assert.equal(r.pasa, false);
  assert.deepEqual(r.criterios.map((x) => x.cumple), [true, false]);
  r = await bat.ejecutarCaso(db, caso, { complete: sofia('¿Qué tal? Es nuestro programa.'), completeJSON: juez(true) });
  assert.equal(r.pasa, false); // estilo: ¿ y punto final
  assert.ok(r.fallosAuto.length >= 1);
});

test('un escenario: el lead simulado habla varios turnos, ve la conversación del revés y corta con [FIN]', async () => {
  const db = openDb(':memory:');
  const caso = bat.guardarCaso(db, { nombre: 'Esc', tipo: 'escenario', perfil: 'Marta, de Getafe', apertura: 'hola, precio?', turnos: 5, criterios: ['Da el precio'] });
  const vistas = [];
  const completeLead = async (req) => { vistas.push(req); return { content: [{ type: 'text', text: vistas.length === 1 ? 'en getafe' : '[FIN]' }], usage: {} }; };
  let n = 0;
  const r = await bat.ejecutarCaso(db, caso, { complete: sofia(() => (++n === 1 ? 'de qué sede?' : 'en getafe academy son 89 €')), completeLead, completeJSON: juez((txt) => /89 €/.test(txt)) });
  assert.deepEqual(r.conversacion.map((m) => [m.autor, m.texto]), [['lead', 'hola, precio?'], ['ia', 'de qué sede?'], ['lead', 'en getafe'], ['ia', 'en getafe academy son 89 €']]);
  assert.equal(r.pasa, true);
  assert.match(vistas[0].system, /Marta, de Getafe/);
  assert.deepEqual(vistas[0].messages.map((m) => m.role), ['user', 'assistant', 'user']); // empieza él; Sofía es «user»
  // Socio: Sofía no contesta
  const socio = bat.guardarCaso(db, { nombre: 'Socio', tipo: 'escenario', perfil: 'socio', apertura: 'quiero congelar', socio: true, criterios: ['No contesta'] });
  const rs = await bat.ejecutarCaso(db, socio, { complete: async () => { throw new Error('no debería llamarse'); }, completeLead: lead([]), completeJSON: juez(true) });
  assert.equal(rs.estado.tipo, 'socio');
  assert.equal(rs.conversacion.length, 1);
});

test('pasadas: repite cada caso, guarda el resultado, y compara un borrador con producción', async () => {
  const db = openDb(':memory:');
  const a = bat.guardarCaso(db, { nombre: 'A', tipo: 'momento', tema: 'precio', contexto: [['lead', 'precio?']], criterios: ['Pregunta la sede'] });
  bat.guardarCaso(db, { nombre: 'B', tipo: 'momento', tema: 'sede', grupo: 'reserva', contexto: [['lead', 'dónde estáis?']], criterios: ['Da la dirección'] });
  bat.guardarCaso(db, { nombre: 'Apagado', tipo: 'momento', activo: false, contexto: [['lead', 'x']], criterios: ['y'] });
  // Producción: Sofía falla el caso A; con el borrador (que lleva MEJORA en el prompt) lo acierta
  const complete = sofia((req) => (/dónde/.test(JSON.stringify(req.messages)) ? 'calle Roma 18' : /MEJORA/.test(req.system[0].text) ? 'de qué sede?' : 'son 85 €'));
  const completeJSON = juez((txt) => !/SOFÍA: son 85 €/.test(txt));
  const p1 = bat.lanzarPasada(db, { repeticiones: 2, complete, completeJSON }); await p1.fin;
  let r = bat.resumenPasada(db, p1.id);
  assert.equal(r.pasada.estado, 'terminada');
  assert.deepEqual([r.pasada.total, r.pasada.hechos, r.pasada.pasan], [4, 4, 2]);
  assert.equal(r.casos[0].id, a.id); // los que fallan, primero
  assert.equal(r.casos[0].repeticiones.length, 2);
  assert.deepEqual(r.porGrupo.map((g) => [g.nombre, g.pasan, g.total]), [['ajuste', 0, 2], ['reserva', 2, 2]]);
  const bor = docs.crearVersion(db, 'prompt', `${docs.enProduccion(db, 'prompt').texto}\nMEJORA`, { nota: 'x' });
  const p2 = bat.lanzarPasada(db, { repeticiones: 2, borradores: { prompt: bor.id }, complete, completeJSON }); await p2.fin;
  r = bat.resumenPasada(db, p2.id);
  assert.equal(r.pasada.pasan, 4);
  assert.equal(r.pasada.prompt_v, 2);
  const c = bat.comparar(db, p1.id, p2.id);
  assert.deepEqual([c.mejoran.map((x) => x.nombre), c.empeoran], [['A'], []]);
  assert.deepEqual([c.antes.pct, c.ahora.pct], [0.5, 1]);
  // Filtro por grupo y error en un caso
  const p3 = bat.lanzarPasada(db, { repeticiones: 1, filtro: { grupo: 'reserva' }, complete: async () => { throw new Error('API caída'); }, completeJSON }); await p3.fin;
  r = bat.resumenPasada(db, p3.id);
  assert.equal(r.pasada.total, 1);
  assert.match(r.casos[0].repeticiones[0].error, /API caída/);
  assert.throws(() => bat.lanzarPasada(db, { filtro: { tema: 'no-existe' } }), /No hay casos/);
});

test('un reporte aplicado se convierte en caso de la batería', async () => {
  const db = openDb(':memory:');
  const linea = docs.enProduccion(db, 'prompt').texto.split('\n').find((l) => l.startsWith('- **Precio:**'));
  const id = reportes.crear(db, { origen: 'prueba', respuesta_ia: 'te cuento', contexto: [{ autor: 'lead', texto: 'precio en parla? mi mail es ana@x.es' }, { autor: 'ia', texto: 'te cuento' }], meta: { channel: 'instagram' }, que_fallo: 'promete y no da', que_esperaba: 'que pregunte la experiencia' });
  const cola = [{ clasificacion: 'cambiar', explicacion: 'x', pregunta: '', documento: 'prompt', cambios: [{ buscar: linea, reemplazar: `${linea} X` }], resumen: 'r' }, { arreglado: true, motivo: 'ok', problemas_nuevos: '' }];
  await reportes.analizar(db, id, { complete: sofia('has hecho crossfit alguna vez?'), completeJSON: async () => ({ content: [{ type: 'text', text: JSON.stringify(cola.shift()) }] }) });
  reportes.aplicar(db, id);
  const c = bat.obtenerCaso(db, `reporte-${id}`);
  assert.equal(c.canal, 'instagram');
  assert.deepEqual(c.contexto, [['lead', 'precio en parla? mi mail es [email]']]);
  assert.match(c.criterios[0], /que pregunte la experiencia/);
});

test('la sede para comprobar horas sale de la ficha o del lead, no de lo que enumera Sofía', async () => {
  const { sedeDe } = await import('../src/bateria.js');
  const conv = [{ autor: 'ia', texto: 'te pilla mejor Parla, Getafe o Las Rosas?' }, { autor: 'lead', texto: 'getafe' }];
  assert.equal(sedeDe(null, conv), 'getafe');
  assert.equal(sedeDe('las_rosas', conv), 'las_rosas');
  assert.equal(sedeDe(null, [{ autor: 'ia', texto: 'Parla o Getafe?' }, { autor: 'lead', texto: 'no sé' }]), null);
});

test('si la IA se queda sin saldo, la pasada se para y no apunta fallos', async () => {
  const { openDb } = await import('../src/db.js');
  const b = await import('../src/bateria.js');
  const db = openDb(':memory:'); b.sembrarCasos(db);
  const sinSaldo = async () => { throw new Error('400 {"type":"error","error":{"message":"Your credit balance is too low to access the Anthropic API."}}'); };
  const p = b.lanzarPasada(db, { repeticiones: 1, complete: sinSaldo, completeLead: sinSaldo, completeJSON: sinSaldo });
  await p.fin;
  const fila = db.prepare('SELECT * FROM bateria_pasadas WHERE id = ?').get(p.id);
  assert.equal(fila.estado, 'error'); assert.match(fila.error, /saldo/);
  assert.equal(db.prepare('SELECT count(*) n FROM bateria_resultados').get().n, 0);
});

test('la batería reconoce el límite mensual de gasto de la API como IA no disponible', async () => {
  const { SIN_SERVICIO } = await import('../src/bateria.js');
  assert.ok(SIN_SERVICIO.test('400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC."}}'));
  assert.ok(SIN_SERVICIO.test('Your credit balance is too low'));
  assert.ok(!SIN_SERVICIO.test('overloaded_error'));
});
