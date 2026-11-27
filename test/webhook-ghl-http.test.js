// POST /webhooks/ghl: el aviso queda guardado en la base antes de contestar 200. Datos sintéticos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import { crearApp } from '../src/server.js';
import { config } from '../src/config.js';

const SECRETO = 'secreto-de-prueba-del-webhook-de-ghl-123';

async function servidor({ repo, setter }) {
  const antes = { webhookSecret: config.webhookSecret, ghlWebhookEnabled: config.ghlWebhookEnabled };
  Object.assign(config, { webhookSecret: SECRETO, ghlWebhookEnabled: true });
  const srv = crearApp({ setter, repo }).listen(0);
  await new Promise((ok) => srv.once('listening', ok));
  const url = `http://127.0.0.1:${srv.address().port}/webhooks/ghl`;
  const enviar = (cuerpo, secreto = SECRETO) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-setter-secret': secreto }, body: JSON.stringify(cuerpo) });
  return { enviar, cerrar: () => { srv.close(); Object.assign(config, antes); } };
}
const cuerpo = { type: 'InboundMessage', contactId: 'k1', conversationId: 'c1', messageType: 'TYPE_WHATSAPP', body: 'hola, precio?', messageId: 'm1' };

test('el aviso está en la base cuando GHL recibe el 200, aunque su proceso siga en marcha', async () => {
  const repo = crearRepo(openDb(':memory:'));
  let terminar; const recibidos = [];
  const setter = { now: () => new Date(), handleWebhook: (evt) => { recibidos.push(evt); return new Promise((ok) => { terminar = ok; }); } };
  const s = await servidor({ repo, setter });
  try {
    const r = await s.enviar(cuerpo);
    assert.equal(r.status, 200);
    const fila = repo.db.prepare('SELECT * FROM ghl_avisos').get();
    assert.equal(fila.estado, 'procesando', 'guardado y en marcha: un reinicio ahora lo devuelve a la cola');
    assert.equal(JSON.parse(fila.evento).texto, 'hola, precio?');
    assert.ok(JSON.parse(fila.evento).recibido, 'con la hora de llegada');
    assert.equal(recibidos.length, 1);
    terminar({ registrado: true });
    await new Promise((ok) => setTimeout(ok, 20));
    assert.equal(repo.db.prepare('SELECT estado FROM ghl_avisos').get().estado, 'hecho');
  } finally { s.cerrar(); }
});

test('si el aviso no se puede guardar, no se contesta 200 ni se procesa', async () => {
  const repo = crearRepo(openDb(':memory:'));
  repo.guardarAvisoGhl = () => { throw new Error('database is locked'); };
  let llamadas = 0;
  const s = await servidor({ repo, setter: { now: () => new Date(), handleWebhook: async () => { llamadas++; } } });
  const error = console.error; console.error = () => {};
  try {
    const r = await s.enviar(cuerpo);
    assert.equal(r.status, 500);
    assert.equal(llamadas, 0);
  } finally { console.error = error; s.cerrar(); }
});

test('con el secreto equivocado no se guarda nada', async () => {
  const repo = crearRepo(openDb(':memory:'));
  const s = await servidor({ repo, setter: { now: () => new Date(), handleWebhook: async () => ({}) } });
  try {
    assert.equal((await s.enviar(cuerpo, 'otro-secreto-cualquiera-de-prueba')).status, 401);
    assert.equal(repo.db.prepare('SELECT count(*) n FROM ghl_avisos').get().n, 0);
  } finally { s.cerrar(); }
});
