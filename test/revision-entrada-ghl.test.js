// Fallos encontrados en la revisión del recorrido de entrada de GHL (22/11): cada test fija uno ya corregido.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import { procesarSeguimientos } from '../src/followups.js';
import { MENSAJE_FUERA_HORARIO } from '../src/fuera-horario.js';

const T0 = new Date('2026-11-17T11:00:00Z'); // martes 12:00 en Madrid
function montar({ respuestas = [], live = true, socio = false, telefonosPrueba = [], mensajesGhl = null } = {}) {
  const repo = crearRepo(openDb(':memory:'));
  const sal = { enviados: [], notas: [], avisos: [], altas: [] };
  let reloj = new Date(T0);
  const cola = [...respuestas];
  const ghl = {
    sendMessage: async ({ texto }) => { sal.enviados.push(texto); return { messageId: `m${sal.enviados.length}` }; },
    enviarPorPlantilla: async () => ({ messageId: null }),
    addTags: async () => {}, removeTags: async () => {}, assign: async () => {}, addNote: async (_, n) => sal.notas.push(n), getContact: async () => ({ contact: {} }),
    ...(mensajesGhl ? { mensajes: async () => mensajesGhl() } : {}),
  };
  const setter = new Setter({
    repo, ghl, live, telefonosPrueba, sleep: async () => {}, now: () => reloj, random: () => 0, avisar: async (t) => sal.avisos.push(t),
    aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: socio, sede: socio ? 'Getafe' : null }), prepararAlta: async (d, o) => { sal.altas.push(o || {}); return { estado: 'simulada', detalle: 'ensayo' }; } },
    complete: async () => {
      const r = cola.shift();
      if (!r) throw new Error('sin respuesta preparada');
      return { content: r.map((b, i) => ({ type: 'tool_use', id: `t${i}`, ...b })), usage: { input_tokens: 1, output_tokens: 1 } };
    },
  });
  return { repo, setter, sal, avanzar: (ms) => { reloj = new Date(reloj.getTime() + ms); }, ahora: () => reloj };
}
const resp = (mensajes) => [{ name: 'responder', input: { fase: 'f2 diagnóstico', sede: 'desconocida', mensajes } }];
const entrante = (texto, id) => ({ evento: 'inbound', conversationId: 'c1', contactId: 'k1', canal: 'whatsapp', texto, messageId: id, telefono: '+34600000000' });
const datosAlta = { nombre_completo: 'Ana Prueba', email: 'ana@example.com', fecha_nacimiento: '1990-05-01', sede: 'parla', tarifa: 'academy_2', fecha_inicio: '2026-11-23' };

test('teléfono de prueba que además es socio: su seguimiento no lo marca como socio ni pausa el chat', async () => {
  const { repo, setter, sal, avanzar } = montar({ live: false, socio: true, telefonosPrueba: ['+34600000000'], respuestas: [resp(['hola, te cuento']), resp(['sigues ahí?'])] });
  await setter.handleWebhook(entrante('precio?', 'w1'));
  avanzar(60000); await setter.tick();
  assert.deepEqual(sal.enviados, ['hola, te cuento']);
  avanzar(300 * 60000);
  await procesarSeguimientos(setter);
  const c = repo.getConv('c1');
  assert.deepEqual([c.tipo, c.ai_paused], ['captacion', 0]);
});

test('en modo prueba el alta se ensaya sin guardar, y no se repite en cada turno', async () => {
  const { repo, setter, sal, avanzar } = montar({ live: false, respuestas: [[{ name: 'preparar_alta', input: datosAlta }], resp(['genial']), [{ name: 'preparar_alta', input: datosAlta }], resp(['ya está en marcha'])] });
  await setter.handleWebhook(entrante('mis datos son…', 'w1'));
  avanzar(60000); await setter.tick();
  assert.deepEqual(sal.altas, [{ dryRun: true }]);
  assert.equal(repo.getConv('c1').alta_estado, 'pendiente');
  await setter.handleWebhook(entrante('y ya está?', 'w2'));
  avanzar(60000); await setter.tick();
  assert.equal(sal.altas.length, 1, 'con el alta ya pasada al equipo no se vuelve a tramitar');
  assert.equal(sal.avisos.filter((a) => /Alta para terminar a mano/.test(a)).length, 1);
});

test('donde Sofía envía de verdad, el alta usa la configuración (sin forzar el ensayo)', async () => {
  const { setter, sal, avanzar } = montar({ live: true, respuestas: [[{ name: 'preparar_alta', input: datosAlta }], resp(['genial'])] });
  await setter.handleWebhook(entrante('mis datos son…', 'w1'));
  avanzar(60000); await setter.tick();
  assert.deepEqual(sal.altas, [{}]);
});

test('antes de un seguimiento se repasa el chat en GHL: si el equipo ya ha escrito, no sale', async () => {
  // En GHL está el mensaje del lead (el mismo id que trae el aviso)
  let lista = [{ id: 'w1', direccion: 'inbound', tipo: 'TYPE_WHATSAPP', canal: 'whatsapp', texto: 'precio?', adjuntos: [], userId: null, source: null, fecha: T0.toISOString() }];
  const { repo, setter, sal, avanzar, ahora } = montar({ respuestas: [resp(['te cuento']), resp(['sigues interesada?'])], mensajesGhl: () => lista });
  await setter.handleWebhook(entrante('precio?', 'w1'));
  avanzar(60000); await setter.tick();
  assert.deepEqual(sal.enviados, ['te cuento']);
  avanzar(10 * 60000);
  lista = [...lista, { id: 'h1', direccion: 'outbound', tipo: 'TYPE_WHATSAPP', canal: 'whatsapp', texto: 'Hola, soy Carlos, te llamo luego', adjuntos: [], userId: 'u7', source: 'app', fecha: ahora().toISOString() }];
  avanzar(300 * 60000);
  await procesarSeguimientos(setter);
  assert.deepEqual(sal.enviados, ['te cuento'], 'el seguimiento no sale encima de la conversación del equipo');
  assert.equal(repo.getConv('c1').ai_paused, 1);
  assert.equal(setter.enCurso.size, 0);
});

test('seguimientos programados sobre borradores no salen al pasar a enviar de verdad', async () => {
  const { repo, setter, sal, avanzar } = montar({ live: false, respuestas: [resp(['hola, te cuento']), resp(['sigues ahí?'])] });
  await setter.handleWebhook(entrante('precio?', 'w1'));
  avanzar(60000); await setter.tick();
  assert.equal(sal.enviados.length, 0);
  assert.ok(repo.db.prepare("SELECT count(*) n FROM scheduled WHERE estado = 'pendiente'").get().n > 0, 'en prueba se programan como borrador');
  setter.live = true; // el servicio pasa a modo real
  avanzar(300 * 60000);
  await procesarSeguimientos(setter);
  assert.equal(sal.enviados.length, 0);
  assert.match(repo.db.prepare("SELECT detalle FROM scheduled WHERE estado = 'omitido' ORDER BY id LIMIT 1").get().detalle, /modo prueba/);
});

test('fuera de horario: el teléfono de prueba recibe respuesta al momento; un lead espera a la apertura en punto', async () => {
  // 17/11 12:00 + 19 h 54 min = miércoles 18/11 a las 7:54 en Madrid (Sofía contesta desde las 8:00)
  const prueba = montar({ live: false, telefonosPrueba: ['+34600000000'], respuestas: [resp(['hola, soy Sofía'])] });
  prueba.avanzar((19 * 60 + 54) * 60000);
  await prueba.setter.handleWebhook(entrante('hola', 'w1'));
  prueba.avanzar(60000); await prueba.setter.tick();
  assert.deepEqual(prueba.sal.enviados, ['hola, soy Sofía']);

  const lead = montar({ live: true, respuestas: [resp(['hola, soy Sofía'])] });
  lead.avanzar((19 * 60 + 54) * 60000);
  await lead.setter.handleWebhook(entrante('hola', 'w1'));
  lead.avanzar(60000); await lead.setter.tick();
  assert.deepEqual(lead.sal.enviados, [MENSAJE_FUERA_HORARIO]); // de noche, solo el aviso automático
  assert.equal(lead.repo.getConv('c1').respond_at, '2026-11-18T07:00:00.000Z');
  lead.avanzar(5 * 60000); await lead.setter.tick(); // 8:00
  assert.deepEqual(lead.sal.enviados, [MENSAJE_FUERA_HORARIO, 'hola, soy Sofía']);
});
