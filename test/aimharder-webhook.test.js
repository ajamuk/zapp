import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb, repo as crearRepo } from '../src/db.js';
import { descifrar, manejadorWebhook } from '../src/aimharder/webhook.js';
import { buscarSocioPorTelefono } from '../src/aimharder/index.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const clavePem = privateKey.export({ type: 'pkcs8', format: 'pem' });

/** Sobre igual que el de AimHarder: AES-256-GCM sin AAD y clave AES con RSA-OAEP SHA-1. */
function cifrar(evento) {
  const aes = crypto.randomBytes(32); const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', aes, iv);
  const payload = Buffer.concat([c.update(JSON.stringify(evento), 'utf8'), c.final()]);
  const encryptedKey = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, aes);
  return { version: '2.0', action: evento.action, encryptedKey: encryptedKey.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), payload: payload.toString('base64') };
}

test('descifra el sobre y detecta alteraciones', () => {
  const ev = { id: 'e1', action: 'WEBHOOK_TEST', data: {} };
  assert.deepEqual(descifrar(cifrar(ev), clavePem), ev);
  const roto = cifrar(ev); roto.tag = Buffer.alloc(16).toString('base64');
  assert.throws(() => descifrar(roto, clavePem));
});

test('evento de cliente: relee la ficha y actualiza solo ese socio; duplicados y fallos', async () => {
  const repo = crearRepo(openDb(':memory:'));
  repo.reemplazarSocios('getafe', [{ telefono: '611111111', sede: 'getafe', aimharder_id: 1, nombre: 'A', activo: 1, tarifa: 'L' }]);
  let ficha = { id: 2, name: 'Bea', first_surname: 'Gil', mobile_number: '+34 622 222 222', current_memberships: [{ membership_name: 'Academy' }] };
  const apis = { getafe: { cliente: async () => ficha } };
  const log = { log() {}, warn() {}, error() {} };
  const h = manejadorWebhook({ repo, apis, claves: { getafe: clavePem }, sedes: ['parla', 'getafe'], log });

  const ev = { id: 'e2', action: 'MEMBERSHIP_ASSIGNED', data: { client: { id: 2 } } };
  const r = await h('getafe', cifrar(ev)); await r.trabajo;
  assert.equal(r.status, 200);
  assert.equal(buscarSocioPorTelefono(repo, '622222222').esSocio, true);
  assert.equal(buscarSocioPorTelefono(repo, '611111111').esSocio, true, 'el resto del índice no se toca');

  assert.equal((await h('getafe', cifrar(ev))).duplicado, true);

  ficha = { ...ficha, deactivation_date: '2026-12-01' };
  const b = await h('getafe', cifrar({ id: 'e3', action: 'CLIENT_DEACTIVATED', data: { client: { id: 2 } } })); await b.trabajo;
  assert.equal(buscarSocioPorTelefono(repo, '622222222').esSocio, false);

  // Si la API falla, el evento se olvida para que el reintento de AimHarder se procese
  apis.getafe.cliente = async () => { throw new Error('429'); };
  const f = await h('getafe', cifrar({ id: 'e4', action: 'CLIENT_CREATED', data: { client: { id: 3 } } })); await f.trabajo;
  assert.equal(repo.eventoAimharderNuevo('e4', 'getafe', 'CLIENT_CREATED'), true);

  assert.equal((await h('parla', cifrar(ev))).status, 503, 'sin clave de esa sede');
  assert.equal((await h('otra', {})).status, 404);
  assert.equal((await h('getafe', { encryptedKey: 'x', iv: 'x', tag: 'x', payload: 'x' })).status, 400);
});
