import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import { guardarAjustes, leerAjustes } from '../src/ajustes.js';
import { textoAviso, textoApertura, avisadoEnEsteCierre, MENSAJE_FUERA_HORARIO } from '../src/fuera-horario.js';

// Miércoles 18/11/2026 a las 00:30 en Madrid: fuera del horario por defecto (de 8 a 0)
const NOCHE = new Date('2026-11-17T23:30:00Z');

function montar({ live = true, telefonosPrueba = [], respuestas = [] } = {}) {
  const repo = crearRepo(openDb(':memory:'));
  const llamadas = { enviados: [], notas: [], requests: [] };
  const ghl = {
    sendMessage: async ({ texto }) => { llamadas.enviados.push(texto); return { messageId: `m${llamadas.enviados.length}` }; },
    addTags: async () => {}, removeTags: async () => {}, assign: async () => {},
    addNote: async (_, n) => llamadas.notas.push(n),
    getContact: async () => ({ contact: { phone: '+34600000000' } }),
  };
  let reloj = new Date(NOCHE);
  const cola = [...respuestas];
  const complete = async (req) => {
    llamadas.requests.push(req);
    const r = cola.shift();
    if (!r) throw new Error('sin respuesta preparada');
    return { content: r.map((b, i) => ({ type: 'tool_use', id: `t${i}`, ...b })), usage: { input_tokens: 10, output_tokens: 5 } };
  };
  const setter = new Setter({
    repo, ghl, complete, live, telefonosPrueba, sleep: async () => {}, now: () => reloj, random: () => 0, avisar: async () => {},
    aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: false }), prepararAlta: async () => ({ estado: 'preparada' }) },
  });
  return { repo, setter, llamadas, avanzar: (ms) => { reloj = new Date(reloj.getTime() + ms); }, irA: (d) => { reloj = new Date(d); } };
}

const entrante = (texto, id, extra = {}) => ({ evento: 'inbound', conversationId: 'c1', contactId: 'k1', canal: 'whatsapp', texto, messageId: id, telefono: '+34600000000', nombre: 'Laura Gómez', ...extra });

test('fuera de horario el lead recibe al momento el aviso automático, una sola vez por noche', async () => {
  const { setter, repo, llamadas, avanzar } = montar();
  const r = await setter.handleWebhook(entrante('hola, cuánto cuesta?', 'w1'));
  assert.equal(r.aviso_fuera_horario, 'enviado');
  assert.deepEqual(llamadas.enviados, [MENSAJE_FUERA_HORARIO]);
  // Sofía contesta de verdad a las 8:00
  assert.equal(repo.getConv('c1').respond_at, '2026-11-18T07:00:00.000Z');
  const m = repo.db.prepare("SELECT autor, tipo, external_id FROM messages WHERE autor = 'sistema'").get();
  assert.deepEqual({ ...m }, { autor: 'sistema', tipo: 'fuera_horario', external_id: 'm1' });
  // Otro mensaje la misma noche: no se repite el aviso
  avanzar(2 * 3600e3);
  const r2 = await setter.handleWebhook(entrante('y en getafe?', 'w2'));
  assert.equal(r2.aviso_fuera_horario, undefined);
  assert.equal(llamadas.enviados.length, 1);
  // El aviso no entra en el historial que lee el modelo (no cuenta como respuesta de Sofía)
  assert.ok(repo.history('c1').every((x) => x.autor === 'lead'));
  assert.equal(setter.yaContestado('c1'), false);
});

test('la noche siguiente vuelve a avisar; dentro de horario no avisa', async () => {
  const { setter, llamadas, irA } = montar();
  await setter.handleWebhook(entrante('hola', 'w1'));
  irA('2026-11-18T10:00:00Z'); // 11:00 en Madrid
  await setter.handleWebhook(entrante('sigo por aquí', 'w2'));
  assert.equal(llamadas.enviados.length, 1);
  irA('2026-11-18T23:15:00Z'); // 00:15 del jueves
  await setter.handleWebhook(entrante('hola otra vez', 'w3'));
  assert.equal(llamadas.enviados.length, 2);
});

test('al volver, Sofía sabe que se mandó el aviso y no lo repite', async () => {
  const { setter, llamadas, irA } = montar({ respuestas: [[{ name: 'responder', input: { mensajes: ['¡Buenos días Laura! Te cuento los precios'], fase: 'f1 apertura' } }]] });
  await setter.handleWebhook(entrante('hola, cuánto cuesta?', 'w1'));
  irA('2026-11-18T07:00:05Z');
  await setter.tick();
  const sys = JSON.stringify(llamadas.requests[0].system);
  assert.match(sys, /aviso automático/);
  assert.equal(llamadas.requests[0].messages.at(-1).role, 'user');
  assert.deepEqual(llamadas.enviados, [MENSAJE_FUERA_HORARIO, '¡Buenos días Laura! Te cuento los precios']);
});

test('aviso configurable: se apaga, cambia de texto y elige canal', async () => {
  const { setter, repo, llamadas } = montar();
  assert.throws(() => guardarAjustes(repo, { fueraHorario: { mensaje: '   ' } }), /escribe el mensaje/);
  guardarAjustes(repo, { fueraHorario: { mensaje: 'Hola {nombre}, te escribimos {apertura}.' } });
  assert.equal(leerAjustes(repo).fueraHorario.activo, true);
  await setter.handleWebhook(entrante('hola', 'w1'));
  assert.equal(llamadas.enviados[0], 'Hola Laura, te escribimos hoy a las 8:00.');

  // Instagram viene activado por defecto; se puede apagar por canal
  await setter.handleWebhook(entrante('hola', 'i1', { conversationId: 'c2', contactId: 'k2', canal: 'instagram', telefono: null }));
  assert.equal(llamadas.enviados.length, 2);
  guardarAjustes(repo, { fueraHorario: { canales: { instagram: false } } });
  await setter.handleWebhook(entrante('hola', 'i2', { conversationId: 'c4', contactId: 'k4', canal: 'instagram', telefono: null }));
  assert.equal(llamadas.enviados.length, 2);

  guardarAjustes(repo, { fueraHorario: { activo: false } });
  await setter.handleWebhook(entrante('hola', 'w9', { conversationId: 'c3', contactId: 'k3' }));
  assert.equal(llamadas.enviados.length, 2);
});

test('en modo prueba el aviso queda como borrador; los teléfonos de prueba no tienen horario', async () => {
  const sombra = montar({ live: false });
  const r = await sombra.setter.handleWebhook(entrante('hola', 'w1'));
  assert.equal(r.aviso_fuera_horario, 'borrador');
  assert.equal(sombra.llamadas.enviados.length, 0);
  assert.match(sombra.llamadas.notas[0], /aviso fuera de horario/);

  const prueba = montar({ telefonosPrueba: ['600000000'] });
  await prueba.setter.handleWebhook(entrante('hola', 'w1'));
  assert.equal(prueba.llamadas.enviados.length, 0);
});

test('el texto por defecto anterior (solo WhatsApp) guardado se cambia por el nuevo', () => {
  const { repo } = montar();
  repo.guardarAjuste('fueraHorario', { activo: true, mensaje: '¡Hola! Ahora mismo no estamos atendiendo el WhatsApp. En cuanto lo leamos te contestamos y te ayudamos con todo lo que necesites 😊', canales: { whatsapp: true, instagram: false } });
  assert.equal(leerAjustes(repo).fueraHorario.mensaje, MENSAJE_FUERA_HORARIO);
  assert.doesNotMatch(MENSAJE_FUERA_HORARIO, /WhatsApp/);
});

test('textos del aviso', () => {
  const ahora = new Date('2026-11-17T23:30:00Z'); // miércoles 00:30
  assert.equal(textoApertura(ahora), 'hoy a las 8:00');
  assert.equal(textoApertura(new Date('2026-11-17T21:30:00Z'), new Date('2026-11-18T07:00:00Z')), 'mañana a las 8:00');
  assert.equal(textoApertura(new Date('2026-11-20T21:30:00Z'), new Date('2026-11-23T08:00:00Z')), 'el lunes a las 9:00');
  assert.equal(textoAviso('¡Hola {nombre}!', { ahora, nombre: null }), '¡Hola!');
  assert.equal(avisadoEnEsteCierre('2026-11-17T23:30:00Z', new Date('2026-11-18T05:00:00Z')), true);
  assert.equal(avisadoEnEsteCierre('2026-11-17T23:30:00Z', new Date('2026-11-18T23:30:00Z')), false);
});
