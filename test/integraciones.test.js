// Pruebas de las correcciones de integraciones y datos: seguimientos fuera de horario, clientes de AimHarder,
// alertas, notas de voz, poda, transcripción, errores de GHL y la prueba de extremo a extremo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, repo as crearRepo, podar } from '../src/db.js';
import { config } from '../src/config.js';
import { Setter } from '../src/setter.js';
import { procesarSeguimientos, huecoTrasApertura, horaMadrid } from '../src/followups.js';
import { AimHarderApi } from '../src/aimharder/api.js';
import { clientesApi, olvidarClientesApi, guardarTokenSede, leerTokensGuardados, sincronizarSocios, SEDES } from '../src/aimharder/index.js';
import { hoyDdMmYyyy } from '../src/aimharder/alta-navegador.js';
import * as alertas from '../src/alertas.js';
import { decidirVoz, uso as usoVoz, ajustesVoz } from '../src/voz.js';
import { entornoMinimo, transcribir } from '../src/medios.js';
import { Ghl } from '../src/ghl.js';
import { rangoMes } from '../src/embudo.js';
import * as etq from '../src/etiquetas.js';
import { entornoSinIntegraciones } from '../scripts/prueba-extremo.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zint-'));
const NOCHE = new Date('2026-11-17T02:00:00Z'); // martes 3:00 en Madrid (Sofía abre a las 8:00)
const APERTURA = '2026-11-17T07:00:00.000Z';

function montarNoche() {
  const repo = crearRepo(openDb(':memory:'));
  repo.guardarAjuste('intensidadSeguimientos', 'intensa');
  const llamadas = { ghl: 0, socio: 0 };
  let reloj = new Date(NOCHE);
  const setter = new Setter({
    repo, live: true, sleep: async () => {}, now: () => reloj, random: () => 0,
    ghl: { mensajes: async () => { llamadas.ghl++; return []; }, sendMessage: async () => ({ messageId: 'm' }), addTags: async () => {}, removeTags: async () => {}, assign: async () => {}, addNote: async () => {}, getContact: async () => ({ contact: {} }) },
    aimharder: { buscarSocioPorTelefono: async () => { llamadas.socio++; return { esSocio: false }; } },
    complete: async () => { throw new Error('no debe llamar a la IA'); },
  });
  for (const id of ['a', 'b', 'c', 'd']) {
    repo.upsertConv({ id, contact_id: `k${id}`, channel: 'whatsapp', telefono: '+34600000000' });
    repo.updateConv(id, { tipo: 'captacion', last_inbound_at: new Date(NOCHE.getTime() - 3600e3).toISOString() });
  }
  return { repo, setter, llamadas, avanzar: (ms) => { reloj = new Date(reloj.getTime() + ms); } };
}
const pendientesDe = (repo, regla) => repo.db.prepare("SELECT due_at FROM scheduled WHERE estado = 'pendiente' AND regla_id = ? ORDER BY due_at").all(regla).map((r) => r.due_at);

test('seguimientos fuera de horario: pasan a la apertura sin repasar GHL ni AimHarder, uno cada 20 s también entre vueltas', async () => {
  const { repo, setter, llamadas, avanzar } = montarNoche();
  repo.schedule('a', 'lanzamiento-1', new Date(NOCHE.getTime() - 40000).toISOString(), { lanzamiento: 1 }, 'lanzamiento', 'oferta');
  repo.schedule('b', 'lanzamiento-1', new Date(NOCHE.getTime() - 20000).toISOString(), { lanzamiento: 1 }, 'lanzamiento', 'oferta');
  await procesarSeguimientos(setter);
  // Vuelta siguiente: dos más del mismo lanzamiento y un seguimiento normal
  repo.schedule('c', 'lanzamiento-1', NOCHE.toISOString(), { lanzamiento: 1 }, 'lanzamiento', 'oferta');
  repo.schedule('d', 'comercial-5h', NOCHE.toISOString(), null, 'silencio');
  avanzar(60000);
  await procesarSeguimientos(setter);
  assert.deepEqual(llamadas, { ghl: 0, socio: 0 });
  const todas = repo.db.prepare("SELECT due_at FROM scheduled WHERE estado = 'pendiente' ORDER BY due_at").all().map((r) => r.due_at);
  assert.deepEqual(todas, [APERTURA, '2026-11-17T07:00:20.000Z', '2026-11-17T07:00:40.000Z', '2026-11-17T07:01:00.000Z']);
  assert.equal(pendientesDe(repo, 'lanzamiento-1').length, 3);
  // Lo que se sabe sin salir de la base se omite ya (IA pausada en ese chat)
  repo.updateConv('a', { ai_paused: 1 });
  repo.schedule('a', 'comercial-5h', NOCHE.toISOString(), null, 'silencio');
  await procesarSeguimientos(setter);
  assert.equal(repo.db.prepare("SELECT detalle FROM scheduled WHERE conversation_id = 'a' AND regla_id = 'comercial-5h'").get().detalle, 'IA pausada o derivada');
});

test('hueco tras la apertura: no cuenta los seguimientos que no están en la rejilla de 20 s', () => {
  const repo = crearRepo(openDb(':memory:'));
  repo.upsertConv({ id: 'x', contact_id: 'k', channel: 'whatsapp' });
  const ap = new Date(APERTURA);
  assert.equal(huecoTrasApertura(repo.db, ap).toISOString(), APERTURA);
  repo.schedule('x', 'r', new Date(ap.getTime() + 7000).toISOString()); // a su hora, no aplazado
  assert.equal(huecoTrasApertura(repo.db, ap).toISOString(), APERTURA);
  repo.schedule('x', 'r', APERTURA);
  assert.equal(huecoTrasApertura(repo.db, ap).toISOString(), '2026-11-17T07:00:20.000Z');
});

test('seguimientos: cada vuelta tiene un tope de tiempo real; lo demás espera a la siguiente', async () => {
  const { repo, setter } = montarNoche();
  for (const id of ['a', 'b', 'c']) repo.schedule(id, 'comercial-5h', NOCHE.toISOString(), null, 'silencio');
  let t = 0;
  await procesarSeguimientos(setter, { presupuestoMs: 90000, reloj: () => (t += 60000) });
  assert.equal(repo.db.prepare("SELECT count(*) n FROM scheduled WHERE estado = 'cancelado'").get().n, 1);
  assert.equal(repo.db.prepare("SELECT count(*) n FROM scheduled WHERE estado = 'pendiente' AND due_at = ?").get(NOCHE.toISOString()).n, 2);
});

test('hora del negocio: las fechas de la prueba y del recibo siguen BUSINESS_TZ', () => {
  assert.equal(horaMadrid('2026-07-01 19:00', 'America/New_York').toISOString(), '2026-07-01T23:00:00.000Z');
  assert.equal(hoyDdMmYyyy(new Date('2026-11-21T03:00:00Z'), 'America/New_York'), '20/11/2026');
  const antes = config.tz;
  try { config.tz = 'America/New_York'; assert.equal(rangoMes('2026-12').desde.toISOString(), '2026-12-01T05:00:00.000Z'); }
  finally { config.tz = antes; }
  assert.equal(rangoMes('2026-12').desde.toISOString(), '2026-11-30T23:00:00.000Z');
});

// ---------- AimHarder ----------

test('AimHarder: dos peticiones que caducan a la vez esperan a una sola renovación', async () => {
  let renovaciones = 0; const guardadas = [];
  const fetchImpl = async (url, opts) => {
    if (url.includes('/auth/tokens/refresh')) {
      renovaciones++;
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, status: 200, json: async () => ({ data: { 'access-token': 'nuevo', 'refresh-token': 'r2' } }) };
    }
    const st = opts.headers.Authorization === 'Bearer nuevo' ? 200 : 410;
    return { status: st, ok: st === 200, text: async () => '{"data":[1]}' };
  };
  const api = new AimHarderApi({ access: 'viejo', refresh: 'r1', fetchImpl, onRefresh: (a, r) => guardadas.push([a, r]) });
  const [x, y] = await Promise.all([api.req('GET', '/a'), api.req('GET', '/b')]);
  assert.deepEqual([x, y], [{ data: [1] }, { data: [1] }]);
  assert.equal(renovaciones, 1);
  assert.deepEqual(guardadas, [['nuevo', 'r2']]);
  // Si el fichero ya tiene una pareja más nueva (otro proceso la renovó), se usa esa sin renovar
  const otra = new AimHarderApi({ access: 'viejo', refresh: 'r1', fetchImpl, leerGuardado: () => ({ access: 'nuevo', refresh: 'r2' }) });
  assert.deepEqual(await otra.req('GET', '/c'), { data: [1] });
  assert.equal(renovaciones, 1);
});

test('AimHarder: un 2xx que no es JSON es un error; uno vacío no', async () => {
  const html = new AimHarderApi({ access: 'x', fetchImpl: async () => ({ status: 200, ok: true, text: async () => '<html>mantenimiento</html>' }) });
  await assert.rejects(() => html.reservarInvitado({}), /sin JSON/);
  const vacio = new AimHarderApi({ access: 'x', fetchImpl: async () => ({ status: 200, ok: true, text: async () => '' }) });
  assert.equal(await vacio.req('POST', '/x'), '');
});

test('AimHarder: un solo cliente por sede y el fichero de tokens se mezcla por sede', async () => {
  const dir = tmp(); const fichero = path.join(dir, 'tokens.json');
  const sede = SEDES[0];
  const antes = { store: config.aimharder.tokenStore, tokens: config.aimharder.tokens[sede] };
  try {
    config.aimharder.tokenStore = '';
    config.aimharder.tokens[sede] = { access: 'a1', refresh: 'r1' };
    olvidarClientesApi();
    fs.writeFileSync(fichero, JSON.stringify({ otra: { access: 'o', refresh: 'or' } }));
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: { 'access-token': 'a2', 'refresh-token': 'r2' } }) });
    const api = clientesApi({ fichero, fetchImpl })[sede];
    assert.equal(clientesApi({ fichero })[sede], api); // la misma instancia para todo el proceso
    await api.renovar();
    assert.deepEqual(leerTokensGuardados(fichero), { otra: { access: 'o', refresh: 'or' }, [sede]: { access: 'a2', refresh: 'r2' } });
    guardarTokenSede('tercera', { access: 't', refresh: 'tr' }, fichero);
    assert.deepEqual(Object.keys(leerTokensGuardados(fichero)).sort(), ['otra', sede, 'tercera'].sort());
    if (process.platform !== 'win32') assert.equal(fs.statSync(fichero).mode & 0o777, 0o600);
  } finally {
    config.aimharder.tokenStore = antes.store; config.aimharder.tokens[sede] = antes.tokens; olvidarClientesApi();
  }
});

test('socios: una sede que falla no deja sin sincronizar a las demás', async () => {
  const repo = crearRepo(openDb(':memory:'));
  const apis = {
    mala: { clientes: async () => { throw new Error('AimHarder GET /clients → 429: espera'); } },
    buena: { clientes: async () => [{ id: 1, name: 'Ana', mobile_number: '600111222', current_memberships: [{ membership_name: 'M' }] }] },
  };
  await assert.rejects(() => sincronizarSocios(repo, apis), (e) => /429/.test(e.message) && e.resumen.buena.socios === 1);
  assert.equal(repo.sociosPorTelefono('600111222').length, 1);
});

// ---------- Alertas ----------

test('alertas: «no llegan mensajes» con umbral configurable (0 = apagada)', async () => {
  const db = openDb(':memory:');
  const mediodia = new Date('2026-11-17T11:00:00Z');
  const sin = async (horas) => (await alertas.vigilar(db, { ahora: mediodia, tokenStore: '', entradaGhl: true, disco: ':memory:', sinMensajesHoras: horas })).find((x) => x.clave === 'sin-mensajes');
  assert.equal((await sin(6)).ok, false);
  assert.equal((await sin(0)).ok, true);
});

test('alertas: un problema que va y viene no vuelve a avisar por Telegram dentro del plazo', () => {
  const db = openDb(':memory:'); const avisos = [];
  const avisar = (t) => avisos.push(t);
  alertas.registrar(db, { clave: 'x', tipo: 'ghl', titulo: 'GHL caído' }, { avisar, reavisoHoras: 3 });
  alertas.resolver(db, 'x');
  assert.equal(alertas.registrar(db, { clave: 'x', tipo: 'ghl', titulo: 'GHL caído' }, { avisar, reavisoHoras: 3 }).nueva, true);
  assert.equal(avisos.length, 1);
  alertas.resolver(db, 'x');
  alertas.registrar(db, { clave: 'x', tipo: 'ghl', titulo: 'GHL caído' }, { avisar, reavisoHoras: 0 });
  assert.equal(avisos.length, 2);
});

// ---------- Notas de voz ----------

test('voz: el uso del mes solo se consulta si pasan las normas baratas, y cuenta desde el día 1 (UTC)', () => {
  let consultas = 0;
  const usoDe = () => { consultas++; return { enviadasConv: 0, caracteresMes: 0 }; };
  const base = { ajustes: ajustesVoz({ activo: true }), canal: 'whatsapp', clave: 'k', vozId: 'v', ultimoLeadAudio: true, mensajes: ['hola'], usoDe };
  assert.equal(decidirVoz({ ...base, esPrueba: false }).motivo, 'solo teléfonos de prueba');
  assert.equal(consultas, 0);
  assert.equal(decidirVoz({ ...base, esPrueba: true }).voz, true);
  assert.equal(consultas, 1);
  const repo = crearRepo(openDb(':memory:'));
  repo.addMessage({ conversation_id: 'c', autor: 'ia', texto: 'abc', media_ruta: 'voz/a.ogg', created_at: '2026-10-31T23:59:59.000Z' });
  repo.addMessage({ conversation_id: 'c', autor: 'ia', texto: 'hola', media_ruta: 'voz/b.ogg', created_at: '2026-11-01T00:00:00.000Z' });
  assert.deepEqual(usoVoz(repo.db, 'c', new Date('2026-11-15T10:00:00Z')), { caracteresMes: 4, enviadasConv: 2 });
});

// ---------- Inactividad ----------

test('inactividad: solo mira los chats con un mensaje nuestro dentro del plazo', async () => {
  const db = openDb(':memory:'); const repo = crearRepo(db);
  const ahora = new Date('2026-11-17T11:00:00Z');
  const e = new etq.Etiquetador({ repo, now: () => ahora });
  const sin = etq.crear(db, { nombre: 'No contesta', reglas: [{ tipo: 'inactividad', horas: 24 }] });
  const hace = (h) => new Date(ahora.getTime() - h * 3600e3).toISOString();
  for (const [id, autor, h] of [['dentro', 'ia', 30], ['reciente', 'ia', 2], ['contesto', 'lead', 30], ['viejo', 'humano', 24 * 10]]) {
    repo.upsertConv({ id, contact_id: `k-${id}`, channel: 'whatsapp' });
    repo.addMessage({ conversation_id: id, autor, texto: 'x', created_at: hace(h) });
  }
  assert.equal(await e.revisarInactividad(), 1);
  assert.deepEqual(db.prepare('SELECT conversation_id FROM conv_etiquetas WHERE etiqueta_id = ?').all(sin.id).map((r) => r.conversation_id), ['dentro']);
});

// ---------- Poda ----------

test('poda: capturas, notas de voz, alertas resueltas y batería viejas; nunca mensajes ni medios de leads', () => {
  const dir = tmp(); const media = path.join(dir, 'media');
  fs.mkdirSync(path.join(media, 'voz'), { recursive: true }); fs.mkdirSync(path.join(media, '2026-01'), { recursive: true });
  const ahora = new Date('2026-11-17T11:00:00Z');
  const viejo = (f, dias) => { fs.writeFileSync(f, 'x'); const t = new Date(ahora.getTime() - dias * 864e5); fs.utimesSync(f, t, t); };
  viejo(path.join(dir, 'alta-error-1.png'), 20); viejo(path.join(dir, 'alta-error-2.png'), 1); viejo(path.join(dir, 'otra.png'), 400);
  viejo(path.join(media, 'voz', 'a.ogg'), 61); viejo(path.join(media, 'voz', 'b.ogg'), 5); viejo(path.join(media, '2026-01', 'lead.jpg'), 400);
  const db = openDb(':memory:'); const repo = crearRepo(db);
  repo.addMessage({ conversation_id: 'c', autor: 'lead', texto: 'hola', created_at: '2025-01-01T00:00:00.000Z' });
  db.prepare("INSERT INTO alertas (clave, tipo, titulo, primera, resuelta_at) VALUES ('a', 'x', 't', '2026-01-01 00:00:00', '2026-01-02 00:00:00'), ('b', 'x', 't', '2026-11-01 00:00:00', '2026-11-10 00:00:00')").run();
  db.prepare("INSERT INTO alertas (clave, tipo, titulo, primera) VALUES ('abierta', 'x', 't', '2025-01-01 00:00:00')").run();
  db.prepare("INSERT INTO bateria_resultados (pasada_id, caso_id, repeticion, pasa, created_at) VALUES (1, 'c', 1, 1, '2026-01-01 00:00:00'), (1, 'c', 2, 1, '2026-11-01 00:00:00')").run();
  assert.deepEqual(podar({ db, dataDir: dir, mediaDir: media, ahora, dias: { capturas: 0, voz: 0, alertas: 0, bateria: 0 } }), { capturas: 0, voz: 0, alertas: 0, bateria: 0 });
  assert.deepEqual(podar({ db, dataDir: dir, mediaDir: media, ahora, dias: { capturas: 14, voz: 60, alertas: 90, bateria: 180 } }), { capturas: 1, voz: 1, alertas: 1, bateria: 1 });
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort(), ['alta-error-2.png', 'otra.png']);
  assert.deepEqual(fs.readdirSync(path.join(media, 'voz')), ['b.ogg']);
  assert.ok(fs.existsSync(path.join(media, '2026-01', 'lead.jpg')));
  assert.equal(db.prepare('SELECT count(*) n FROM messages').get().n, 1);
  assert.deepEqual(db.prepare('SELECT clave FROM alertas ORDER BY clave').all().map((r) => r.clave), ['abierta', 'b']);
});

// ---------- Transcripción, GHL y prueba de extremo a extremo ----------

test('transcripción: entorno sin claves del servicio, y sin reserva si se agotó el tiempo', async () => {
  const env = entornoMinimo({ PATH: '/bin', HOME: '/h', GHL_TOKEN: 'g', ANTHROPIC_API_KEY: 'a', TELEGRAM_BOT_TOKEN: 't', TRANSCRIPTOR_MODELO: 'small', HF_HOME: '/hf' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', TRANSCRIPTOR_MODELO: 'small', HF_HOME: '/hf' });
  const antes = { ...config.media };
  try {
    Object.assign(config.media, { python: process.execPath, reserva: process.execPath });
    const llamadas = [];
    const lento = async (cmd) => { llamadas.push(cmd); const e = new Error('killed'); e.tiempoAgotado = true; throw e; };
    await assert.rejects(() => transcribir('/tmp/x.ogg', { ejecutarImpl: lento }), /demasiado/);
    assert.equal(llamadas.length, 1);
    const falla = async (cmd, args) => { llamadas.push(cmd); if (args[0] === '-I') throw new Error('sin faster-whisper'); return 'hola'; };
    assert.equal(await transcribir('/tmp/x.ogg', { ejecutarImpl: falla }), 'hola'); // otro fallo: sí va a la reserva
  } finally { Object.assign(config.media, antes); }
});

test('GHL: un error con página HTML no se guarda entero', async () => {
  const ghl = new Ghl({ token: 't', baseUrl: 'https://ghl.test', aislamiento: { modo: 'apagado' }, fetchImpl: async () => ({ ok: false, status: 502, headers: new Map(), text: async () => `<html>${'x'.repeat(5000)}</html>` }) });
  await assert.rejects(() => ghl.sendMessage({ contactId: 'k', canal: 'whatsapp', texto: 'hola' }), (e) => /502/.test(e.message) && e.message.length < 400);
});

test('prueba de extremo a extremo: las integraciones reales quedan vacías para el servicio de la prueba', () => {
  const env = entornoSinIntegraciones(['parla', 'las_rosas']);
  for (const k of ['TELEGRAM_BOT_TOKEN', 'AIMHARDER_TOKEN_STORE', 'AIMHARDER_TOKEN_PARLA', 'AIMHARDER_REFRESH_LAS_ROSAS', 'META_CAPI_TOKEN', 'COPIA_DRIVE_REMOTO', 'ELEVENLABS_API_KEY', 'AIMHARDER_ADMIN_PASSWORD', 'SOFIA_WA_NUMERO']) assert.equal(env[k], '', k);
  assert.ok(Object.values(env).every((v) => v === ''));
});
