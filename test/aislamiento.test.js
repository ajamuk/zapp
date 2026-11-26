// Aislamiento de Sofía en un número de WhatsApp propio. Todo con datos sintéticos: ningún teléfono ni id es real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import { Ghl } from '../src/ghl.js';
import { Etiquetador, crear as crearEtiqueta } from '../src/etiquetas.js';
import { procesarSeguimientos, programarManual } from '../src/followups.js';
import { estadoAislamiento, evaluarEntrante, chatPermitido, cuarentena, enmascarar, lineaDe, esDeOtraLinea, salienteVerificado } from '../src/aislamiento.js';

const PROPIO = '+34910000001';   // número propio de Sofía (inventado)
const OTRO = '+34910000002';     // otro número de la misma empresa (inventado)
const LEAD = '+34600000000';     // teléfono del contacto (inventado)
const LOC = 'locSofia'; const OTRA_LOC = 'locOtra';
const AISL = estadoAislamiento({ numero: PROPIO, locationId: LOC, locationCliente: LOC });
// Formato con el que la API de GHL devuelve el número de la empresa en `to` (entrantes) y `from` (salientes)
const PROPIO_GHL = '+34 910 00 00 01'; const OTRO_GHL = '+34 910 00 00 02';
const saliente = (id, extra = {}) => deGhl(id, { direccion: 'outbound', para: LEAD, de: PROPIO_GHL, texto: 'te escribe una persona del equipo', userId: 'u1', fecha: new Date(T0.getTime() + 90000).toISOString(), ...extra });
const T0 = new Date('2026-11-17T11:00:00Z'); // martes 12:00 en Madrid

/** Mensaje tal como lo devuelve la API de GHL, ya normalizado por Ghl.mensajes(). */
const deGhl = (id, extra = {}) => ({
  id, direccion: 'inbound', tipo: 'TYPE_WHATSAPP', canal: 'whatsapp', texto: 'hola, precio?', adjuntos: [], userId: null, source: null,
  fecha: T0.toISOString(), locationId: LOC, conversationId: 'c1', contactId: 'k1', para: PROPIO, ...extra,
});

function montar({ aislamiento = AISL, live = true, lista = [], sueltos = null, telefonosPrueba = [], respuestas = [['hola, te cuento']] } = {}) {
  const repo = crearRepo(openDb(':memory:'));
  // Todo lo que tocaría GHL, AimHarder o al equipo queda apuntado: en un descartado tiene que quedar vacío
  const sal = { enviados: [], plantillas: [], notas: [], tags: [], asignados: [], contactos: [], socios: [], avisos: [], modelo: 0 };
  let reloj = new Date(T0);
  const cola = [...respuestas];
  const ghl = {
    sendMessage: async ({ texto, canal }) => { sal.enviados.push({ texto, canal }); return { messageId: `s${sal.enviados.length}` }; },
    enviarAdjunto: async (x) => { sal.enviados.push(x); return { messageId: 'a1' }; },
    enviarPorPlantilla: async (x) => { sal.plantillas.push(x); return { messageId: null }; },
    addTags: async (_, t) => { sal.tags.push(...t); }, removeTags: async () => {}, assign: async (c) => { sal.asignados.push(c); },
    addNote: async (_, n) => { sal.notas.push(n); }, getContact: async (c) => { sal.contactos.push(c); return { contact: {} }; },
    mensajes: async () => (typeof lista === 'function' ? lista() : lista),
    ...(sueltos ? { mensaje: async (id) => sueltos[id] || null } : {}),
  };
  const setter = new Setter({
    repo, ghl, live, telefonosPrueba, aislamiento, sleep: async () => {}, now: () => reloj, random: () => 0, avisar: async (t) => sal.avisos.push(t),
    aimharder: { buscarSocioPorTelefono: async (t) => { sal.socios.push(t); return { esSocio: false }; }, prepararAlta: async () => ({ estado: 'simulada' }) },
    complete: async () => {
      sal.modelo++;
      const m = cola.shift();
      if (!m) throw new Error('sin respuesta preparada');
      return { content: [{ type: 'tool_use', id: 't', name: 'responder', input: { fase: 'f2 diagnóstico', sede: 'desconocida', mensajes: m } }], usage: { input_tokens: 1, output_tokens: 1 } };
    },
  });
  setter.repasosAislamiento = [];
  return { repo, setter, sal, avanzar: (ms) => { reloj = new Date(reloj.getTime() + ms); } };
}
/** Aviso del workflow de GHL: sin id de mensaje, con el teléfono DEL CONTACTO (que no dice a qué número escribió). */
const aviso = (extra = {}) => ({ evento: 'inbound', contactId: 'k1', conversationId: 'c1', canal: 'desconocido', texto: 'hola, precio?', messageId: null, telefono: LEAD, nombre: 'Lead Sintético', tags: [], ...extra });
const sinEfectos = (sal) => assert.deepEqual(
  [sal.enviados, sal.plantillas, sal.notas, sal.tags, sal.asignados, sal.contactos, sal.socios, sal.avisos, sal.modelo],
  [[], [], [], [], [], [], [], [], 0], 'no se toca nada del contacto descartado');
const chats = (repo) => repo.db.prepare('SELECT count(*) n FROM conversations').get().n;

// ---------- Configuración ----------

test('configuración: sin variables no hay aislamiento; a medias o incoherente queda inválida', () => {
  assert.equal(estadoAislamiento({ numero: '', locationId: '', locationCliente: LOC }).modo, 'apagado');
  assert.deepEqual([AISL.modo, AISL.digitos, AISL.clave], ['activo', '34910000001', `${LOC}:34910000001`]);
  const mal = (n, l, c = LOC) => estadoAislamiento({ numero: n, locationId: l, locationCliente: c });
  assert.equal(mal(PROPIO, '').modo, 'invalido', 'número sin subcuenta');
  assert.equal(mal('', LOC).modo, 'invalido', 'subcuenta sin número');
  assert.equal(mal('910000001', LOC).modo, 'invalido', 'sin prefijo internacional');
  assert.equal(mal('+34 910 000 001', LOC).modo, 'invalido', 'con espacios');
  assert.equal(mal(PROPIO, LOC, OTRA_LOC).modo, 'invalido', 'el token apunta a otra subcuenta');
  assert.equal(enmascarar(PROPIO), '…0001');
});

// ---------- Prueba de cada entrante ----------

test('evidencia: solo vale un WhatsApp entrante de la subcuenta propia dirigido al número propio', () => {
  const ev = (extra) => evaluarEntrante(AISL, deGhl('m1', extra), { conversationId: 'c1', contactId: 'k1' });
  assert.deepEqual(ev({}), { ok: true });
  assert.deepEqual(ev({ para: [PROPIO] }), { ok: true }, '`to` como lista de uno');
  assert.deepEqual(ev({ para: '+34 910 000 001' }), { ok: true }, 'mismo número con otro formato');
  const motivo = (extra) => ev(extra).motivo;
  assert.equal(motivo({ para: OTRO }), 'dirigido a otro número');
  assert.equal(motivo({ para: '910000001' }), 'dirigido a otro número', 'sin prefijo de país no es el mismo número');
  assert.equal(motivo({ para: [PROPIO, OTRO] }), 'dirigido a otro número');
  assert.equal(motivo({ para: LEAD }), 'dirigido a otro número', 'el teléfono del contacto no es el destino');
  assert.equal(motivo({ para: null }), 'GHL no indica a qué número se envió');
  assert.equal(motivo({ para: '' }), 'GHL no indica a qué número se envió');
  assert.equal(motivo({ locationId: OTRA_LOC }), 'mensaje de otra subcuenta');
  assert.equal(motivo({ locationId: null }), 'GHL no indica la subcuenta del mensaje');
  assert.equal(motivo({ tipo: 'TYPE_SMS' }), 'no es WhatsApp');
  assert.equal(motivo({ tipo: 'TYPE_INSTAGRAM' }), 'no es WhatsApp');
  assert.equal(motivo({ tipo: 'TYPE_ACTIVITY_WHATSAPP' }), 'no es WhatsApp');
  assert.equal(motivo({ tipo: '' }), 'no es WhatsApp');
  assert.equal(motivo({ direccion: 'outbound' }), 'no es un mensaje entrante');
  assert.equal(motivo({ conversationId: 'c9' }), 'el mensaje es de otra conversación');
  assert.equal(motivo({ contactId: 'k9' }), 'el mensaje es de otro contacto');
  assert.equal(evaluarEntrante(AISL, null).ok, false);
  assert.equal(evaluarEntrante({ modo: 'invalido' }, deGhl('m1')).ok, false);
});

// ---------- Entrada ----------

test('entrante al número propio: se atiende y el chat queda verificado', async () => {
  const { repo, setter, sal, avanzar } = montar({ lista: [deGhl('m1')] });
  const r = await setter.handleWebhook(aviso());
  assert.equal(r.visto, true);
  const c = repo.getConv('c1');
  assert.deepEqual([c.channel, c.aislado_num], ['whatsapp', AISL.clave]);
  avanzar(60000); await setter.tick();
  assert.deepEqual(sal.enviados, [{ texto: 'hola, te cuento', canal: 'whatsapp' }]);
});

test('entrante a OTRO número de la misma subcuenta: no se crea chat ni se toca el contacto', async () => {
  const { repo, setter, sal, avanzar } = montar({ lista: [deGhl('m1', { para: OTRO })] });
  await setter.handleWebhook(aviso());
  avanzar(60000); await setter.tick();
  assert.equal(chats(repo), 0);
  sinEfectos(sal);
});

test('el teléfono del contacto y lo que diga el webhook no cuentan como destino', async () => {
  // El aviso «dice» que es WhatsApp y trae como teléfono el número propio; GHL dice que se escribió a otro número
  const { repo, setter, sal } = montar({ lista: [deGhl('m1', { para: OTRO })] });
  await setter.handleWebhook(aviso({ canal: 'whatsapp', telefono: PROPIO }));
  assert.equal(chats(repo), 0);
  sinEfectos(sal);
});

test('datos incompletos: sin destinatario o sin subcuenta se descarta (falla en cerrado)', async () => {
  for (const falta of [{ para: null }, { locationId: null }, { tipo: '' }, { para: null, locationId: null }]) {
    const { repo, setter, sal, avanzar } = montar({ lista: [deGhl('m1', falta)], sueltos: { m1: deGhl('m1', falta) } });
    await setter.handleWebhook(aviso());
    avanzar(60000); await setter.tick();
    assert.equal(chats(repo), 0, JSON.stringify(falta));
    sinEfectos(sal);
  }
});

test('la lista de la conversación no trae el destinatario pero el mensaje por su id sí: vale', async () => {
  const { repo, setter } = montar({ lista: [deGhl('m1', { para: null, locationId: null })], sueltos: { m1: deGhl('m1') } });
  await setter.handleWebhook(aviso());
  assert.equal(repo.getConv('c1')?.aislado_num, AISL.clave);
});

test('GHL todavía no lista el mensaje: no entra «tal como vino»; entra al repasar si resulta ser del número propio', async () => {
  let lista = [];
  const { repo, setter, sal } = montar({ lista: () => lista });
  setter.repasosAislamiento = [5];
  const r = await setter.handleWebhook(aviso());
  assert.match(r.ignorado, /aislamiento/);
  assert.equal(chats(repo), 0);
  sinEfectos(sal);
  lista = [deGhl('m1')];
  await new Promise((ok) => setTimeout(ok, 40));
  assert.equal(repo.getConv('c1')?.aislado_num, AISL.clave);
});

test('aviso con id de mensaje (evento de la app): tampoco basta; se comprueba en la conversación de GHL', async () => {
  const evento = (id) => ({ evento: 'inbound', contactId: 'k1', conversationId: 'c1', canal: 'whatsapp', texto: 'hola, precio?', messageId: id, telefono: LEAD });
  const malos = { otroNumero: { para: OTRO }, otroChat: { conversationId: 'c9', contactId: 'k9' }, otraLoc: { locationId: OTRA_LOC } };
  for (const [id, extra] of Object.entries(malos)) {
    const { repo, setter, sal } = montar({ lista: [deGhl(id, extra)], sueltos: { [id]: deGhl(id, extra) } });
    const r = await setter.handleWebhook(evento(id));
    assert.ok(r.compartida || r.visto, id);
    assert.equal(chats(repo), 0, id);
    sinEfectos(sal);
  }
  // El id existe y es bueno, pero GHL no lo lista en la conversación: no entra por el aviso
  const a = montar({ lista: [], sueltos: { bueno: deGhl('bueno') } });
  assert.match((await a.setter.handleWebhook(evento('bueno'))).ignorado, /^aislamiento/);
  assert.equal(chats(a.repo), 0);
  const b = montar({ lista: [deGhl('bueno')] });
  await b.setter.handleWebhook(evento('bueno'));
  assert.equal(b.repo.getConv('c1').aislado_num, AISL.clave);
});

test('sin poder leer el mensaje en GHL (cliente sin esa consulta o GHL caído) no entra nada', async () => {
  const { repo, setter, sal } = montar({});
  delete setter.ghl.mensajes;
  await setter.handleWebhook({ evento: 'inbound', contactId: 'k1', conversationId: 'c1', canal: 'whatsapp', texto: 'hola', messageId: 'm1', telefono: LEAD });
  assert.equal(chats(repo), 0);
  sinEfectos(sal);
});

test('Instagram no entra con el aislamiento activo', async () => {
  const { repo, setter, sal } = montar({ lista: [deGhl('m1', { tipo: 'TYPE_INSTAGRAM', canal: 'instagram', para: null })] });
  await setter.handleWebhook(aviso());
  assert.equal(chats(repo), 0);
  sinEfectos(sal);
});

test('en un chat verificado, un mensaje posterior a otro número no entra en la conversación (y el chat queda bloqueado)', async () => {
  let lista = [deGhl('m1')];
  const { repo, setter, sal, avanzar } = montar({ lista: () => lista });
  await setter.handleWebhook(aviso());
  avanzar(60000); await setter.tick();
  lista = [...lista, deGhl('m2', { para: OTRO, texto: 'esto iba para el otro número', fecha: new Date(T0.getTime() + 120000).toISOString() })];
  avanzar(60000);
  await setter.handleWebhook(aviso({ texto: 'esto iba para el otro número' }));
  avanzar(60000); await setter.tick();
  assert.equal(repo.history('c1').filter((m) => m.autor === 'lead').length, 1);
  assert.equal(sal.enviados.length, 1, 'no se contesta al mensaje del otro número');
  assert.equal(repo.getConv('c1').ai_paused, 0, 'no cuenta como que haya escrito nadie');
});

test('configuración inválida: no entra nada', async () => {
  const { repo, setter, sal } = montar({ aislamiento: estadoAislamiento({ numero: PROPIO, locationId: '', locationCliente: LOC }), lista: [deGhl('m1')] });
  assert.match((await setter.handleWebhook(aviso())).ignorado, /mal configurado/);
  assert.equal(chats(repo), 0);
  sinEfectos(sal);
});

test('modo prueba con aislamiento: borrador solo para el número propio; un teléfono de prueba que escribe a otro número no recibe nada', async () => {
  const a = montar({ live: false, lista: [deGhl('m1')] });
  await a.setter.handleWebhook(aviso());
  a.avanzar(60000); await a.setter.tick();
  assert.equal(a.sal.enviados.length, 0);
  assert.match(a.sal.notas[0], /Borrador IA, no enviado/);
  const b = montar({ live: false, telefonosPrueba: [LEAD], lista: [deGhl('m1', { para: OTRO })] });
  await b.setter.handleWebhook(aviso());
  b.avanzar(60000); await b.setter.tick();
  sinEfectos(b.sal);
});

test('sin aislamiento configurado, todo sigue como antes (entra aunque GHL no diga a qué número)', async () => {
  const { repo, setter, sal, avanzar } = montar({ aislamiento: null, lista: [deGhl('m1', { para: null, locationId: null })] });
  await setter.handleWebhook(aviso());
  avanzar(60000); await setter.tick();
  assert.equal(repo.getConv('c1').aislado_num, null);
  assert.equal(sal.enviados.length, 1);
});

// ---------- Cola histórica de otro número ----------

/** Chat de antes del aislamiento, con respuesta pendiente y un seguimiento y un mensaje manual vencidos. */
function heredado(m) {
  const { repo } = m;
  repo.upsertConv({ id: 'viejo', contact_id: 'kv', channel: 'whatsapp', nombre: 'Lead Antiguo', telefono: LEAD });
  repo.addMessage({ conversation_id: 'viejo', external_id: 'v1', autor: 'lead', texto: 'hola' });
  repo.updateConv('viejo', { last_inbound_at: T0.toISOString(), respond_at: T0.toISOString(), tipo: 'captacion' });
  repo.schedule('viejo', 'comercial-5h', T0.toISOString(), null, 'silencio');
  programarManual(repo, 'viejo', 'mensaje escrito a mano antes del cambio', T0.toISOString(), T0);
}
const pendientes = (repo) => repo.db.prepare("SELECT count(*) n FROM scheduled WHERE estado = 'pendiente'").get().n;

test('cola histórica: ni respuestas ni seguimientos (tampoco los manuales) salen a chats no verificados', async () => {
  const m = montar({});
  heredado(m);
  assert.equal(chatPermitido(AISL, m.repo.getConv('viejo')), false);
  m.avanzar(60000);
  await m.setter.tick();
  await procesarSeguimientos(m.setter);
  sinEfectos(m.sal);
  assert.equal(m.repo.getConv('viejo').respond_at, null);
  assert.equal(pendientes(m.repo), 0);
  assert.deepEqual(m.repo.db.prepare('SELECT DISTINCT estado, detalle FROM scheduled').all(), [{ estado: 'omitido', detalle: 'aislamiento: chat no verificado para el número propio' }]);
  // Tampoco por los atajos del panel
  assert.equal(await m.setter.responder('viejo'), null);
  await assert.rejects(() => m.setter.enviar(m.repo.getConv('viejo'), ['hola']), /Aislamiento/);
  await assert.rejects(() => m.setter.enviarRecursos(m.repo.getConv('viejo'), [{ id: 1, nombre: 'x', tipo: 'imagen' }]), /Aislamiento/);
  assert.match(await m.setter.contestarPregunta({ conversation_id: 'viejo' }), /aislamiento/);
  sinEfectos(m.sal);
});

test('cuarentena al arrancar: cancela la cola de los chats no verificados y respeta la de los verificados', async () => {
  const m = montar({ lista: [deGhl('m1')] });
  heredado(m);
  await m.setter.handleWebhook(aviso());
  m.repo.schedule('c1', 'comercial-5h', T0.toISOString(), null, 'silencio');
  assert.deepEqual(cuarentena(m.repo.db, AISL), { respuestas: 1, seguimientos: 2 });
  assert.deepEqual(cuarentena(m.repo.db, AISL), { respuestas: 0, seguimientos: 0 }, 'repetirla no cambia nada');
  assert.equal(m.repo.getConv('viejo').respond_at, null);
  assert.ok(m.repo.getConv('c1').respond_at, 'el chat verificado conserva su respuesta');
  assert.deepEqual(m.repo.db.prepare("SELECT conversation_id FROM scheduled WHERE estado = 'pendiente'").all(), [{ conversation_id: 'c1' }]);
  assert.deepEqual(cuarentena(m.repo.db, { modo: 'apagado' }), { respuestas: 0, seguimientos: 0 });
  // Si se cambia de número, lo verificado para el anterior deja de valer
  const otro = estadoAislamiento({ numero: OTRO, locationId: LOC, locationCliente: LOC });
  assert.equal(chatPermitido(otro, m.repo.getConv('c1')), false);
  assert.deepEqual(cuarentena(m.repo.db, otro), { respuestas: 1, seguimientos: 1 });
});

test('chat heredado: un mensaje del equipo o una etiqueta no provocan nada en GHL', async () => {
  const m = montar({});
  heredado(m);
  const etiquetas = new Etiquetador({ repo: m.repo, ghl: m.setter.ghl, avisar: async (t) => m.sal.avisos.push(t), permitido: (c) => m.setter.permitido(c) });
  const e = crearEtiqueta(m.repo.db, { nombre: 'Interesado' });
  assert.deepEqual(await etiquetas.poner('viejo', e.id, 'manual'), { puesta: false, motivo: 'aislamiento: chat de otro número' });
  assert.deepEqual(await etiquetas.sincronizarContacto('kv', ['interesado']), { puestas: 0, quitadas: 0, subidas: 0 });
  assert.match((await m.setter.onOutbound({ conversationId: 'viejo', texto: 'te escribe el equipo', userId: 'u1', messageId: 'o1' })).ignorado, /aislamiento/);
  m.sal.modelo = 0;
  sinEfectos(m.sal);
});

// ---------- Salida ----------

test('fuera de las 24 h (plantilla): no sale, porque su número emisor no se puede fijar', async () => {
  const m = montar({ lista: [deGhl('m1')] });
  await m.setter.handleWebhook(aviso());
  m.avanzar(60000); await m.setter.tick();
  m.repo.db.prepare("UPDATE scheduled SET estado = 'cancelado'").run();
  m.avanzar(30 * 3600e3);
  programarManual(m.repo, 'c1', 'te escribo más tarde', new Date(T0.getTime() + 30 * 3600e3).toISOString(), T0);
  m.avanzar(4 * 3600e3); // dentro del horario de Sofía
  await procesarSeguimientos(m.setter);
  assert.deepEqual(m.sal.plantillas, []);
  assert.equal(m.sal.enviados.length, 1, 'solo la respuesta del principio');
  assert.match(m.repo.db.prepare("SELECT detalle FROM scheduled WHERE tipo = 'manual'").get().detalle, /aislamiento.*plantilla/);
  await assert.rejects(() => m.setter.enviar(m.repo.getConv('c1'), ['x'], {}), /plantilla/);
});

/** Cliente real de GHL con la red sustituida: se mira exactamente qué saldría hacia GHL. */
function clienteGhl(aislamiento) {
  const peticiones = [];
  const ghl = new Ghl({ token: 't', baseUrl: 'https://ghl.invalid', aislamiento,
    fetchImpl: async (url, o) => { peticiones.push({ url, method: o.method, body: o.body ? JSON.parse(o.body) : null }); return { ok: true, status: 200, text: async () => '{"messageId":"x"}' }; } });
  return { ghl, peticiones };
}

test('cliente de GHL: con aislamiento, todo envío lleva el número propio como emisor', async () => {
  const { ghl, peticiones } = clienteGhl(AISL);
  await ghl.sendMessage({ contactId: 'k1', canal: 'whatsapp', texto: 'hola' });
  await ghl.enviarAdjunto({ contactId: 'k1', canal: 'whatsapp', url: 'https://ejemplo.invalid/a.png', texto: 'pie' });
  assert.deepEqual(peticiones.map((p) => p.body), [
    { type: 'WhatsApp', contactId: 'k1', message: 'hola', fromNumber: PROPIO },
    { type: 'WhatsApp', contactId: 'k1', attachments: ['https://ejemplo.invalid/a.png'], message: 'pie', fromNumber: PROPIO },
  ]);
});

test('cliente de GHL: por WhatsApp el archivo va en whatsapp.media (con attachments a secas solo llega el texto)', async () => {
  const { ghl, peticiones } = clienteGhl(AISL);
  await ghl.enviarAdjunto({ contactId: 'k1', canal: 'whatsapp', url: 'https://ejemplo.invalid/r/abc.mp4', texto: 'pie', mime: 'video/mp4', nombre: 'clase.mp4' });
  await ghl.enviarAdjunto({ contactId: 'k1', canal: 'whatsapp', url: 'https://ejemplo.invalid/r/abc.pdf', mime: 'application/pdf' });
  assert.deepEqual(peticiones.map((p) => p.body), [
    { type: 'WhatsApp', contactId: 'k1', message: 'pie', fromNumber: PROPIO,
      whatsapp: { type: 'media', media: { url: 'https://ejemplo.invalid/r/abc.mp4', type: 'video', name: 'clase.mp4', mimeType: 'video/mp4', caption: 'pie' } } },
    { type: 'WhatsApp', contactId: 'k1', fromNumber: PROPIO,
      whatsapp: { type: 'media', media: { url: 'https://ejemplo.invalid/r/abc.pdf', type: 'document', name: 'abc.pdf', mimeType: 'application/pdf' } } },
  ]);
});

test('cliente de GHL: con aislamiento no sale nada por Instagram, Messenger ni por plantilla (ni se toca el contacto)', async () => {
  const { ghl, peticiones } = clienteGhl(AISL);
  assert.throws(() => ghl.sendMessage({ contactId: 'k1', canal: 'instagram', texto: 'hola' }), /solo se envía por WhatsApp/);
  assert.throws(() => ghl.enviarAdjunto({ contactId: 'k1', canal: 'messenger', url: 'https://ejemplo.invalid/a.png' }), /solo se envía por WhatsApp/);
  await assert.rejects(() => ghl.enviarPorPlantilla({ contactId: 'k1', texto: 'hola' }), /plantilla/);
  await assert.rejects(() => ghl.sendTemplate({ contactId: 'k1', variables: ['hola'] }), /plantilla/);
  assert.deepEqual(peticiones, [], 'ni el campo de la plantilla ni la etiqueta que dispara el workflow');
});

test('cliente de GHL: configuración inválida no envía; sin aislamiento, el envío es idéntico al de antes', async () => {
  const mal = clienteGhl(estadoAislamiento({ numero: PROPIO, locationId: LOC, locationCliente: OTRA_LOC }));
  assert.throws(() => mal.ghl.sendMessage({ contactId: 'k1', canal: 'whatsapp', texto: 'hola' }), /mal configurado/);
  await assert.rejects(() => mal.ghl.enviarPorPlantilla({ contactId: 'k1', texto: 'hola' }), /plantilla/);
  assert.deepEqual(mal.peticiones, []);
  const sin = clienteGhl({ modo: 'apagado' });
  await sin.ghl.sendMessage({ contactId: 'k1', canal: 'whatsapp', texto: 'hola' });
  await sin.ghl.sendMessage({ contactId: 'k1', canal: 'instagram', texto: 'hola' });
  assert.deepEqual(sin.peticiones.map((p) => p.body), [{ type: 'WhatsApp', contactId: 'k1', message: 'hola' }, { type: 'IG', contactId: 'k1', message: 'hola' }]);
});

test('cliente de GHL: lee de la API la subcuenta y el destinatario de cada mensaje', async () => {
  const crudo = { id: 'm1', direction: 'inbound', messageType: 'TYPE_WHATSAPP', body: 'hola', dateAdded: T0.toISOString(), locationId: LOC, conversationId: 'c1', contactId: 'k1', to: PROPIO };
  const ghl = new Ghl({ token: 't', baseUrl: 'https://ghl.invalid', aislamiento: AISL,
    fetchImpl: async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify(url.includes('/conversations/messages/') ? { message: url.endsWith('/m1') ? crudo : { ...crudo, id: 'otro' } } : { messages: { messages: [crudo, { ...crudo, id: 'm2', to: undefined }] } }) }) });
  const [a, b] = await ghl.mensajes('c1');
  assert.deepEqual([a.locationId, a.para, a.conversationId, a.contactId, b.para], [LOC, PROPIO, 'c1', 'k1', null]);
  assert.deepEqual(evaluarEntrante(AISL, await ghl.mensaje('m1')), { ok: true });
  assert.equal(await ghl.mensaje('m9'), null, 'GHL devuelve otro mensaje: no vale');
});

test('el servicio real arranca con el aislamiento de la configuración en el cliente de GHL, en Sofía y en las etiquetas', async () => {
  const { readFileSync } = await import('node:fs');
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(index, /new Ghl\(\{ aislamiento \}\)/);
  assert.match(index, /new Setter\(\{[^}]*\baislamiento\b[^}]*\}\)/);
  assert.match(index, /permitido: \(conv\) => chatPermitido\(aislamiento, conv\)/);
  assert.match(index, /cuarentena\(repo\.db, aislamiento\)/);
  // Y aunque alguien cree el cliente sin pasárselo, toma el de la configuración (aquí, sin configurar)
  assert.equal(new Ghl({ token: 't' }).aislamiento.modo, 'apagado');
});

// ---------- Formato real de GHL («+34 910 00 00 01») ----------

test('formato real de GHL con espacios: `to` del entrante y `from` del saliente se comparan por sus cifras', () => {
  assert.deepEqual(evaluarEntrante(AISL, deGhl('m1', { para: PROPIO_GHL })), { ok: true });
  assert.deepEqual(evaluarEntrante(AISL, deGhl('m1', { para: [PROPIO_GHL] })), { ok: true });
  assert.equal(evaluarEntrante(AISL, deGhl('m1', { para: OTRO_GHL })).motivo, 'dirigido a otro número');
  assert.equal(evaluarEntrante(AISL, deGhl('m1', { para: '+34 910 00 00 0' })).motivo, 'dirigido a otro número', 'una cifra menos');
  assert.equal(evaluarEntrante(AISL, deGhl('m1', { para: '+34 910 00 00 011' })).motivo, 'dirigido a otro número', 'una cifra más');
  assert.equal(evaluarEntrante(AISL, deGhl('m1', { para: '+3 49 10 00 00 01' })).ok, true, 'los espacios no importan; las cifras, todas');
  assert.equal(lineaDe(deGhl('m1', { para: PROPIO_GHL })), '34910000001');
  assert.equal(lineaDe(saliente('o1')), '34910000001');
  assert.equal(lineaDe(saliente('o1', { de: null })), null);
  assert.equal(lineaDe(saliente('o1', { tipo: 'TYPE_CUSTOM_SMS' })), null, 'la copia de un conector no dice su línea');
  assert.equal(salienteVerificado(AISL, saliente('o1')), true);
  assert.equal(salienteVerificado(AISL, saliente('o1', { de: OTRO_GHL })), false);
  assert.equal(salienteVerificado(AISL, saliente('o1', { de: null })), false);
  assert.equal(salienteVerificado(AISL, saliente('o1', { locationId: OTRA_LOC })), false);
  // En un saliente, `to` es el contacto: aunque coincidiera con el número propio no demuestra nada
  assert.equal(salienteVerificado(AISL, saliente('o1', { de: null, para: PROPIO_GHL })), false);
  assert.deepEqual([esDeOtraLinea(AISL, deGhl('m1', { para: OTRO_GHL })), esDeOtraLinea(AISL, saliente('o1', { de: OTRO_GHL })), esDeOtraLinea(AISL, saliente('o1')), esDeOtraLinea(AISL, saliente('o1', { de: null }))], [true, true, false, false]);
});

test('formato real: un entrante con `to` «+34 910 00 00 01» se atiende, y el cliente de GHL lee `from` de los salientes', async () => {
  const { repo, setter, sal, avanzar } = montar({ lista: [deGhl('m1', { para: PROPIO_GHL })] });
  await setter.handleWebhook(aviso());
  avanzar(60000); await setter.tick();
  assert.equal(repo.getConv('c1').aislado_num, AISL.clave);
  assert.equal(sal.enviados.length, 1);
  const crudo = { id: 'o1', direction: 'outbound', messageType: 'TYPE_WHATSAPP', body: 'hola', dateAdded: T0.toISOString(), locationId: LOC, conversationId: 'c1', contactId: 'k1', from: PROPIO_GHL, to: '+34 600 00 00 00' };
  const ghl = new Ghl({ token: 't', baseUrl: 'https://ghl.invalid', aislamiento: AISL, fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ messages: { messages: [crudo] } }) }) });
  const [m] = await ghl.mensajes('c1');
  assert.deepEqual([m.de, salienteVerificado(AISL, m)], [PROPIO_GHL, true]);
});

// ---------- Conversación de GHL compartida por más de una línea de WhatsApp ----------

/** Chat propio ya atendido una vez (un entrante verificado y una respuesta de Sofía). */
async function chatPropio(opciones = {}) {
  let lista = [deGhl('m1', { para: PROPIO_GHL })];
  const m = montar({ lista: () => lista, respuestas: [['hola, te cuento'], ['segunda respuesta']], ...opciones });
  await m.setter.handleWebhook(aviso());
  m.avanzar(60000); await m.setter.tick();
  assert.equal(m.sal.enviados.length, 1);
  return { ...m, anadir: (...x) => { lista = [...lista, ...x]; } };
}
const estado = (repo) => { const c = repo.getConv('c1'); return [c.ai_paused, c.aislado_bloqueo, repo.history('c1').length]; };

test('contacto nuevo cuya conversación de GHL ya tiene mensajes de otra línea: no se atiende ni se adopta nada', async () => {
  const previos = [deGhl('a1', { para: OTRO_GHL, texto: 'hablé con el otro número', fecha: '2026-10-01T10:00:00.000Z' }), saliente('a2', { de: OTRO_GHL, fecha: '2026-10-01T10:05:00.000Z' })];
  for (const viejo of previos) {
    const { repo, setter, sal, avanzar } = montar({ lista: [viejo, deGhl('m1', { para: PROPIO_GHL })] });
    const r = await setter.handleWebhook(aviso());
    assert.equal(r.compartida, true);
    avanzar(60000); await setter.tick();
    assert.equal(chats(repo), 0);
    sinEfectos(sal);
  }
});

test('chat propio en el que aparece un entrante a otra línea: no entra, no pausa «por humano» y Sofía deja de actuar ahí', async () => {
  const m = await chatPropio();
  m.repo.schedule('c1', 'comercial-5h', new Date(T0.getTime() + 3600e3).toISOString(), null, 'silencio');
  m.anadir(deGhl('x1', { para: OTRO_GHL, texto: 'esto era para el otro número', fecha: new Date(T0.getTime() + 120000).toISOString() }));
  m.avanzar(120000);
  const r = await m.setter.handleWebhook(aviso({ texto: 'esto era para el otro número' }));
  assert.equal(r.compartida, true);
  assert.deepEqual(estado(m.repo), [0, 'conversación compartida con otra línea de WhatsApp', 2], 'ni mensaje nuevo ni pausa de equipo');
  assert.equal(pendientes(m.repo), 0);
  // Ni un mensaje posterior al número propio la reactiva: el historial ya es compartido
  m.anadir(deGhl('m2', { para: PROPIO_GHL, texto: 'y ahora al de Sofía', fecha: new Date(T0.getTime() + 300000).toISOString() }));
  m.avanzar(300000);
  await m.setter.handleWebhook(aviso({ texto: 'y ahora al de Sofía' }));
  m.avanzar(60000); await m.setter.tick(); await procesarSeguimientos(m.setter);
  assert.equal(m.sal.enviados.length, 1);
  assert.equal(m.repo.history('c1').length, 2);
  assert.deepEqual([m.sal.notas, m.sal.tags.filter((t) => t !== 'captación' && t !== 'captacion').length > 1], [[], false]);
});

test('saliente de OTRA línea (su equipo o su bot): no se importa como respuesta humana ni pausa a Sofía', async () => {
  const m = await chatPropio();
  m.anadir(saliente('o1', { de: OTRO_GHL }));
  m.avanzar(120000);
  // Llega como aviso de saliente con usuario (lo que antes pausaba el chat) y también al repasar antes de contestar
  await m.setter.handleWebhook({ evento: 'outbound', contactId: 'k1', conversationId: 'c1', canal: 'whatsapp', texto: 'te escribe una persona del equipo', messageId: 'o1', userId: 'u1' });
  assert.equal(m.repo.history('c1').filter((x) => x.autor === 'humano').length, 0);
  assert.equal(m.repo.getConv('c1').ai_paused, 0);
  assert.equal(m.repo.getConv('c1').pause_reason, null);
});

test('saliente que no dice su línea (sin `from`, o copia de un conector): no cambia nada en el chat', async () => {
  for (const extra of [{ de: null }, { de: '' }, { tipo: 'TYPE_CUSTOM_SMS', canal: 'type_custom_sms', de: null }, { locationId: OTRA_LOC }]) {
    const m = await chatPropio();
    const antes = estado(m.repo);
    m.anadir(saliente('o1', extra));
    m.avanzar(120000);
    await m.setter.handleWebhook({ evento: 'outbound', contactId: 'k1', conversationId: 'c1', canal: 'whatsapp', texto: 'te escribe una persona del equipo', messageId: 'o1', userId: 'u1' });
    await m.setter.enSerie('c1', () => m.setter.sincronizar('c1'));
    assert.deepEqual(estado(m.repo), antes, JSON.stringify(extra));
  }
});

test('aviso de saliente sin respaldo en GHL: el aviso solo no pausa a Sofía', async () => {
  const m = await chatPropio();
  const r = await m.setter.handleWebhook({ evento: 'outbound', contactId: 'k1', conversationId: 'c1', canal: 'whatsapp', texto: 'mensaje que GHL no lista', messageId: 'fantasma', userId: 'u1' });
  assert.equal(r.salientes, 0);
  assert.deepEqual(estado(m.repo), [0, null, 2]);
  assert.match((await m.setter.onOutbound({ conversationId: 'c1', texto: 'directo', userId: 'u1', messageId: 'z' })).ignorado, /sin verificar/);
});

test('saliente del equipo por el número PROPIO (`from` «+34 910 00 00 01»): sí cuenta y Sofía se aparta', async () => {
  const m = await chatPropio();
  m.anadir(saliente('o1'));
  m.avanzar(120000);
  await m.setter.handleWebhook({ evento: 'outbound', contactId: 'k1', conversationId: 'c1', canal: 'whatsapp', texto: 'te escribe una persona del equipo', messageId: 'o1', userId: 'u1' });
  assert.equal(m.repo.history('c1').filter((x) => x.autor === 'humano').length, 1);
  assert.deepEqual([m.repo.getConv('c1').ai_paused, m.repo.getConv('c1').pause_reason], [1, 'humano escribió']);
});

test('chat que ya existía en la base (misma conversación, de antes o de otra línea): no se adopta su historial ni su estado', async () => {
  const m = montar({ lista: [deGhl('m1', { para: PROPIO_GHL })] });
  heredado(m);
  m.repo.db.prepare("UPDATE conversations SET id = 'c1', contact_id = 'k1', fase = 'f4 objeciones', ai_paused = 1, pause_reason = 'humano escribió', alta_estado = 'pendiente' WHERE id = 'viejo'").run();
  m.repo.db.prepare("UPDATE messages SET conversation_id = 'c1' WHERE conversation_id = 'viejo'").run();
  // Lo único que cambia en un chat heredado es que se le quita la respuesta que tuviera en cola
  const foto = () => JSON.stringify({ ...m.repo.getConv('c1'), respond_at: null, updated_at: null });
  const antes = foto();
  let consultas = 0; const leer = m.setter.ghl.mensajes; m.setter.ghl.mensajes = async (...a) => { consultas++; return leer(...a); };
  assert.equal((await m.setter.handleWebhook(aviso())).ajeno, true);
  m.avanzar(60000); await m.setter.tick();
  assert.equal(foto(), antes, 'el chat heredado queda como estaba');
  assert.equal(consultas, 0, 'ni siquiera se lee su conversación en GHL');
  assert.equal(m.repo.getConv('c1').respond_at, null);
  assert.equal(m.repo.history('c1').length, 1);
  sinEfectos(m.sal);
  // Y sin la pausa heredada tampoco: no es la pausa lo que la para
  m.repo.updateConv('c1', { ai_paused: 0, pause_reason: null });
  await m.setter.handleWebhook(aviso());
  m.avanzar(60000); await m.setter.tick();
  assert.equal(m.repo.history('c1').length, 1);
  sinEfectos(m.sal);
});

test('un envío de Sofía sin confirmar solo se da por hecho si GHL lo sitúa en el número propio', async () => {
  const m = await chatPropio();
  const conv = m.repo.getConv('c1');
  const reciente = (extra) => saliente('s9', { texto: 'mensaje dudoso', userId: null, fecha: T0.toISOString(), ...extra });
  m.anadir(reciente({ de: null }));
  assert.equal(await m.setter.confirmarEnvio(conv, 'mensaje dudoso'), null);
  const n = await chatPropio();
  n.anadir(reciente({ de: PROPIO_GHL }));
  assert.deepEqual(await n.setter.confirmarEnvio(n.repo.getConv('c1'), 'mensaje dudoso'), { messageId: 's9' });
});

// ---------- MODE=live exige el aislamiento ----------

test('MODE=live sin aislamiento: el servicio real no actúa; en modo prueba sigue como siempre', async () => {
  const sin = (live) => estadoAislamiento({ numero: '', locationId: '', locationCliente: LOC, live });
  assert.equal(sin(false).modo, 'apagado');
  assert.equal(sin(true).modo, 'invalido');
  assert.match(sin(true).motivos[0], /MODE=live exige el aislamiento/);
  assert.equal(estadoAislamiento({ numero: PROPIO, locationId: LOC, locationCliente: LOC, live: true }).modo, 'activo');
  // Entrada: nada entra, ni siquiera de un teléfono de prueba
  const m = montar({ aislamiento: sin(true), live: true, telefonosPrueba: [LEAD], lista: [deGhl('m1', { para: PROPIO_GHL })] });
  heredado(m);
  assert.match((await m.setter.handleWebhook(aviso())).ignorado, /mal configurado/);
  m.avanzar(60000); await m.setter.tick(); await procesarSeguimientos(m.setter);
  assert.equal(chats(m.repo), 1, 'solo el heredado');
  sinEfectos(m.sal);
  assert.deepEqual(cuarentena(m.repo.db, sin(true)), { respuestas: 0, seguimientos: 0 }, 'una mala configuración no cancela la cola; simplemente no sale');
  // Salida: el cliente real tampoco envía
  const c = clienteGhl(sin(true));
  assert.throws(() => c.ghl.sendMessage({ contactId: 'k1', canal: 'whatsapp', texto: 'hola' }), /mal configurado/);
  await assert.rejects(() => c.ghl.enviarPorPlantilla({ contactId: 'k1', texto: 'hola' }), /plantilla/);
  assert.deepEqual(c.peticiones, []);
});

test('el simulador y las pruebas internas no dependen del modo del servicio (Setter sin aislamiento, GHL de captura)', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['server.js', 'probar.js', 'bateria.js', 'reportes.js']) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    for (const bloque of src.split('new Setter(').slice(1)) assert.doesNotMatch(bloque.slice(0, bloque.indexOf('});')), /aislamiento/, f);
    assert.doesNotMatch(src, /new Ghl\(/, `${f} no crea el cliente real de GHL`);
  }
  // Un Setter sin aislamiento, aunque sea «live» (así lo crea el simulador), atiende con normalidad
  const { repo, setter, sal, avanzar } = montar({ aislamiento: null, live: true, lista: [deGhl('m1', { para: null, locationId: null })] });
  await setter.handleWebhook(aviso());
  avanzar(60000); await setter.tick();
  assert.equal(sal.enviados.length, 1);
  assert.equal(repo.getConv('c1').aislado_num, null);
});

test('segundo seguro: aunque se llegue a `onInbound` con un mensaje bueno, un chat heredado no se adopta', async () => {
  const m = montar({});
  heredado(m);
  const r = await m.setter.onInbound({ evento: 'inbound', conversationId: 'viejo', contactId: 'kv', canal: 'whatsapp', texto: 'hola otra vez', messageId: 'n1', telefono: LEAD },
    { evidencia: deGhl('n1', { para: PROPIO_GHL, conversationId: 'viejo', contactId: 'kv' }) });
  assert.match(r.ignorado, /historial ajeno/);
  assert.deepEqual([m.repo.history('viejo').length, m.repo.getConv('viejo').aislado_num], [1, null]);
  sinEfectos(m.sal);
});

// ---------- El número propio es el que ya tenía la subcuenta: adopción de los chats que había y plantillas ----------

const AISL_MISMO = estadoAislamiento({ numero: PROPIO, locationId: LOC, locationCliente: LOC, adoptar: true, plantillas: true });

test('opciones: por defecto ni se adoptan chats ni hay plantillas; hay que declararlo', () => {
  assert.deepEqual([AISL.adoptar, AISL.plantillas], [false, false]);
  assert.deepEqual([AISL_MISMO.adoptar, AISL_MISMO.plantillas, AISL_MISMO.clave], [true, true, AISL.clave]);
});

/** El chat heredado «viejo» pasa a ser la conversación c1 del contacto k1 (la misma que lee `deGhl`). */
function heredadoC1(m) {
  heredado(m);
  m.repo.db.prepare("UPDATE conversations SET id = 'c1', contact_id = 'k1' WHERE id = 'viejo'").run();
  for (const t of ['messages', 'scheduled']) m.repo.db.prepare(`UPDATE ${t} SET conversation_id = 'c1' WHERE conversation_id = 'viejo'`).run();
}

test('adopción: un chat que ya había se atiende cuando GHL confirma que es del número propio', async () => {
  const m = montar({ aislamiento: AISL_MISMO, lista: [deGhl('v1', { para: PROPIO_GHL, texto: 'hola', fecha: '2026-11-16T10:00:00.000Z' }), deGhl('m1', { para: PROPIO_GHL })] });
  heredadoC1(m);
  m.repo.db.prepare("UPDATE scheduled SET estado = 'cancelado'").run();
  await m.setter.handleWebhook(aviso());
  assert.equal(m.repo.getConv('c1').aislado_num, AISL.clave);
  m.avanzar(60000); await m.setter.tick();
  assert.equal(m.sal.enviados.length, 1);
  assert.equal(m.repo.history('c1').filter((x) => x.autor === 'lead').length, 2, 'conserva su historial, que es de esta misma línea');
});

test('adopción: no se adopta si en GHL hay algo de otra línea, ni si no hay ningún WhatsApp al número propio', async () => {
  const casos = {
    'otra línea': [deGhl('x1', { para: OTRO_GHL, fecha: '2026-11-10T10:00:00.000Z' }), deGhl('m1', { para: PROPIO_GHL })],
    'saliente de otra línea': [saliente('o1', { de: OTRO_GHL, fecha: '2026-11-10T10:00:00.000Z' }), deGhl('m1', { para: PROPIO_GHL })],
    'sin destinatario': [deGhl('m1', { para: null })],
    'solo Instagram': [deGhl('m1', { tipo: 'TYPE_INSTAGRAM', canal: 'instagram', para: null })],
    'otra subcuenta': [deGhl('m1', { para: PROPIO_GHL, locationId: OTRA_LOC })],
    'vacía': [],
  };
  for (const [nombre, lista] of Object.entries(casos)) {
    const m = montar({ aislamiento: AISL_MISMO, lista });
    heredadoC1(m);
    await m.setter.handleWebhook(aviso());
    m.avanzar(60000); await m.setter.tick(); await procesarSeguimientos(m.setter);
    assert.equal(m.repo.getConv('c1').aislado_num, null, nombre);
    assert.equal(m.repo.history('c1').length, 1, nombre);
    sinEfectos(m.sal);
  }
});

test('adopción: la cola que había se conserva y cada envío comprueba antes el chat en GHL', async () => {
  const m = montar({ aislamiento: AISL_MISMO, lista: [deGhl('v1', { para: PROPIO_GHL, texto: 'hola' })], respuestas: [['respuesta pendiente'], ['sigues ahí?']] });
  heredadoC1(m);
  assert.deepEqual(cuarentena(m.repo.db, AISL_MISMO), { respuestas: 0, seguimientos: 0 }, 'no se cancela la cola de los chats por adoptar');
  m.avanzar(60000); await m.setter.tick();
  assert.equal(m.repo.getConv('c1').aislado_num, AISL.clave, 'adoptado al ir a contestar');
  assert.deepEqual(m.sal.enviados.map((x) => x.texto), ['respuesta pendiente']);
  // Un chat bloqueado no se adopta ni conserva su cola
  const b = montar({ aislamiento: AISL_MISMO, lista: [deGhl('v1', { para: PROPIO_GHL })] });
  heredadoC1(b);
  b.repo.updateConv('c1', { aislado_bloqueo: 'conversación compartida con otra línea de WhatsApp' });
  assert.deepEqual(cuarentena(b.repo.db, AISL_MISMO), { respuestas: 1, seguimientos: 2 });
  assert.equal(await b.setter.intentarAdoptar('c1'), false);
});

test('adopción: un seguimiento manual de un chat que había sale tras adoptarlo; si GHL no lo confirma, se omite', async () => {
  for (const [lista, sale] of [[[deGhl('v1', { para: PROPIO_GHL, texto: 'hola' })], true], [[deGhl('v1', { para: OTRO_GHL, texto: 'hola' })], false]]) {
    const m = montar({ aislamiento: AISL_MISMO, lista });
    heredadoC1(m);
    m.repo.updateConv('c1', { respond_at: null });
    m.repo.db.prepare("UPDATE scheduled SET estado = 'cancelado' WHERE tipo != 'manual'").run();
    m.avanzar(60000); await procesarSeguimientos(m.setter);
    assert.deepEqual(m.sal.enviados.map((x) => x.texto), sale ? ['mensaje escrito a mano antes del cambio'] : []);
    const estadoFinal = m.repo.db.prepare("SELECT estado FROM scheduled WHERE tipo = 'manual'").get().estado;
    if (sale) assert.equal(estadoFinal, 'enviado'); else assert.ok(['omitido', 'cancelado'].includes(estadoFinal), estadoFinal);
    assert.equal(Boolean(m.repo.getConv('c1').aislado_bloqueo), !sale);
  }
});

test('plantillas declaradas (SOFIA_WA_PLANTILLAS): fuera de las 24 h el seguimiento sale por el workflow de GHL', async () => {
  const m = montar({ aislamiento: AISL_MISMO, lista: [deGhl('m1', { para: PROPIO_GHL })] });
  await m.setter.handleWebhook(aviso());
  m.avanzar(60000); await m.setter.tick();
  m.repo.db.prepare("UPDATE scheduled SET estado = 'cancelado'").run();
  programarManual(m.repo, 'c1', 'te escribo más tarde', new Date(T0.getTime() + 30 * 3600e3).toISOString(), T0);
  m.avanzar(34 * 3600e3);
  await procesarSeguimientos(m.setter);
  assert.deepEqual(m.sal.plantillas, [{ contactId: 'k1', texto: 'te escribo más tarde' }]);
  assert.equal(m.repo.db.prepare("SELECT estado, detalle FROM scheduled WHERE tipo = 'manual'").get().detalle, 'plantilla');
  // Cliente real: escribe el campo y pone la etiqueta que dispara el workflow; sin la declaración, nada
  const c = clienteGhl(AISL_MISMO);
  c.ghl._campo = 'campo1';
  await c.ghl.enviarPorPlantilla({ contactId: 'k1', texto: 'hola' });
  assert.deepEqual(c.peticiones.map((p) => `${p.method} ${p.url.replace('https://ghl.invalid', '')}`), ['PUT /contacts/k1', 'DELETE /contacts/k1/tags', 'POST /contacts/k1/tags']);
  assert.deepEqual(c.peticiones[2].body, { tags: ['sofia-enviar-plantilla'] });
});

test('plantilla que sale por otra línea: al repasar la conversación, el chat queda bloqueado', async () => {
  const m = await chatPropio({ aislamiento: AISL_MISMO });
  m.anadir(saliente('p1', { de: OTRO_GHL, source: 'workflow', userId: null, texto: 'plantilla enviada por el workflow' }));
  m.avanzar(120000);
  await m.setter.enSerie('c1', () => m.setter.sincronizar('c1'));
  assert.equal(m.repo.getConv('c1').aislado_bloqueo, 'conversación compartida con otra línea de WhatsApp');
});
