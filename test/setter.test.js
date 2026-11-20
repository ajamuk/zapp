import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import { procesarSeguimientos } from '../src/followups.js';
import { parseWebhook } from '../src/ghl.js';

// Un martes a las 12:00 en Madrid (dentro de horario)
const T0 = new Date('2026-11-17T11:00:00Z');

function montar({ respuestas, socio = false, live = true, alta = { estado: 'preparada' } } = {}) {
  const repo = crearRepo(openDb(':memory:'));
  const llamadas = { enviados: [], tags: [], notas: [], avisos: [], plantillas: [], asignados: [], requests: [] };
  const ghl = {
    sendMessage: async ({ texto }) => { llamadas.enviados.push(texto); return { messageId: `m${llamadas.enviados.length}` }; },
    sendTemplate: async ({ variables }) => { llamadas.plantillas.push(variables[0]); return {}; },
    addTags: async (_, t) => llamadas.tags.push(...t),
    removeTags: async () => {},
    assign: async (_, u) => llamadas.asignados.push(u),
    addNote: async (_, n) => llamadas.notas.push(n),
    getContact: async () => ({ contact: { phone: '+34600000000' } }),
  };
  let reloj = new Date(T0);
  const cola = [...(respuestas || [])];
  const complete = async (req) => {
    llamadas.requests.push(req);
    const r = cola.shift();
    if (!r) throw new Error('sin respuesta preparada');
    return { content: r.map((b, i) => ({ type: 'tool_use', id: `t${i}`, ...b })), usage: { input_tokens: 10, output_tokens: 5 } };
  };
  const setter = new Setter({
    repo, ghl, complete, live, sleep: async () => {}, now: () => reloj, random: () => 0,
    avisar: async (t) => llamadas.avisos.push(t),
    aimharder: {
      buscarSocioPorTelefono: async () => ({ esSocio: socio, sede: socio ? 'Getafe' : null }),
      prepararAlta: async () => alta,
    },
  });
  return { repo, setter, llamadas, avanzar: (ms) => { reloj = new Date(reloj.getTime() + ms); } };
}

const entrante = (texto, id = 'w1', extra = {}) => ({ evento: 'inbound', conversationId: 'c1', contactId: 'k1', canal: 'whatsapp', texto, messageId: id, telefono: '+34600000000', ...extra });

test('webhook de GHL se normaliza', () => {
  const e = parseWebhook({ type: 'InboundMessage', conversationId: 'c', contactId: 'k', messageType: 'WhatsApp', body: 'hola', messageId: 'x' });
  assert.deepEqual([e.evento, e.canal, e.texto], ['inbound', 'whatsapp', 'hola']);
  const o = parseWebhook({ type: 'OutboundMessage', conversationId: 'c', contactId: 'k', messageType: 'IG', userId: 'u1' });
  assert.deepEqual([o.evento, o.canal, o.userId], ['outbound', 'instagram', 'u1']);
});

test('un socio no recibe respuesta de la IA: se etiqueta, se asigna y se avisa', async () => {
  const { setter, repo, llamadas } = montar({ socio: true });
  const r = await setter.handleWebhook(entrante('no puedo reservar en la app'));
  assert.equal(r.socio, true);
  const c = repo.getConv('c1');
  assert.equal(c.tipo, 'socio');
  assert.equal(c.ai_paused, 1);
  assert.ok(llamadas.tags.includes('socio') && llamadas.tags.includes('getafe'));
  assert.equal(llamadas.avisos.length, 1);
  assert.equal(repo.dueResponses('2100-01-01').length, 0);
});

test('lead: espera, contesta con las burbujas y etiqueta la sede', async () => {
  const { setter, repo, llamadas, avanzar } = montar({
    respuestas: [
      [{ name: 'consultar_tarifas', input: { sede: 'getafe', familia: 'academy' } }],
      [{ name: 'responder', input: { mensajes: ['hola, soy Sofía de CrossFit MetroPolitano 😊', 'en Getafe Academy son 89 € al mes con 2 días o 99 € con 3', 'cuántos días te ves entrenando?'], sede: 'getafe', fase: 'f2 diagnóstico', etiquetas: [] } }],
    ],
  });
  await setter.handleWebhook(entrante('cuánto cuesta en getafe?'));
  assert.ok(repo.getConv('c1').respond_at, 'queda programada');
  await setter.tick();
  assert.equal(llamadas.enviados.length, 0, 'no contesta antes del retardo');
  avanzar(16000);
  await setter.tick();
  assert.equal(llamadas.enviados.length, 3);
  // la herramienta devolvió las tarifas reales al modelo
  const toolResult = llamadas.requests[1].messages.at(-1).content[0].content;
  assert.match(toolResult, /"euros_mes":89/);
  assert.ok(llamadas.tags.includes('getafe') && llamadas.tags.includes('f2 diagnóstico'));
  assert.equal(repo.getConv('c1').sede, 'getafe');
  // se programan los seguimientos de WhatsApp
  assert.equal(repo.db.prepare("SELECT count(*) n FROM scheduled WHERE estado='pendiente'").get().n, 4);
});

test('varios mensajes seguidos del lead se contestan juntos', async () => {
  const { setter, llamadas, avanzar } = montar({
    respuestas: [[{ name: 'responder', input: { mensajes: ['vale'], fase: 'f1 apertura' } }]],
  });
  await setter.handleWebhook(entrante('hola', 'w1'));
  avanzar(10000);
  await setter.handleWebhook(entrante('quería info', 'w2'));
  avanzar(10000);
  await setter.tick();
  assert.equal(llamadas.requests.length, 0, 'el segundo mensaje reinicia la espera');
  avanzar(10000);
  await setter.tick();
  assert.equal(llamadas.requests.length, 1);
  assert.equal(llamadas.requests[0].messages[0].content, 'hola\nquería info');
});

test('mensaje duplicado (GHL reintenta) se ignora', async () => {
  const { setter } = montar();
  await setter.handleWebhook(entrante('hola', 'w1'));
  const r = await setter.handleWebhook(entrante('hola', 'w1'));
  assert.equal(r.ignorado, 'duplicado');
});

test('si una persona del equipo escribe, la IA se pausa y se cancelan los seguimientos', async () => {
  const { setter, repo } = montar();
  await setter.handleWebhook(entrante('hola'));
  repo.schedule('c1', 'comercial-5h', '2026-11-17T20:00:00Z');
  await setter.handleWebhook({ evento: 'outbound', conversationId: 'c1', contactId: 'k1', texto: 'hola, soy Carlos', messageId: 'h1', userId: 'u9' });
  const c = repo.getConv('c1');
  assert.equal(c.ai_paused, 1);
  assert.equal(c.respond_at, null);
  assert.equal(repo.db.prepare("SELECT count(*) n FROM scheduled WHERE estado='pendiente'").get().n, 0);
});

test('modo prueba: no envía nada al lead, deja nota en GHL', async () => {
  const { setter, llamadas, avanzar } = montar({ live: false, respuestas: [[{ name: 'responder', input: { mensajes: ['hola'], fase: 'f1 apertura' } }]] });
  await setter.handleWebhook(entrante('hola'));
  avanzar(60000);
  await setter.tick();
  assert.equal(llamadas.enviados.length, 0);
  assert.match(llamadas.notas[0], /Borrador IA/);
});

test('derivar a equipo pausa la IA, etiqueta y avisa', async () => {
  const { setter, repo, llamadas, avanzar } = montar({
    respuestas: [
      [{ name: 'derivar_a_equipo', input: { motivo: 'salud', resumen: 'posparto reciente, quiere saber si puede entrenar' } }],
      [{ name: 'responder', input: { mensajes: ['lo reviso con el equipo y te escribimos por aquí'], fase: 'f2 diagnóstico' } }],
    ],
  });
  await setter.handleWebhook(entrante('tuve un bebé hace 2 meses'));
  avanzar(60000);
  await setter.tick();
  const c = repo.getConv('c1');
  assert.equal(c.derivado, 1);
  assert.ok(llamadas.tags.includes('derivado salud'));
  assert.match(llamadas.avisos.at(-1), /Derivado \(salud\)/);
  assert.equal(repo.db.prepare("SELECT count(*) n FROM scheduled WHERE estado='pendiente'").get().n, 0, 'sin seguimientos tras derivar');
});

test('alta sin configurar: el equipo recibe los datos y la IA no dice que está hecha', async () => {
  const { setter, repo, llamadas, avanzar } = montar({
    alta: { estado: 'no_configurado', detalle: 'faltan selectores' },
    respuestas: [
      [{ name: 'preparar_alta', input: { nombre_completo: 'Ana Prueba', email: 'ana@example.com', fecha_nacimiento: '1990-05-01', sede: 'las_rosas', tarifa: 'academy_3', fecha_inicio: '2026-11-23' } }],
      [{ name: 'responder', input: { mensajes: ['en cuanto esté te llega la invitación al correo'], fase: 'f5 cierre' } }],
    ],
  });
  await setter.handleWebhook(entrante('ana prueba, ana@example.com, 01/05/1990'));
  avanzar(60000);
  await setter.tick();
  assert.equal(repo.getConv('c1').alta_estado, 'pendiente');
  assert.match(llamadas.avisos.at(-1), /prorrateo previsto 28 €/);
  const resultado = llamadas.requests[1].messages.at(-1).content[0].content;
  assert.match(resultado, /pendiente_equipo/);
});

test('seguimientos: la IA puede decidir no enviar; si el lead contesta se cancelan', async () => {
  const { setter, repo, llamadas, avanzar } = montar({
    respuestas: [
      [{ name: 'responder', input: { mensajes: ['te paso horarios'], fase: 'f3 presentación' } }],
      [{ name: 'responder', input: { mensajes: [], fase: 'f3 presentación' } }],
    ],
  });
  await setter.handleWebhook(entrante('info'));
  avanzar(60000);
  await setter.tick();
  avanzar(301 * 60000); // 5 h después
  await procesarSeguimientos(setter);
  const fila = repo.db.prepare("SELECT * FROM scheduled WHERE regla_id='comercial-5h'").get();
  assert.equal(fila.estado, 'omitido');
  assert.equal(llamadas.enviados.length, 1);
  await setter.handleWebhook(entrante('ya estoy', 'w2'));
  assert.equal(repo.db.prepare("SELECT count(*) n FROM scheduled WHERE estado='pendiente'").get().n, 0);
});

test('fuera de la ventana de 24 h de WhatsApp solo sale la plantilla', async () => {
  const { setter, repo, llamadas, avanzar } = montar({
    respuestas: [
      [{ name: 'responder', input: { mensajes: ['te paso horarios'], fase: 'f3 presentación' } }],
      [{ name: 'responder', input: { mensajes: ['sigo por aquí si te encaja empezar en diciembre', 'segunda burbuja que no debe salir'], fase: 'f5 cierre' } }],
    ],
  });
  await setter.handleWebhook(entrante('info'));
  avanzar(60000);
  await setter.tick();
  for (const r of ['comercial-5h', 'info-tras-reserva', 'ultimo-intento-24h']) repo.db.prepare('UPDATE scheduled SET estado=? WHERE regla_id=?').run('omitido', r);
  avanzar(5760 * 60000); // 4 días
  await procesarSeguimientos(setter);
  assert.deepEqual(llamadas.plantillas, ['sigo por aquí si te encaja empezar en diciembre']);
});

test('menciones en historias no despiertan a la IA', async () => {
  const { setter } = montar();
  const r = await setter.handleWebhook(entrante('[story_mention]', 'w1', { canal: 'instagram' }));
  assert.equal(r.ignorado, 'mención o reacción');
});

test('alta verificada: el sistema avisa al lead con sede, fecha e importe pendiente de AimHarder', async () => {
  const { setter, repo, llamadas, avanzar } = montar({
    alta: { estado: 'preparada', exSocio: false, pendiente: 22.67, tarifa: 'CrossFit Academy 2 días', detalle: 'ok' },
    respuestas: [
      [{ name: 'preparar_alta', input: { nombre_completo: 'Ana Prueba', email: 'ana@example.com', fecha_nacimiento: '1990-05-01', sede: 'parla', tarifa: 'academy_2', fecha_inicio: '2026-11-23' } }],
      [{ name: 'responder', input: { mensajes: ['bienvenida a la familia'], fase: 'f5 cierre' } }],
    ],
  });
  await setter.handleWebhook(entrante('sí, adelante'));
  avanzar(60000);
  await setter.tick();
  assert.equal(repo.getConv('c1').alta_estado, 'preparada');
  const textos = repo.history('c1').filter((m) => m.autor === 'ia').map((m) => m.texto);
  assert.ok(textos.some((t) => /alta hecha en Parla para empezar el lunes, 23 de noviembre/.test(t)));
  assert.ok(textos.some((t) => /22,67 €/.test(t)));
  assert.match(llamadas.avisos.at(-1), /verificada en AimHarder/);
});

test('Sofía apagada desde el panel: no contesta y el chat queda para el equipo', async () => {
  const { setter, repo, llamadas, avanzar } = montar({ respuestas: [[{ name: 'responder', input: { mensajes: ['hola'], fase: 'f1 apertura' } }]] });
  const { guardarAjustes } = await import('../src/ajustes.js');
  guardarAjustes(repo, { ia_activa: false });
  await setter.handleWebhook(entrante('hola'));
  avanzar(60000);
  await setter.tick();
  assert.equal(llamadas.requests.length, 0);
  assert.equal(repo.getConv('c1').respond_at, null);
});

test('si el modelo contesta en texto sin llamar a responder, se le recuerda una vez', async () => {
  const { runTurn } = await import('../src/llm.js');
  const reqs = [];
  const cola = [
    { content: [{ type: 'text', text: 'hola!' }], stop_reason: 'end_turn' },
    { content: [{ type: 'tool_use', id: 't1', name: 'responder', input: { mensajes: ['hola!'], fase: 'f1 apertura' } }], stop_reason: 'tool_use' },
  ];
  const r = await runTurn({ system: [], messages: [{ role: 'user', content: 'hola' }], ejecutarHerramienta: async () => ({}), complete: async (req) => { reqs.push(structuredClone(req)); return cola.shift(); } });
  assert.deepEqual(r.respuesta.mensajes, ['hola!']);
  assert.equal(reqs[0].tool_choice.type, 'auto');
  assert.match(reqs[1].messages.at(-1).content, /responder/);
  await assert.rejects(runTurn({ system: [], messages: [{ role: 'user', content: 'x' }], ejecutarHerramienta: async () => ({}), complete: async () => ({ content: [], stop_reason: 'refusal', stop_details: { category: 'cyber' } }) }), /negado.*cyber/);
});
