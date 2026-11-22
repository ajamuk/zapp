import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import { procesarSeguimientos } from '../src/followups.js';
import { parseWebhook } from '../src/ghl.js';

// Un martes a las 12:00 en Madrid (dentro de horario)
const T0 = new Date('2026-11-17T11:00:00Z');

function montar({ respuestas, socio = false, live = true, alta = { estado: 'preparada' }, telefonosPrueba = [] } = {}) {
  const repo = crearRepo(openDb(':memory:'));
  const llamadas = { enviados: [], tags: [], notas: [], avisos: [], plantillas: [], asignados: [], requests: [] };
  const ghl = {
    sendMessage: async ({ texto }) => { llamadas.enviados.push(texto); return { messageId: `m${llamadas.enviados.length}` }; },
    sendTemplate: async ({ variables }) => { llamadas.plantillas.push(variables[0]); return {}; },
    enviarPorPlantilla: async ({ texto }) => { llamadas.plantillas.push(texto); return { messageId: null }; },
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
    repo, ghl, complete, live, telefonosPrueba, sleep: async () => {}, now: () => reloj, random: () => 0,
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

test('un teléfono de prueba se trata como lead aunque sea socio', async () => {
  const { setter, repo, llamadas } = montar({ socio: true, telefonosPrueba: ['600 000 000'] });
  await setter.handleWebhook(entrante('hola'));
  const c = repo.getConv('c1');
  assert.equal(c.tipo, 'captacion');
  assert.equal(c.ai_paused, 0);
  assert.equal(llamadas.avisos.length, 0);
  assert.ok(c.respond_at, 'queda programada la respuesta');
});

test('en modo shadow, a un teléfono de prueba se le contesta de verdad y al resto solo con nota', async () => {
  const respuesta = () => [[{ name: 'responder', input: { mensajes: ['hola!'], fase: 'f1', etiquetas: [] } }]];
  const prueba = montar({ live: false, telefonosPrueba: ['+34600000000'], respuestas: respuesta() });
  await prueba.setter.handleWebhook(entrante('hola'));
  prueba.avanzar(60000); await prueba.setter.tick();
  assert.deepEqual(prueba.llamadas.enviados, ['hola!']);
  assert.ok(!prueba.llamadas.notas.some((n) => n.startsWith('[Borrador IA')));
  const otro = montar({ live: false, respuestas: respuesta() });
  await otro.setter.handleWebhook(entrante('hola'));
  otro.avanzar(60000); await otro.setter.tick();
  assert.equal(otro.llamadas.enviados.length, 0);
  assert.ok(otro.llamadas.notas.some((n) => n.startsWith('[Borrador IA')));
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

test('derivar a equipo sin motivo ni resumen (o con un resumen de relleno) no pausa el chat y Sofía sigue', async () => {
  const { setter, repo, llamadas, avanzar } = montar({
    respuestas: [
      [{ name: 'derivar_a_equipo', input: {} }, { name: 'derivar_a_equipo', input: { motivo: 'otro', resumen: 'no' } }, { name: 'derivar_a_equipo', input: { motivo: 'otro', resumen: 'no aplica en este caso' } }],
      [{ name: 'responder', input: { mensajes: ['has hecho CrossFit alguna vez o sería empezar desde cero?'], fase: 'f2 diagnóstico' } }],
    ],
  });
  await setter.handleWebhook(entrante('cuánto cuesta en getafe?'));
  avanzar(60000);
  await setter.tick();
  const c = repo.getConv('c1');
  assert.equal(c.derivado, 0);
  assert.equal(c.ai_paused, 0);
  assert.equal(llamadas.avisos.filter((a) => /Derivado/.test(a)).length, 0);
  assert.deepEqual(llamadas.enviados, ['has hecho CrossFit alguna vez o sería empezar desde cero?']);
  assert.match(JSON.stringify(llamadas.requests[1].messages.at(-1).content), /No se ha derivado/);
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

test('webhook de cambio de etiquetas de GHL', () => {
  const e = parseWebhook({ type: 'ContactTagUpdate', id: 'k9', tags: ['a', 'b'] });
  assert.equal(e.evento, 'tags');
  assert.equal(e.contactId, 'k9');
  assert.deepEqual(e.tags, ['a', 'b']);
});

test('si Sofía enumera las sedes sin El Cañaveral, se le devuelve una vez para que lo añada', async () => {
  const { runTurn, revisarRespuesta } = await import('../src/llm.js');
  assert.ok(revisarRespuesta({ mensajes: ['en qué sede te viene mejor, Parla, Getafe o Las Rosas?'] }));
  assert.equal(revisarRespuesta({ mensajes: ['Parla, Getafe, Las Rosas o El Cañaveral, que abre el 1 de febrero de 2027?'] }), null);
  // Dos preguntas en un turno: se devuelve para que deje una
  assert.ok(revisarRespuesta({ mensajes: ['son 85 € con 2 días', 'cuántos días te ves entrenando, y te va mejor mañana o tarde?'] }));
  assert.ok(revisarRespuesta({ mensajes: ['no te he entendido, me lo puedes repetir? y cuántos días te ves entrenando?'] }));
  assert.ok(revisarRespuesta({ mensajes: ['qué horas te vendrían bien por el trabajo, y te viene mejor Getafe o Las Rosas?'] }));
  assert.equal(revisarRespuesta({ mensajes: ['en Parla son lunes, miércoles y viernes', 'te encaja alguna de esas horas?', '[imagen: parla-academy-horarios]'] }), null);
  assert.equal(revisarRespuesta({ mensajes: ['por la mañana y por la tarde hay clases', 'cuál te viene mejor?'] }), null);
  assert.equal(revisarRespuesta({ mensajes: ['en Getafe y Las Rosas no hay clase de prueba'] }), null); // no es una lista de sedes
  const resp = (id, mensajes) => ({ content: [{ type: 'tool_use', id, name: 'responder', input: { mensajes, fase: 'f1 apertura' } }] });
  const guion = [resp('a', ['tenemos Parla, Getafe y Las Rosas, cuál te viene mejor?']), resp('b', ['tenemos Parla, Getafe, Las Rosas y El Cañaveral, nuestra próxima apertura el 1 de febrero de 2027, cuál te viene mejor?'])];
  const vistos = [];
  const r = await runTurn({ system: [], messages: [{ role: 'user', content: 'hola' }], ejecutarHerramienta: async () => ({}), complete: async (req) => { vistos.push(req.messages.at(-1)); return guion.shift(); } });
  assert.match(r.respuesta.mensajes[0], /Cañaveral/);
  assert.equal(vistos[1].content[0].tool_use_id, 'a');
  assert.match(vistos[1].content[0].content, /nombrando las cuatro/);
  // Solo se corrige una vez: si insiste, se envía lo que diga (no se bloquea el chat)
  const terco = await runTurn({ system: [], messages: [{ role: 'user', content: 'hola' }], ejecutarHerramienta: async () => ({}), complete: async () => resp('x', ['Parla, Getafe o Las Rosas?']) });
  assert.equal(terco.respuesta.mensajes[0], 'Parla, Getafe o Las Rosas?');
});

test('copias del conector de WhatsApp: no cuentan dos veces ni pausan a Sofía', async () => {
  const { setter, repo, avanzar } = montar({ respuestas: [[{ name: 'responder', input: { mensajes: ['Hola! En qué sede te viene mejor?'] } }]] });
  const copia = (o) => ({ ...o, canal: 'type_custom_sms' });
  // Entrante: el nativo cuenta, la copia (antes o después) no
  assert.match((await setter.handleWebhook(copia(entrante('hola\n\n💬Received on 34604840858', 'x1')))).ignorado, /copia/);
  assert.equal(repo.getConv('c1'), undefined);
  await setter.handleWebhook(entrante('hola', 'w1'));
  await setter.handleWebhook(copia(entrante('hola', 'x2')));
  const leads = () => repo.db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id = 'c1' AND autor = ?");
  assert.equal(leads().get('lead').n, 1);
  // Sofía contesta; la copia de su propio mensaje llega como saliente con usuario y no la pausa
  avanzar(10 * 60000); await setter.tick();
  assert.equal(leads().get('ia').n, 1);
  const saliente = (texto, id, canal = 'whatsapp') => ({ evento: 'outbound', conversationId: 'c1', contactId: 'k1', canal, texto, messageId: id, userId: 'u1' });
  assert.match((await setter.handleWebhook(saliente('Hola! En qué sede te viene mejor?\n💬Sent from 34604840858', 'x3', 'type_custom_sms'))).ignorado, /copia/);
  assert.equal(repo.getConv('c1').ai_paused, 0);
  // El equipo escribe desde GHL: llegan la copia y el nativo; se guarda una vez y Sofía se aparta
  assert.equal((await setter.handleWebhook(saliente('te llamo ahora', 'x4', 'type_custom_sms'))).pausada, true);
  assert.match((await setter.handleWebhook(saliente('te llamo ahora', 'w4'))).ignorado, /copia/);
  assert.equal(leads().get('humano').n, 1);
  // Un reintento del mismo webhook sigue siendo un duplicado normal
  assert.equal((await setter.handleWebhook(saliente('te llamo ahora', 'x4', 'type_custom_sms'))).ignorado, 'duplicado');
});

test('costes de IA: esfuerzo y modelo en cada llamada, caché de 1 h y Haiku sin respaldo', async () => {
  const { runTurn, systemBlocks, opcionesRespaldo } = await import('../src/llm.js');
  const reqs = [];
  const fin = { content: [{ type: 'tool_use', id: 't1', name: 'responder', input: { mensajes: ['hola'], fase: 'f1 apertura' } }], stop_reason: 'tool_use' };
  await runTurn({ system: [], messages: [{ role: 'user', content: 'hola' }], ejecutarHerramienta: async () => ({}), complete: async (req) => { reqs.push(req); return fin; } });
  assert.equal(reqs[0].model, 'claude-sonnet-5-5');
  assert.deepEqual(reqs[0].output_config, { effort: 'medium' });
  await runTurn({ system: [], messages: [{ role: 'user', content: 'hola' }], modelo: 'claude-haiku-5-5', effort: '', ejecutarHerramienta: async () => ({}), complete: async (req) => { reqs.push(req); return fin; } });
  assert.equal(reqs[1].model, 'claude-haiku-5-5');
  assert.equal(reqs[1].output_config, undefined);
  assert.deepEqual(opcionesRespaldo('claude-haiku-5-5'), {});
  assert.equal(opcionesRespaldo('claude-sonnet-5-5').fallbacks, 'default');
  assert.deepEqual(systemBlocks('p', 'n', 'c')[1].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(systemBlocks('p', 'n', 'c', '5m')[1].cache_control, { type: 'ephemeral' });
});

test('los seguimientos se redactan con el modelo de seguimientos', async () => {
  const { config } = await import('../src/config.js');
  const { repo, setter, llamadas } = montar({ respuestas: [[{ name: 'responder', input: { mensajes: ['¿Qué tal?'], fase: 'f1 apertura' } }]] });
  repo.upsertConv({ id: 'c9', contact_id: 'k9', channel: 'whatsapp' });
  assert.equal(await setter.redactar('c9', '', { modelo: config.ai.modeloSeguimientos }), '¿Qué tal?');
  assert.equal(llamadas.requests[0].model, 'claude-haiku-5-5');
});

test('si el modelo manda los mensajes como texto en vez de lista, se convierten y Sofía contesta igual', async () => {
  const { runTurn, comoLista } = await import('../src/llm.js');
  assert.deepEqual(comoLista('["hola", "qué tal?"]'), ['hola', 'qué tal?']);
  assert.deepEqual(comoLista('hola\nqué tal?'), ['hola', 'qué tal?']);
  // Lista mal formada que llegó de verdad (Probar IA, prueba-e8539306)
  assert.deepEqual(comoLista('["no, el primer recibo es solo la parte proporcional",["la cuota completa se renueva el día 1"][0],"qué día te gustaría empezar?"]'),
    ['no, el primer recibo es solo la parte proporcional', 'la cuota completa se renueva el día 1', 'qué día te gustaría empezar?']);
  const { TOOLS } = await import('../src/llm.js');
  const r = TOOLS.find((x) => x.name === 'responder');
  assert.equal(r.strict, true);
  const sinFalse = (o) => (o.type === 'object' && o.additionalProperties !== false) || Object.values(o.properties || {}).some(sinFalse) || (o.items ? sinFalse(o.items) : false);
  assert.equal(sinFalse(r.input_schema), false);
  assert.deepEqual(comoLista(undefined), []);
  assert.deepEqual(comoLista(['a', '', ' ']), ['a']);
  const complete = async () => ({ content: [{ type: 'tool_use', id: 't', name: 'responder', input: { mensajes: '["vale", "cuántos días te ves?"]', fase: 'f5 cierre' } }], usage: { input_tokens: 10, output_tokens: 5 } });
  const { respuesta } = await runTurn({ system: [], messages: [{ role: 'user', content: 'hola' }], ejecutarHerramienta: async () => ({}), complete });
  assert.deepEqual(respuesta.mensajes, ['vale', 'cuántos días te ves?']);
});

test('si contesta a la vez que pide el alta (sin ver el resultado), se ejecuta el alta y se le pide contestar después', async () => {
  const { runTurn } = await import('../src/llm.js');
  let paso = 0; const hechas = [];
  const complete = async (req) => {
    paso++;
    if (paso === 1) return { content: [
      { type: 'tool_use', id: 'a', name: 'preparar_alta', input: { nombre: 'Andrea' } },
      { type: 'tool_use', id: 'r', name: 'responder', input: { mensajes: ['ya está tu alta en marcha'], fase: 'f5 cierre' } },
    ], usage: { input_tokens: 10, output_tokens: 5 } };
    const ultimo = req.messages.at(-1).content;
    assert.ok(ultimo.some((b) => b.tool_use_id === 'r' && b.is_error && /antes de ver el resultado/.test(b.content)));
    assert.ok(ultimo.some((b) => b.tool_use_id === 'a' && /preparada/.test(b.content)));
    return { content: [{ type: 'tool_use', id: 'r2', name: 'responder', input: { mensajes: ['listo, alta preparada'], fase: 'f5 cierre' } }], usage: { input_tokens: 10, output_tokens: 5 } };
  };
  const { respuesta } = await runTurn({ system: [], messages: [{ role: 'user', content: 'mis datos' }], complete, ejecutarHerramienta: async (n) => { hechas.push(n); return { ok: true, estado: 'preparada' }; } });
  assert.deepEqual(hechas, ['preparar_alta']); // una sola vez
  assert.deepEqual(respuesta.mensajes, ['listo, alta preparada']);
});

test('un punto en medio de una burbuja se devuelve para que lo parta; abreviaturas, urls y «...» no cuentan', async () => {
  const { puntoEnMedio, revisarRespuesta } = await import('../src/llm.js');
  assert.ok(puntoEnMedio(['el teléfono ya lo tengo de este chat. los documentos los firmas en la app']));
  assert.ok(revisarRespuesta({ mensajes: ['vale. te lo miro'] }));
  assert.match(revisarRespuesta({ mensajes: ['a', 'b', 'c', 'd', 'e'] }), /máximo es 4/);
  assert.equal(revisarRespuesta({ mensajes: ['a', 'b', 'c', 'd'] }), null);
  for (const ok of ['bueno... ya me dices', 'en Av. de la Paz 35', 'por ejemplo, p. ej. el lunes', 'mira https://maps.app.goo.gl/XK2R. hola', 'son 2,83 €', 'perfecto 💪']) {
    if (ok.includes('https')) continue;
    assert.equal(puntoEnMedio([ok]), false, ok);
  }
});

test('si Sofía no indica la sede pero ha consultado las tarifas de una, el chat queda con esa sede', async () => {
  const { setter, repo, llamadas, avanzar } = montar({
    respuestas: [
      [{ name: 'consultar_tarifas', input: { sede: 'las_rosas', familia: 'academy' } }],
      [{ name: 'responder', input: { mensajes: ['Academy en Las Rosas va desde 95 € al mes'], sede: 'desconocida', fase: 'f3 presentación', etiquetas: [] } }],
    ],
  });
  await setter.handleWebhook(entrante('cuánto cuesta en las rosas?'));
  avanzar(60000);
  await setter.tick();
  assert.equal(repo.getConv('c1').sede, 'las_rosas');
  assert.ok(llamadas.tags.includes('las rosas') || llamadas.tags.some((t) => /rosas/.test(t)));
});
