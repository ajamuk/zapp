import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb, repo as crearRepo } from '../src/db.js';
import { AimHarderApi } from '../src/aimharder/api.js';
import { descifrar, manejadorWebhook, crearProcesador, ESPERAS_S } from '../src/aimharder/webhook.js';
import { buscarSocioPorTelefono } from '../src/aimharder/index.js';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const clavePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const log = { log() {}, warn() {}, error() {} };
const T0 = Date.parse('2026-11-26T10:00:00Z');

/** Sobre igual que el de AimHarder: AES-256-GCM sin AAD y clave AES con RSA-OAEP SHA-1. */
function cifrar(evento) {
  const aes = crypto.randomBytes(32); const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', aes, iv);
  const payload = Buffer.concat([c.update(JSON.stringify(evento), 'utf8'), c.final()]);
  const encryptedKey = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, aes);
  return { version: '2.0', action: evento.action, encryptedKey: encryptedKey.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), payload: payload.toString('base64') };
}
const evento = (id, action = 'MEMBERSHIP_ASSIGNED', clienteId = 2) => ({ id, action, data: { client: { id: clienteId } } });
const ficha = (id = 2, extra = {}) => ({ id, name: 'Bea', first_surname: 'Gil', mobile_number: `+34 62${String(id).padStart(7, '2')}`, current_memberships: [{ membership_name: 'Academy' }], ...extra });
const error = (status, retryAfter) => Object.assign(new Error(`AimHarder → ${status}`), { status, retryAfter });
/** API falsa: `respuestas` es una lista de resultados (objeto = ficha, Error = fallo); la última se repite. */
function apiFalsa(respuestas) {
  const api = { llamadas: [], cliente: async (id) => {
    api.llamadas.push(id);
    const r = respuestas[Math.min(api.llamadas.length - 1, respuestas.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  } };
  return api;
}
const montar = (apis, { despertar } = {}) => {
  const repo = crearRepo(openDb(':memory:'));
  const h = manejadorWebhook({ repo, claves: { getafe: clavePem, parla: clavePem }, sedes: ['parla', 'getafe'], despertar, log, reloj: () => T0 });
  const procesar = crearProcesador({ repo, apis, log });
  return { repo, h, procesar, fila: (id) => repo.db.prepare('SELECT * FROM aimharder_eventos WHERE id = ?').get(id) };
};

test('descifra el sobre y detecta alteraciones', () => {
  const ev = { id: 'e1', action: 'WEBHOOK_TEST', data: {} };
  assert.deepEqual(descifrar(cifrar(ev), clavePem), ev);
  const roto = cifrar(ev); roto.tag = Buffer.alloc(16).toString('base64');
  assert.throws(() => descifrar(roto, clavePem));
});

test('el evento queda guardado antes del 200 y la lectura se hace después', async () => {
  const api = apiFalsa([ficha()]);
  const { repo, h, procesar, fila } = montar({ getafe: api });
  const r = await h('getafe', cifrar(evento('e1')));
  assert.equal(r.status, 200);
  assert.equal(api.llamadas.length, 0, 'el 200 no espera a la API');
  assert.equal(fila('e1').estado, 'pendiente');
  assert.equal(buscarSocioPorTelefono(repo, '622222222', { rutas: {} }).esSocio, false);

  assert.deepEqual(await procesar({ ahora: T0 }), { hechos: 1, reintentos: 0, pausados: 0, fallidos: 0 });
  assert.equal(fila('e1').estado, 'hecho');
  assert.equal(buscarSocioPorTelefono(repo, '622222222').esSocio, true);
});

test('el 200 despierta al procesador sin esperar a la siguiente vuelta', async () => {
  let despertado = 0;
  const { h } = montar({ getafe: apiFalsa([ficha()]) }, { despertar: () => { despertado++; } });
  await h('getafe', cifrar(evento('e1')));
  await new Promise((r) => setImmediate(r));
  assert.equal(despertado, 1);
});

test('si Zapp se reinicia con eventos pendientes, un procesador nuevo los termina', async () => {
  const { repo, h, fila } = montar({ getafe: apiFalsa([ficha()]) });
  await h('getafe', cifrar(evento('e1')));
  const tras = crearProcesador({ repo, apis: { getafe: apiFalsa([ficha()]) }, log }); // «arranque» nuevo, misma base
  await tras({ ahora: T0 });
  assert.equal(fila('e1').estado, 'hecho');
});

test('duplicados: se contestan 200 y no se vuelven a leer, ni pendientes ni ya hechos', async () => {
  const api = apiFalsa([ficha()]);
  const { repo, h, procesar } = montar({ getafe: api });
  assert.equal((await h('getafe', cifrar(evento('e1')))).duplicado, undefined);
  assert.equal((await h('getafe', cifrar(evento('e1')))).duplicado, true, 'reenvío con el evento aún pendiente');
  await procesar({ ahora: T0 });
  assert.equal((await h('getafe', cifrar(evento('e1')))).duplicado, true, 'reenvío con el evento ya hecho');
  await procesar({ ahora: T0 + 1000 });
  assert.equal(api.llamadas.length, 1);
  assert.equal(repo.db.prepare('SELECT count(*) n FROM aimharder_eventos').get().n, 1);
});

test('lectura fallida: se reintenta con espera y se recupera sin que AimHarder reenvíe nada', async () => {
  const api = apiFalsa([error(500), error(503), ficha()]);
  const { repo, h, procesar, fila } = montar({ getafe: api });
  await h('getafe', cifrar(evento('e1')));

  assert.deepEqual(await procesar({ ahora: T0 }), { hechos: 0, reintentos: 1, pausados: 0, fallidos: 0 });
  assert.equal(fila('e1').estado, 'pendiente');
  assert.equal(fila('e1').intentos, 1);
  assert.equal(fila('e1').proximo_ms, T0 + ESPERAS_S[0] * 1000);

  await procesar({ ahora: T0 + 30 * 1000 });
  assert.equal(api.llamadas.length, 1, 'antes de la espera no se vuelve a llamar');

  await procesar({ ahora: T0 + 61 * 1000 }); // segundo fallo
  assert.equal(fila('e1').intentos, 2);
  assert.equal(fila('e1').proximo_ms, T0 + 61 * 1000 + ESPERAS_S[1] * 1000);

  await procesar({ ahora: T0 + 61 * 1000 + 301 * 1000 }); // recupera
  assert.equal(fila('e1').estado, 'hecho');
  assert.equal(buscarSocioPorTelefono(repo, '622222222').esSocio, true);
});

test('agotados los intentos queda «fallido» (lo cubre la sincronización) y deja de llamar', async () => {
  const api = apiFalsa([error(500)]);
  const { h, procesar, fila } = montar({ getafe: api });
  await h('getafe', cifrar(evento('e1')));
  let t = T0;
  for (let i = 0; i <= ESPERAS_S.length; i++) { await procesar({ ahora: t }); t += (ESPERAS_S[i] || 0) * 1000 + 1000; }
  assert.equal(fila('e1').estado, 'fallido');
  assert.equal(fila('e1').intentos, ESPERAS_S.length + 1);
  const n = api.llamadas.length;
  await procesar({ ahora: t + 86400 * 1000 });
  assert.equal(api.llamadas.length, n);
});

test('429: la sede se pausa lo que diga Retry-After, no gasta intentos y no frena a las demás', async () => {
  const getafe = apiFalsa([error(429, 120), ficha(2), ficha(3)]);
  const parla = apiFalsa([ficha(9)]);
  const { repo, h, procesar, fila } = montar({ getafe, parla });
  await h('getafe', cifrar(evento('g1', 'CLIENT_CREATED', 2)));
  await h('getafe', cifrar(evento('g2', 'CLIENT_CREATED', 3)));
  await h('parla', cifrar(evento('p1', 'CLIENT_CREATED', 9)));

  const r = await procesar({ ahora: T0 });
  assert.equal(getafe.llamadas.length, 1, 'tras el 429 no se insiste con la sede en la misma pasada');
  assert.equal(parla.llamadas.length, 1);
  assert.equal(fila('p1').estado, 'hecho');
  assert.equal(fila('g1').intentos, 0);
  assert.equal(fila('g1').proximo_ms, T0 + 120 * 1000);
  assert.equal(r.pausados, 2);

  await procesar({ ahora: T0 + 60 * 1000 });
  assert.equal(getafe.llamadas.length, 1, 'sigue pausada');
  await procesar({ ahora: T0 + 121 * 1000 });
  assert.equal(fila('g1').estado, 'hecho');
  assert.equal(fila('g2').estado, 'hecho');
  assert.equal(buscarSocioPorTelefono(repo, '622222222').esSocio, true);
});

test('429: sin Retry-After se espera 1 min y un Retry-After enorme se limita a 1 h', async () => {
  const a = montar({ getafe: apiFalsa([error(429)]) });
  await a.h('getafe', cifrar(evento('e1')));
  await a.procesar({ ahora: T0 });
  assert.equal(a.fila('e1').proximo_ms, T0 + 60 * 1000);
  const b = montar({ getafe: apiFalsa([error(429, 999999)]) });
  await b.h('getafe', cifrar(evento('e1')));
  await b.procesar({ ahora: T0 });
  assert.equal(b.fila('e1').proximo_ms, T0 + 3600 * 1000);
});

test('varios eventos del mismo cliente cuestan una sola lectura', async () => {
  const api = apiFalsa([ficha()]);
  const { h, procesar, fila } = montar({ getafe: api });
  for (const [id, a] of [['e1', 'CLIENT_CREATED'], ['e2', 'MEMBERSHIP_ASSIGNED'], ['e3', 'MEMBERSHIP_ASSIGNED']]) await h('getafe', cifrar(evento(id, a)));
  assert.equal((await procesar({ ahora: T0 })).hechos, 3);
  assert.equal(api.llamadas.length, 1);
  assert.deepEqual(['e1', 'e2', 'e3'].map((i) => fila(i).estado), ['hecho', 'hecho', 'hecho']);
});

test('ficha inexistente (404) y eventos sin trabajo no se reintentan', async () => {
  const api = apiFalsa([error(404)]);
  const { h, procesar, fila } = montar({ getafe: api });
  await h('getafe', cifrar(evento('e1')));
  await h('getafe', cifrar({ id: 'e2', action: 'WEBHOOK_TEST', data: {} }));
  await h('getafe', cifrar({ id: 'e3', action: 'LEAD_CREATED', data: { client: { id: 5 } } }));
  assert.equal(fila('e2').estado, 'hecho');
  assert.equal(fila('e3').estado, 'hecho');
  await procesar({ ahora: T0 });
  assert.equal(fila('e1').estado, 'hecho');
  assert.equal(api.llamadas.length, 1);
});

test('el procesador no se solapa consigo mismo', async () => {
  let suelta; const espera = new Promise((r) => { suelta = r; });
  const api = { llamadas: [], cliente: async (id) => { api.llamadas.push(id); await espera; return ficha(); } };
  const { h, procesar } = montar({ getafe: api });
  await h('getafe', cifrar(evento('e1')));
  const primera = procesar({ ahora: T0 });
  assert.equal(await procesar({ ahora: T0 }), null);
  suelta(); await primera;
  assert.equal(api.llamadas.length, 1);
});

test('valida sede, clave y sobre; si no se puede guardar, contesta 500 para que AimHarder reintente', async () => {
  const { repo, h } = montar({ getafe: apiFalsa([ficha()]) });
  const hSinClave = manejadorWebhook({ repo, claves: { getafe: clavePem }, sedes: ['parla', 'getafe'], log });
  assert.equal((await hSinClave('parla', cifrar(evento('e1')))).status, 503);
  assert.equal((await h('otra', {})).status, 404);
  assert.equal((await h('getafe', { encryptedKey: 'x', iv: 'x', tag: 'x', payload: 'x' })).status, 400);
  const rota = { ...repo, registrarEventoAimharder: () => { throw new Error('disco lleno'); } };
  const hRota = manejadorWebhook({ repo: rota, claves: { getafe: clavePem }, sedes: ['getafe'], log });
  assert.equal((await hRota('getafe', cifrar(evento('e9')))).status, 500);
});

test('la API devuelve status y Retry-After en los errores', async () => {
  const fetchImpl = async () => ({ status: 429, ok: false, headers: new Map([['retry-after', '90']]), text: async () => 'demasiadas' });
  const api = new AimHarderApi({ access: 'x', fetchImpl });
  await assert.rejects(() => api.cliente(1), (e) => e.status === 429 && e.retryAfter === 90 && /429/.test(e.message));
  const sinCabecera = new AimHarderApi({ access: 'x', fetchImpl: async () => ({ status: 500, ok: false, text: async () => 'x' }) });
  await assert.rejects(() => sinCabecera.cliente(1), (e) => e.status === 500 && e.retryAfter === undefined);
});

test('migración: los eventos de la versión anterior (sin cola) quedan como hechos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapp-mig-'));
  const fichero = path.join(dir, 'viejo.db');
  const viejo = new Database(fichero);
  viejo.exec("CREATE TABLE aimharder_eventos (id TEXT PRIMARY KEY, sede TEXT NOT NULL, accion TEXT NOT NULL, recibido TEXT NOT NULL DEFAULT (datetime('now')))");
  viejo.prepare("INSERT INTO aimharder_eventos (id, sede, accion) VALUES ('antiguo', 'getafe', 'CLIENT_CREATED')").run();
  viejo.close();
  const repo = crearRepo(openDb(fichero));
  assert.equal(repo.db.prepare("SELECT estado FROM aimharder_eventos WHERE id = 'antiguo'").get().estado, 'hecho');
  assert.equal(repo.registrarEventoAimharder({ id: 'nuevo', sede: 'getafe', accion: 'CLIENT_CREATED', cliente_id: 1, ahora: T0 }), true);
  assert.deepEqual(repo.eventosAimharderPendientes(T0).map((f) => f.id), ['nuevo']);
  repo.db.close(); fs.rmSync(dir, { recursive: true, force: true });
});
