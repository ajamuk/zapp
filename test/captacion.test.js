// Captación por nivel de conciencia. Todos los datos son sintéticos: ningún lead real, ninguna llamada de red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { openDb, repo as crearRepo } from '../src/db.js';
import { crearApp } from '../src/server.js';
import * as cap from '../src/captacion.js';
import { diagnosticoHistorico, informe } from '../scripts/diagnostico-captacion.js';

const AHORA = new Date('2026-11-17T11:00:00Z'); // martes 12:00 en Madrid
const DIA = 864e5;
const cfg = cap.cargarConfig();
const hace = (dias) => new Date(AHORA.getTime() - dias * DIA).toISOString();

/** Contacto sintético que cae en el grupo pedido (el reparto es fijo por contacto). */
function contacto(grupo, desde = 0) {
  for (let i = desde; i < desde + 500; i++) if (cap.grupoDe(`k${i}`, cfg.control_pct) === grupo) return `k${i}`;
  throw new Error('sin contacto');
}

/** Chat frío sintético: `hilo` = [[autor, texto], …]; el último mensaje es de hace `dias` días. */
function chat(repo, id, hilo, { dias = 6, grupo = 'tratamiento', canal = 'whatsapp', telefono = '+34600000001', ...conv } = {}) {
  repo.upsertConv({ id, contact_id: contacto(grupo, id.length * 7), channel: canal, nombre: 'Lead Sintético', telefono });
  if (Object.keys(conv).length) repo.updateConv(id, conv);
  for (const [autor, texto] of hilo) repo.addMessage({ conversation_id: id, autor, texto, created_at: hace(dias) });
  return repo.getConv(id);
}
const montar = () => crearRepo(openDb(':memory:'));
const perfil = (repo, id) => repo.db.prepare('SELECT * FROM captacion_perfiles WHERE conversation_id = ?').get(id);
const toques = (repo, id) => repo.db.prepare('SELECT * FROM captacion_toques WHERE conversation_id = ? ORDER BY orden, id').all(id);
const vuelta = (repo, ahora = AHORA, extra = {}) => cap.ciclo({ repo, ahora, cfg, ...extra });
const PRECIO = [['lead', 'hola, cuánto cuesta en getafe? nunca he hecho crossfit'], ['ia', 'academy 2 días son 89 € al mes'], ['lead', 'uf, es un poco caro']];

// ---------- Diagnóstico ----------

test('diagnóstico por reglas: niveles 1 a 5, motivo, freno y ruta', () => {
  const d = (hilo, conv = {}) => cap.diagnosticoHeuristico(conv, hilo.map(([autor, texto]) => ({ autor, texto })));
  assert.equal(d([['lead', 'hola, info']]).nivel, 1);
  assert.equal(d([['lead', '[story_mention]']]).nivel, 1);
  const n2 = d([['lead', 'hola, quiero perder peso y ponerme en forma, pero no sé si esto es para mí']]);
  assert.deepEqual([n2.nivel, n2.motivo], [2, 'peso']);
  const n3 = d([['lead', 'llevo dos años haciendo crossfit en otro box y me he mudado']]);
  assert.deepEqual([n3.nivel, n3.ruta], [3, 'crossfit']);
  const n4 = d(PRECIO);
  assert.deepEqual([n4.nivel, n4.freno, n4.ruta], [4, 'precio', 'academy']);
  const n5 = d([...PRECIO.slice(0, 2), ['lead', 'vale, el mes que viene cuando cobre me apunto']]);
  assert.deepEqual([n5.nivel, n5.freno], [5, 'momento']);
  assert.equal(d([['lead', 'qué horarios tenéis en parla?'], ['ia', 'por la tarde hay a las 18:30'], ['lead', 'me da respeto, no estoy en forma']]).freno, 'miedo');
  assert.equal(d([['lead', 'horarios en getafe?'], ['lead', 'se puede probar una clase antes?']]).freno, 'prueba');
  assert.equal(d([['lead', 'precio en parla?'], ['lead', 'es caro, me lo pienso']]).freno, 'precio'); // el freno concreto manda sobre «lo pienso»
  assert.equal(d([['lead', 'quiero hacer hyrox con mi amiga']]).motivo, 'hyrox');
  assert.equal(d([['lead', 'no me interesa, no me escribáis más']]).oposicion, true);
  assert.equal(d(PRECIO).oposicion, false);
});

test('diagnóstico con IA: la conversación sale sin emails ni teléfonos ni nombre, y si el modelo falla se usan las reglas', async () => {
  const pedidos = [];
  const complete = async (req) => { pedidos.push(req); return { content: [{ type: 'text', text: JSON.stringify({ nivel: 5, motivo: 'fuerza', freno: 'momento', ruta: 'academy', oposicion: false, evidencia: 'conoce su cuota y lo aplaza' }) }] }; };
  const hilo = [{ autor: 'lead', texto: 'soy Marta, mi email es marta@ejemplo.es y mi móvil 612 345 678, cuánto cuesta?' }, { autor: 'ia', texto: 'son 89 € al mes' }];
  const d = await cap.diagnosticar({ channel: 'whatsapp', sede: 'getafe', nombre: 'Marta Sintética', telefono: '+34612345678' }, hilo, { complete });
  assert.deepEqual([d.nivel, d.motivo, d.freno, d.origen], [5, 'fuerza', 'momento', 'ia']);
  const enviado = JSON.stringify(pedidos[0]);
  assert.doesNotMatch(enviado, /marta@ejemplo\.es|612 345 678|612345678|Sintética/);
  assert.match(enviado, /\[email\]/); assert.match(enviado, /\[teléfono\]/); assert.match(enviado, /89 €/);

  const roto = await cap.diagnosticar({}, hilo, { complete: async () => ({ content: [{ type: 'text', text: '{"nivel":9}' }] }) });
  assert.equal(roto.origen, 'heuristico'); assert.equal(roto.nivel, 4);
  const caido = await cap.diagnosticar({}, hilo, { complete: async () => { throw new Error('sin red'); } });
  assert.equal(caido.origen, 'heuristico'); assert.match(caido.evidencia, /sin red/);
  // Aunque el modelo no la vea, la oposición detectada por las reglas no se pierde
  const opo = await cap.diagnosticar({}, [{ autor: 'lead', texto: 'no me escribas más' }], { complete });
  assert.equal(opo.oposicion, true);
});

test('grupo de control: reparto fijo por contacto y cerca del porcentaje configurado', () => {
  const grupos = Array.from({ length: 2000 }, (_, i) => cap.grupoDe(`contacto-${i}`, 20));
  const control = grupos.filter((g) => g === 'control').length / 2000;
  assert.ok(control > 0.16 && control < 0.24, `control = ${control}`);
  assert.equal(cap.grupoDe('contacto-7', 20), cap.grupoDe('contacto-7', 20));
  assert.equal(cap.grupoDe('x', 0), 'tratamiento'); assert.equal(cap.grupoDe('x', 100), 'control');
});

// ---------- Planificación ----------

test('planificación por nivel: piezas de su freno, cadencia caliente o fría y siempre a las 11:00 de Madrid', async () => {
  const repo = montar();
  chat(repo, 'precio', PRECIO, { sede: 'getafe' });
  chat(repo, 'problema', [['lead', 'quiero ponerme en forma, no sé por dónde empezar']]);
  chat(repo, 'momento', [...PRECIO.slice(0, 2), ['lead', 'en enero me apunto']], { sede: 'parla' });
  const r = await vuelta(repo);
  assert.deepEqual([r.diagnosticados, r.planes, r.borradores], [3, 3, 0]);

  const precio = toques(repo, 'precio');
  assert.deepEqual(precio.map((t) => t.pieza), ['n4-precio-menos-dias', 'n4-precio-prorrateo', 'sin-permanencia']);
  // Caliente (nivel 4): días 7, 14 y 30 desde su último mensaje (hace 6 días)
  assert.deepEqual(precio.map((t) => Math.round((new Date(t.due_at) - new Date(hace(6))) / DIA)), [7, 14, 30]);
  for (const t of precio) assert.equal(new Date(t.due_at).toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' }), '11:00');

  const problema = toques(repo, 'problema');
  assert.deepEqual(problema.map((t) => t.pieza), ['n2-historia-socio', 'n2-clase-1h', 'n2-gente-normal']);
  assert.deepEqual(problema.map((t) => Math.round((new Date(t.due_at) - new Date(hace(6))) / DIA)), [10, 25, 45]); // fría

  assert.deepEqual(toques(repo, 'momento').map((t) => t.pieza), ['n5-inicio-mes', 'n5-alta-preparada']);
  assert.equal(perfil(repo, 'momento').nivel, 5);
});

test('planificación: reglas por sede, tope por valoración y leads antiguos', () => {
  const p = (nivel, freno, ruta = 'academy') => ({ nivel, freno, ruta, motivo: 'forma', toques_sin_respuesta: 0 });
  const ids = (perfilLead, conv) => cap.piezasPara(perfilLead, conv, cfg).map((x) => x.id);
  // La clase de prueba solo se ofrece en Parla; en Getafe se explica el mes sin permanencia
  assert.equal(ids(p(4, 'prueba'), { sede: 'parla' })[0], 'n4-prueba-parla');
  assert.equal(ids(p(4, 'prueba'), { sede: 'getafe' })[0], 'n4-prueba-un-mes');
  assert.ok(!ids(p(4, 'miedo'), { sede: 'las_rosas' }).includes('n4-prueba-parla'));
  // El Cañaveral: ni prorrateo ni horarios (no publicados); sus disparadores son la apertura y el orden de alta
  const canaveral = ids(p(5, 'momento'), { sede: 'el_canaveral' });
  assert.deepEqual(canaveral, ['n5-canaveral-apertura', 'n5-canaveral-orden']);
  assert.ok(!ids(p(4, 'horario'), { sede: 'el_canaveral' }).includes('n4-horario'));
  // Con experiencia no se le manda Academy
  assert.ok(!ids(p(3, 'desconocido', 'crossfit'), { sede: 'parla' }).includes('n3-academy'));

  const conv = (extra) => ({ channel: 'whatsapp', sede: 'getafe', ...extra });
  const plan = (perfilLead, c, ultima = new Date(hace(6))) => cap.planificar(perfilLead, c, ultima, AHORA, cfg);
  assert.equal(plan(p(4, 'precio'), conv({ valoracion: 2 })).length, 2); // poco probable: menos plantillas de pago
  assert.equal(plan(p(1, 'desconocido'), conv()).length, 0);              // nivel 1: solo lanzamientos
  assert.equal(plan(p(4, 'precio'), conv({ channel: 'instagram' })).length, 0);
  assert.equal(plan({ ...p(4, 'precio'), toques_sin_respuesta: 3 }, conv()).length, 1); // le queda un toque hasta el tope
  // Lead de hace 60 días: el primero es mañana y los demás conservan la distancia (7 → 14 → 30)
  const viejo = plan(p(4, 'precio'), conv(), new Date(hace(60)));
  assert.deepEqual(viejo.map((t) => Math.round((new Date(t.due_at) - AHORA) / DIA)), [1, 8, 24]);
});

// ---------- Sin solapamiento con los seguimientos de Sofía ----------

test('no se diagnostica ni planifica mientras Sofía tenga seguimientos pendientes o la conversación sea reciente', async () => {
  const repo = montar();
  chat(repo, 'con-seguimiento', PRECIO);
  repo.schedule('con-seguimiento', 'cierre-4-dias', new Date(AHORA.getTime() + DIA).toISOString());
  chat(repo, 'reciente', PRECIO, { dias: 2 });
  chat(repo, 'largo-plazo', PRECIO, { dias: 20 });
  repo.schedule('largo-plazo', 'largo-plazo', new Date(AHORA.getTime() + 10 * DIA).toISOString(), { fecha: '2026-11-27' }, 'largo-plazo');
  chat(repo, 'prueba-x', PRECIO); // chats de Probar IA: nunca
  const r = await vuelta(repo);
  assert.equal(r.diagnosticados, 0);
  assert.equal(repo.db.prepare('SELECT count(*) n FROM captacion_perfiles').get().n, 0);
  // La primera cadencia nunca empieza antes de que termine el «cierre a 4 días»
  assert.throws(() => cap.validarConfig({ ...cfg, cadencias: { caliente: [3, 10], frio: [10] } }), /antes de terminar los seguimientos/);
});

test('si aparece un seguimiento de Sofía cuando vence un toque, el plan entero se retrasa', async () => {
  const repo = montar();
  chat(repo, 'c1', PRECIO, { sede: 'getafe' });
  await vuelta(repo);
  const antes = toques(repo, 'c1').map((t) => t.due_at);
  const cuando = new Date(new Date(antes[0]).getTime() + 3600e3);
  const pendiente = new Date(cuando.getTime() + 2 * DIA);
  repo.schedule('c1', 'manual', pendiente.toISOString(), null, 'manual', 'mensaje a mano del equipo');
  const r = await vuelta(repo, cuando);
  assert.deepEqual([r.borradores, r.aplazados], [0, 1]);
  const despues = toques(repo, 'c1');
  assert.ok(despues.every((t) => t.estado === 'previsto'));
  assert.equal(new Date(despues[0].due_at).getTime(), pendiente.getTime() + cfg.separacion_dias * DIA);
  assert.equal(new Date(despues[1].due_at) - new Date(despues[0].due_at), new Date(antes[1]) - new Date(antes[0]));
});

// ---------- Borradores (modo prueba) ----------

test('al vencer un toque queda un borrador: nada se envía, ni a GHL ni a la cola de seguimientos', async () => {
  const repo = montar();
  chat(repo, 'c1', PRECIO, { sede: 'getafe' });
  await vuelta(repo);
  const mensajes = repo.db.prepare('SELECT count(*) n FROM messages').get().n;
  const r = await vuelta(repo, new Date(new Date(toques(repo, 'c1')[0].due_at).getTime() + 60000));
  assert.equal(r.borradores, 1);
  const [t] = toques(repo, 'c1');
  assert.equal(t.estado, 'borrador');
  assert.match(t.texto, /cuota de menos días/);
  assert.match(t.detalle, /no se ha enviado/);
  assert.equal(perfil(repo, 'c1').toques_sin_respuesta, 1);
  // El chat queda como estaba: ni mensajes nuevos ni envíos programados
  assert.equal(repo.db.prepare('SELECT count(*) n FROM messages').get().n, mensajes);
  assert.equal(repo.db.prepare('SELECT count(*) n FROM scheduled').get().n, 0);
  assert.equal(cap.MODO, 'prueba');
  assert.equal(repo.db.prepare("SELECT count(*) n FROM captacion_toques WHERE estado NOT IN ('previsto', 'borrador', 'omitido', 'cancelado')").get().n, 0);
  // El módulo no tiene por dónde enviar: no conoce a GHL ni el envío de Sofía
  const fuente = fs.readFileSync(new URL('../src/captacion.js', import.meta.url), 'utf8');
  assert.doesNotMatch(fuente, /ghl\.js|sendMessage|enviarPorPlantilla|setter\.enviar|repo\.schedule\(|INSERT INTO (scheduled|messages)/);
});

test('el material que falta se apunta en el borrador y, si está en Recursos, sale como enlace', async () => {
  const repo = montar();
  chat(repo, 'c1', [['lead', 'quiero ponerme en forma']]);
  chat(repo, 'c2', [['lead', 'quiero perder peso']], { telefono: '+34600000002' });
  await vuelta(repo);
  repo.db.prepare("INSERT INTO recursos (nombre, descripcion, tipo, media_ruta, mime, tamano, token) VALUES ('video-clase-1h', 'clase', 'video', 'v.mp4', 'video/mp4', 10, 'tok123')").run();
  await vuelta(repo, new Date(new Date(toques(repo, 'c1')[1].due_at).getTime() + 60000));
  const [uno, dos] = toques(repo, 'c1');
  assert.equal(uno.material_falta, 'testimonio-empezo-de-cero');
  assert.equal(dos.material_falta, null); assert.match(dos.texto, /\/r\/tok123\.mp4$/);
  const material = cap.materialPendiente(repo.db, cfg);
  assert.equal(material.find((m) => m.clave === 'video-clase-1h').disponible, true);
  const falta = material.find((m) => m.clave === 'testimonio-empezo-de-cero');
  assert.deepEqual([falta.disponible, falta.borradores], [false, 2]);
});

test('borrador redactado por Sofía (opcional): una sola frase; si decide no enviarlo, se omite; no ofrece la prueba dos veces', async () => {
  const repo = montar();
  chat(repo, 'c1', PRECIO, { sede: 'getafe' });
  chat(repo, 'c2', [['lead', 'horarios en parla? nunca he hecho nada, no estoy en forma'], ['ia', 'si quieres te dejo una clase de prueba gratis']], { sede: 'parla', telefono: '+34600000002' });
  await vuelta(repo);
  assert.equal(toques(repo, 'c2')[0].pieza, 'n4-prueba-parla');
  const contextos = [];
  const redactar = async (convId, contexto) => { contextos.push(contexto); return contextos.length === 1 ? 'te cuento la cuota de 1 día\nsegunda línea que sobra' : ''; };
  await vuelta(repo, new Date(new Date(toques(repo, 'c1')[1].due_at).getTime() + 60000), { redactar });
  const c1 = toques(repo, 'c1');
  assert.deepEqual([c1[0].estado, c1[0].texto], ['borrador', 'te cuento la cuota de 1 día']);
  assert.equal(c1[1].estado, 'omitido'); assert.match(c1[1].detalle, /decidió no enviarlo/);
  assert.match(contextos[0], /nivel de conciencia 4/); assert.match(contextos[0], /freno principal: precio/);
  assert.equal(perfil(repo, 'c1').toques_sin_respuesta, 1); // el omitido no cuenta como toque
  const c2 = toques(repo, 'c2');
  assert.equal(c2[0].estado, 'omitido'); assert.match(c2[0].detalle, /clase de prueba/);
});

// ---------- Paradas ----------

test('paradas: respuesta, alta, socio, derivación, oposición y pausa cancelan el plan', async () => {
  const repo = montar();
  const ids = ['responde', 'alta', 'socio', 'socio-recepcion', 'derivado', 'opuesto', 'palabra-parar', 'pausado', 'equipo'];
  ids.forEach((id, i) => chat(repo, id, PRECIO, { sede: 'getafe', telefono: `+3460000010${i}` }));
  await vuelta(repo);
  for (const id of ids) assert.equal(perfil(repo, id).estado, 'activo', id);

  const luego = new Date(AHORA.getTime() + 3600e3);
  repo.addMessage({ conversation_id: 'responde', autor: 'lead', texto: 'vale, y por la mañana?', created_at: luego.toISOString() });
  repo.updateConv('alta', { alta_estado: 'preparada' });
  repo.updateConv('socio', { tipo: 'socio' });
  repo.reemplazarSocios('getafe', [{ telefono: '600000103', sede: 'getafe', aimharder_id: 1, nombre: 'x', activo: 1, tarifa: 'M' }]); // alta en recepción
  repo.updateConv('derivado', { derivado: 1, ai_paused: 1, pause_reason: 'derivado: salud' });
  repo.addMessage({ conversation_id: 'opuesto', autor: 'lead', texto: 'no me escribáis más por favor', created_at: luego.toISOString() });
  repo.updateConv('palabra-parar', { ai_paused: 1, pause_reason: 'el lead escribió «baja»' });
  repo.updateConv('pausado', { ai_paused: 1, pause_reason: 'pausada desde el panel' });
  repo.addMessage({ conversation_id: 'equipo', autor: 'humano', texto: 'hola, soy Laura del box', created_at: luego.toISOString() });
  const r = await vuelta(repo, new Date(luego.getTime() + 60000));
  assert.equal(r.respuestas, 1);

  const esperado = {
    responde: ['conversando', 'el lead respondió'], alta: ['parado', 'alta'], socio: ['parado', 'socio'], 'socio-recepcion': ['parado', 'socio'],
    derivado: ['pausado', 'derivación'], opuesto: ['parado', 'oposición'], 'palabra-parar': ['parado', 'oposición'],
    pausado: ['pausado', 'chat en pausa (lo lleva el equipo)'], equipo: ['conversando', 'el equipo escribió'],
  };
  for (const [id, [estado, detalle]] of Object.entries(esperado)) {
    const p = perfil(repo, id);
    assert.deepEqual([p.estado, p.detalle], [estado, detalle], id);
    assert.ok(toques(repo, id).every((t) => t.estado === 'cancelado'), `${id}: toques cancelados`);
  }
  assert.ok(perfil(repo, 'responde').respondio_at);
  assert.equal(perfil(repo, 'equipo').respondio_at, null);

  // Ni con el tiempo: los parados no vuelven a tener plan ni borradores
  const r2 = await vuelta(repo, new Date(AHORA.getTime() + 60 * DIA));
  assert.equal(r2.borradores, 0);
  for (const id of ['alta', 'socio', 'socio-recepcion', 'opuesto', 'palabra-parar', 'derivado', 'pausado']) assert.ok(toques(repo, id).every((t) => t.estado === 'cancelado'), id);
});

test('quien ya está parado antes del primer diagnóstico no entra (ni se manda al modelo)', async () => {
  const repo = montar();
  chat(repo, 'opuesto', [...PRECIO, ['lead', 'no me interesa']]);
  chat(repo, 'socio', PRECIO, { tipo: 'socio', telefono: '+34600000002' });
  chat(repo, 'alta', PRECIO, { alta_estado: 'pendiente', telefono: '+34600000003' });
  chat(repo, 'derivado', PRECIO, { derivado: 1, telefono: '+34600000004' });
  let llamadas = 0;
  const r = await vuelta(repo, AHORA, { complete: async () => { llamadas++; throw new Error('no debería llamarse'); } });
  assert.deepEqual([r.diagnosticados, llamadas], [0, 0]);
});

test('tras responder, si el chat se enfría otra vez se diagnostica de nuevo y se mide la subida de nivel', async () => {
  const repo = montar();
  chat(repo, 'c1', [['lead', 'quiero ponerme en forma']]);
  await vuelta(repo);
  assert.equal(perfil(repo, 'c1').nivel, 2);
  const t1 = new Date(AHORA.getTime() + 2 * DIA);
  repo.addMessage({ conversation_id: 'c1', autor: 'lead', texto: 'cuánto cuesta en parla?', created_at: t1.toISOString() });
  repo.addMessage({ conversation_id: 'c1', autor: 'ia', texto: 'academy 2 días son 85 € al mes', created_at: t1.toISOString() });
  await vuelta(repo, new Date(t1.getTime() + DIA));
  assert.equal(perfil(repo, 'c1').estado, 'conversando');
  assert.equal(toques(repo, 'c1').filter((t) => t.estado === 'previsto').length, 0);
  await vuelta(repo, new Date(t1.getTime() + 6 * DIA));
  const p = perfil(repo, 'c1');
  assert.deepEqual([p.estado, p.nivel, p.nivel_inicial, p.grupo], ['activo', 4, 2, 'tratamiento']);
  assert.equal(repo.db.prepare("SELECT count(*) n FROM captacion_diagnosticos WHERE conversation_id = 'c1'").get().n, 2);
  assert.equal(cap.datosPanel(repo.db, { cfg }).grupos.tratamiento.suben, 1);
});

test('tope de toques sin respuesta: el lead pasa a dormido y no recibe más', async () => {
  const repo = montar();
  chat(repo, 'c1', [['lead', 'quiero ponerme en forma']], { valoracion: 8 });
  await vuelta(repo);
  // Nivel 2: solo hay tres piezas, así que el plan se acaba antes del tope de 4
  assert.equal(toques(repo, 'c1').length, 3);
  const r = await vuelta(repo, new Date(AHORA.getTime() + 90 * DIA));
  assert.equal(r.borradores, 3);
  const p = perfil(repo, 'c1');
  assert.deepEqual([p.estado, p.toques_sin_respuesta], ['dormido', 3]);
  assert.match(p.detalle, /solo lanzamientos/);
  // Con el tope más bajo, corta el plan a mitad
  const repo2 = montar();
  chat(repo2, 'c1', PRECIO, { sede: 'getafe' });
  const corto = { ...cfg, max_sin_respuesta: 2 };
  await cap.ciclo({ repo: repo2, ahora: AHORA, cfg: corto });
  assert.equal(toques(repo2, 'c1').length, 2);
  await cap.ciclo({ repo: repo2, ahora: new Date(AHORA.getTime() + 90 * DIA), cfg: corto });
  assert.deepEqual([perfil(repo2, 'c1').estado, perfil(repo2, 'c1').toques_sin_respuesta], ['dormido', 2]);
  assert.equal((await cap.ciclo({ repo: repo2, ahora: new Date(AHORA.getTime() + 200 * DIA), cfg: corto })).diagnosticados, 0);
});

// ---------- Grupo de control, niveles sin plan y panel ----------

test('grupo de control, nivel 1 e Instagram se diagnostican pero no reciben toques', async () => {
  const repo = montar();
  chat(repo, 'control', PRECIO, { grupo: 'control' });
  chat(repo, 'nivel1', [['lead', 'hola, info']], { telefono: '+34600000002' });
  chat(repo, 'insta', PRECIO, { canal: 'instagram', telefono: null });
  const r = await vuelta(repo);
  assert.deepEqual([r.diagnosticados, r.planes], [3, 0]);
  assert.deepEqual([perfil(repo, 'control').estado, perfil(repo, 'control').grupo, perfil(repo, 'control').nivel], ['control', 'control', 4]);
  assert.deepEqual([perfil(repo, 'nivel1').estado, perfil(repo, 'nivel1').detalle], ['sin_plan', 'nivel 1: solo lanzamientos']);
  assert.match(perfil(repo, 'insta').detalle, /Instagram/);
  assert.equal(repo.db.prepare('SELECT count(*) n FROM captacion_toques').get().n, 0);
  // El grupo no cambia al volver a diagnosticar
  repo.addMessage({ conversation_id: 'control', autor: 'lead', texto: 'y los horarios?', created_at: new Date(AHORA.getTime() + DIA).toISOString() });
  await vuelta(repo, new Date(AHORA.getTime() + 2 * DIA));
  await vuelta(repo, new Date(AHORA.getTime() + 8 * DIA));
  assert.deepEqual([perfil(repo, 'control').estado, perfil(repo, 'control').grupo], ['control', 'control']);
  assert.ok(perfil(repo, 'control').respondio_at);
  assert.equal(cap.datosPanel(repo.db, { cfg }).grupos.control.respondieron, 1);
});

test('panel: la pestaña Captación enseña diagnósticos, plan, borradores y material, solo en lectura', async () => {
  config.adminToken = 'clave-test';
  const repo = montar();
  chat(repo, 'c1', [['lead', 'quiero ponerme en forma']]);
  await vuelta(repo);
  await vuelta(repo, new Date(new Date(toques(repo, 'c1')[0].due_at).getTime() + 60000));
  const srv = crearApp({ setter: {}, repo }).listen(0);
  await new Promise((ok) => srv.once('listening', ok));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await fetch(`${base}/admin/panel/captacion`)).status, 401);
    const d = await (await fetch(`${base}/admin/panel/captacion`, { headers: { authorization: 'Bearer clave-test' } })).json();
    assert.deepEqual([d.modo, d.activa, d.total], ['prueba', false, 1]);
    assert.equal(d.niveles.find((n) => n.nivel === 2).tratamiento, 1);
    assert.equal(d.borradores.length, 1); assert.equal(d.borradores[0].pieza_nombre, 'Historia de un socio que empezó de cero');
    assert.equal(d.proximos.length, 2);
    assert.equal(d.perfiles[0].estado, 'activo');
    assert.equal(d.material.find((m) => m.clave === 'testimonio-empezo-de-cero').disponible, false);
    assert.equal((await fetch(`${base}/admin/panel/captacion`, { method: 'POST', headers: { authorization: 'Bearer clave-test' } })).status, 404);
    assert.match(await (await fetch(`${base}/panel`)).text(), /async function captacion\(\)/);
  } finally { srv.close(); }
});

test('borrar un chat se lleva su perfil, sus diagnósticos y sus toques', async () => {
  const repo = montar();
  chat(repo, 'c1', PRECIO, { sede: 'getafe' });
  await vuelta(repo);
  repo.borrarConversacion('c1');
  for (const t of ['captacion_perfiles', 'captacion_diagnosticos', 'captacion_toques']) assert.equal(repo.db.prepare(`SELECT count(*) n FROM ${t}`).get().n, 0, t);
});

// ---------- Sofía y la vuelta automática ----------

test('la vuelta automática está apagada por defecto y no cambia nada de Sofía', () => {
  assert.equal(config.captacion.activa, false);
  assert.equal(config.captacion.redactarIA, false);
  const indice = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(indice, /if \(config\.captacion\.activa\) \{\s+cada\('captacion'/);
  // Ninguna regla de seguimiento nueva: las de Sofía salen solo de config/followups.json y de las suyas de la prueba
  const repo = montar();
  const semilla = JSON.parse(fs.readFileSync(new URL('../config/followups.json', import.meta.url), 'utf8')).reglas.map((x) => x.id);
  const reglas = repo.db.prepare('SELECT id FROM reglas_seguimiento').all().map((x) => x.id);
  assert.ok(semilla.every((id) => reglas.includes(id)));
  assert.ok(reglas.every((id) => !/captaci/i.test(id)));
  // Ni el prompt ni la lógica de Sofía importan el módulo de captación
  for (const f of ['setter.js', 'followups.js', 'llm.js', 'reglas.js']) assert.doesNotMatch(fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'), /captacion\.js/, f);
});

test('textos de las piezas: una frase al estilo de Sofía, sin promesas que el negocio no hace', () => {
  for (const p of cfg.piezas) {
    assert.doesNotMatch(p.texto, /[¿¡]|\.$|\n/, `${p.id}: sin ¿ ¡, sin punto final, una línea`);
    assert.ok((p.texto.match(/\?/g) || []).length <= 1, `${p.id}: como mucho una pregunta`);
    assert.doesNotMatch(p.texto, /te parece|te animas|descuento del|oferta|promoci[oó]n|últimas plazas|quedan \d+/i, `${p.id}: sin pedir permiso ni urgencia inventada`);
    if (/parla/i.test(p.texto) && /getafe/i.test(p.texto)) assert.match(p.texto, /Cañaveral/, `${p.id}: si enumera sedes, las cuatro`);
    if (/clase de prueba/.test(p.texto) && !/no deja ver/.test(p.texto)) assert.deepEqual(p.sedes, ['parla'], `${p.id}: la prueba solo en Parla`);
  }
});

// ---------- Diagnóstico histórico ----------

test('diagnóstico histórico: base en solo lectura, informe agregado y sin datos personales', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'captacion-'));
  const ruta = path.join(dir, 'sintetica.db');
  const repo = crearRepo(openDb(ruta));
  chat(repo, 'a', PRECIO, { sede: 'getafe', nombre: 'Nombre Secreto' });
  chat(repo, 'b', [['lead', 'quiero ponerme en forma, mi correo es secreto@ejemplo.es']], { telefono: '+34600000002' });
  chat(repo, 'c', [['lead', 'no me interesa']], { telefono: '+34600000003' });
  chat(repo, 'd', PRECIO, { tipo: 'socio', telefono: '+34600000004' });
  repo.db.pragma('wal_checkpoint(TRUNCATE)');
  const antes = repo.db.prepare('SELECT count(*) n FROM captacion_perfiles').get().n;
  const r = await diagnosticoHistorico({ db: ruta, ahora: AHORA });
  const texto = informe(r);
  assert.equal(r.res.length, 4);
  assert.match(texto, /4\. Consciente del producto \| 2 \|/);
  assert.match(texto, /Recibirían un plan de contenidos \| 2 \|/);
  assert.match(texto, /parado: oposición \| 1 \|/); assert.match(texto, /parado: socio \| 1 \|/);
  assert.match(texto, /`testimonio-empezo-de-cero` \| 1 \|/);
  assert.doesNotMatch(texto, /Secreto|secreto@|600000/);
  assert.equal(repo.db.prepare('SELECT count(*) n FROM captacion_perfiles').get().n, antes); // no escribe nada
  repo.db.close();
  // Export anonimizado (el formato de eval/casos-zapp.jsonl)
  const j = await diagnosticoHistorico({ jsonl: new URL('../eval/casos-zapp.jsonl', import.meta.url).pathname, ahora: AHORA });
  assert.ok(j.res.length > 20);
  assert.match(informe(j), /Origen: casos-zapp\.jsonl/);
  fs.rmSync(dir, { recursive: true, force: true });
});
