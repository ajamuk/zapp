import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import * as medios from '../src/medios.js';

const T0 = new Date('2026-11-17T11:00:00Z').getTime(); // martes, en horario

function montar() {
  const repo = crearRepo(openDb(':memory:'));
  const reloj = { t: T0 };
  const fake = { procesarAdjuntos: async (adj) => { const s = Number(/(\d+)s\.ogg$/.exec(adj[0])?.[1] || 0); reloj.t += 8000; // tarda 8 s en transcribir
    return { adjunto: 'audio', media_ruta: 'm/a.ogg', media_mime: 'audio/ogg', transcripcion: 'hola', media_error: null, duracion: s }; } };
  const setter = new Setter({
    repo, medios: fake, live: true, sleep: async () => {}, now: () => new Date(reloj.t), random: () => 0,
    ghl: { sendMessage: async () => ({}), addTags: async () => {}, removeTags: async () => {}, assign: async () => {}, addNote: async () => {}, getContact: async () => ({ contact: {} }) },
    aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: false }) },
    complete: async () => ({ content: [] }),
  });
  let n = 0;
  const entra = (c, extra) => setter.onInbound({ conversationId: c, contactId: 'k' + c, canal: 'whatsapp', texto: '', messageId: 'm' + (n++), telefono: '+34600000000', ...extra });
  const espera = (c) => new Date(repo.getConv(c).respond_at).getTime();
  return { repo, reloj, entra, espera };
}

test('un audio del lead se escucha entero antes de la espera normal', async () => {
  const { reloj, entra, espera } = montar();
  await entra('texto', { texto: 'hola' });
  // La espera de siempre (leer «hola» suma 4/30 de segundo, que un audio sin texto no tiene)
  const normal = espera('texto') - T0 - Math.round(4000 / 30);
  assert.ok(normal > 0);

  // Audio de 40 s: 40 s desde que llegó (no desde que acabó de transcribirse) más la espera normal
  reloj.t = T0;
  await entra('audio', { adjuntos: ['https://x/40s.ogg'] });
  assert.equal(espera('audio') - T0, 40000 + normal);

  // Audio corto (3 s) que tarda 8 s en transcribirse: ya está oído, solo queda la espera normal
  reloj.t = T0;
  await entra('corto', { adjuntos: ['https://x/3s.ogg'] });
  assert.equal(espera('corto') - T0, 8000 + normal);
});

test('varios audios se oyen seguidos, y un texto posterior no acorta la escucha', async () => {
  const { reloj, entra, espera } = montar();
  await entra('a', { adjuntos: ['https://x/40s.ogg'] }); // llega en T0, se oye hasta T0+40
  const normal = espera('a') - T0 - 40000;
  reloj.t = T0 + 10000;
  await entra('a', { adjuntos: ['https://x/30s.ogg'] }); // se oye después del primero: hasta T0+70
  assert.equal(espera('a') - T0, 70000 + normal);
  reloj.t = T0 + 20000;
  await entra('a', { texto: 'perdona el rollo' });
  assert.ok(espera('a') - T0 >= 70000 + normal);
  // Un audio eterno no deja al lead esperando más de 10 minutos de escucha
  reloj.t = T0;
  await entra('largo', { adjuntos: ['https://x/3000s.ogg'] });
  assert.equal(espera('largo') - T0, 600000 + normal);
});

test('la duración sale de ffprobe y, si falla, de la transcripción', async () => {
  assert.equal(await medios.duracionAudio('/x/a.ogg', { ejecutarImpl: async (cmd) => { assert.match(cmd, /ffprobe$/); return '12.345000'; } }), 12.3);
  assert.equal(await medios.duracionAudio('/x/a.ogg', { transcripcion: 'uno dos tres cuatro cinco', ejecutarImpl: async () => { throw new Error('no'); } }), 2);
  assert.equal(await medios.duracionAudio('/x/a.ogg', { ejecutarImpl: async () => 'N/A' }), 0);
});
