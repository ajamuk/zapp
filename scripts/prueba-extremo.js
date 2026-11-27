// Prueba de extremo a extremo antes de desplegar: arranca el servicio de verdad (src/index.js) contra un GHL de
// mentira, con una base temporal y el modelo real, y le manda webhooks con el formato del workflow de GHL.
// No toca GHL, AimHarder, Telegram ni la base de producción. Gasta unos céntimos de la API de Anthropic.
// Uso: ANTHROPIC_API_KEY=... npm run prueba-extremo     (sale con código 1 si algo falla)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { config } from '../src/config.js';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRETO = 'secreto-de-la-prueba-de-extremo-a-extremo';
const CONTACTO = 'contacto-e2e'; const CONV = 'conv-e2e'; const TELEFONO = '+34600111222';
// Número propio de Sofía (inventado) y cómo lo devuelve GHL en `to` / `from`; MODE=live exige el aislamiento
const NUMERO = '+34910000001'; const NUMERO_GHL = '+34 910 00 00 01'; const OTRO_GHL = '+34 910 00 00 02'; const LOC = 'loc-e2e';
const AISLADO = { SOFIA_WA_NUMERO: NUMERO, SOFIA_WA_LOCATION_ID: LOC };
/** Como la API real: cada mensaje lleva subcuenta, conversación y contacto, y los de WhatsApp, su línea (`to` / `from`). */
const comoGhl = (m) => ({ locationId: LOC, conversationId: CONV, contactId: CONTACTO,
  ...(m.messageType === 'TYPE_WHATSAPP' ? (m.direction === 'inbound' ? { to: NUMERO_GHL } : { from: NUMERO_GHL }) : {}), ...m });
const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));
const fallos = []; const hechos = [];
const comprobar = (ok, texto, detalle = '') => { (ok ? hechos : fallos).push(texto); console.log(`  ${ok ? '✔' : '✘'} ${texto}${!ok && detalle ? ` → ${detalle}` : ''}`); };

/**
 * Variables de integraciones reales, vacías para el servicio de la prueba. config.js completa con el .env del
 * repositorio lo que no venga definido; definidas como '' no se rellenan: así la prueba nunca avisa por Telegram,
 * ni sincroniza AimHarder, ni manda eventos a Meta, ni sube copias a Drive aunque haya un .env de producción.
 */
export function entornoSinIntegraciones(sedes = config.negocio.sedes.map((s) => s.id)) {
  const fijas = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_GENERAL', 'AIMHARDER_TOKEN_STORE', 'AIMHARDER_WEBHOOK_TOKEN', 'AIMHARDER_ADMIN_USER', 'AIMHARDER_ADMIN_PASSWORD',
    'META_PIXEL_ID', 'META_CAPI_TOKEN', 'META_TEST_EVENT_CODE', 'ELEVENLABS_API_KEY', 'COPIA_DRIVE_REMOTO', 'COPIA_DRIVE_RCLONE_CONFIG', 'ANTHROPIC_ADMIN_KEY',
    'CANAVERAL_REGISTRO', 'TRANSCRIPTOR_PYTHON', 'TRANSCRIPTOR_RESERVA', 'SOFIA_WA_NUMERO', 'SOFIA_WA_LOCATION_ID', 'SOFIA_WA_ADOPTAR_CHATS', 'SOFIA_WA_PLANTILLAS', 'SOFIA_IG_PAGE_ID'];
  const porSede = sedes.flatMap((s) => ['AIMHARDER_TOKEN_', 'AIMHARDER_REFRESH_', 'AIMHARDER_WEBHOOK_KEY_', 'TELEGRAM_CHAT_', 'EMBUDO_SOCIOS_']
    .map((p) => `${p}${s.toUpperCase()}`).concat(`AIMHARDER_WEBHOOK_KEY_${s.toUpperCase()}_FILE`));
  return Object.fromEntries([...fijas, ...porSede].map((k) => [k, '']));
}

// Importado desde las pruebas (test/), solo se usa la función de arriba
const principal = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (principal && !process.env.ANTHROPIC_API_KEY) { console.error('Falta ANTHROPIC_API_KEY.'); process.exit(1); }

/** GHL de mentira: guarda la conversación y apunta todo lo que el servicio le pide. */
function ghlFalso() {
  const e = { mensajes: [], enviados: [], notas: [], tags: [], otras: [], n: 0 };
  const ahora = (ms = 0) => new Date(Date.now() + ms).toISOString();
  e.entra = (texto, { copia = true, para = undefined } = {}) => {
    const id = `in${++e.n}`;
    if (copia) e.mensajes.push({ id: `${id}c`, direction: 'inbound', messageType: 'TYPE_CUSTOM_SMS', body: `${texto}\n\n💬Received on 34600000000`, source: 'api', dateAdded: ahora(-900) });
    e.mensajes.push({ id, direction: 'inbound', messageType: 'TYPE_WHATSAPP', body: texto, dateAdded: ahora(), ...(para ? { to: para } : {}) });
    // Después del nativo llega a veces otra copia: es lo último del chat (el caso que perdía mensajes)
    if (copia) e.mensajes.push({ id: `${id}d`, direction: 'outbound', messageType: 'TYPE_CUSTOM_SMS', body: 'copia vieja de otro mensaje \n \n💬Sent from 34600000000', source: 'api', userId: 'u-api', dateAdded: ahora(-600000) });
    return id;
  };
  e.equipo = (texto) => {
    const id = `eq${++e.n}`;
    e.mensajes.push({ id, direction: 'outbound', messageType: 'TYPE_WHATSAPP', body: texto, source: 'app', userId: 'u-equipo', dateAdded: ahora() });
    e.mensajes.push({ id: `${id}c`, direction: 'outbound', messageType: 'TYPE_CUSTOM_SMS', body: `${texto} \n \n💬Sent from 34600000000`, source: 'api', userId: 'u-equipo', dateAdded: ahora(900) });
  };
  // Mensaje automático de otro workflow de GHL (recordatorio, plantilla…), con su copia del conector
  e.workflow = (texto) => {
    const id = `wf${++e.n}`;
    e.mensajes.push({ id, direction: 'outbound', messageType: 'TYPE_WHATSAPP', body: texto, source: 'workflow', dateAdded: ahora() });
    e.mensajes.push({ id: `${id}c`, direction: 'outbound', messageType: 'TYPE_CUSTOM_SMS', body: `${texto} \n \n💬Sent from 34600000000`, source: 'api', userId: 'u-api', dateAdded: ahora(900) });
  };
  const srv = http.createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (d) => { cuerpo += d; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x'); const b = cuerpo ? JSON.parse(cuerpo) : {};
      const ok = (j) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
      const r = `${req.method} ${u.pathname}`;
      if (r === 'GET /conversations/search') return ok({ conversations: [{ id: CONV, lastMessageType: 'TYPE_CUSTOM_SMS' }] });
      if (r === `GET /conversations/${CONV}/messages`) return ok({ messages: { messages: [...e.mensajes].sort((a, c) => c.dateAdded.localeCompare(a.dateAdded)).slice(0, Number(u.searchParams.get('limit')) || 20).map(comoGhl) } });
      if (r === 'POST /conversations/messages') {
        const id = `out${++e.n}`;
        e.enviados.push(b);
        e.mensajes.push({ id, direction: 'outbound', messageType: 'TYPE_WHATSAPP', body: b.message || '', attachments: b.attachments || [], source: 'app', userId: 'u-api', dateAdded: ahora() });
        if (b.message) e.mensajes.push({ id: `${id}c`, direction: 'outbound', messageType: 'TYPE_CUSTOM_SMS', body: `${b.message} \n \n💬Sent from 34600000000`, source: 'api', userId: 'u-api', dateAdded: ahora(1500) });
        return ok({ conversationId: CONV, messageId: id });
      }
      if (r === `GET /contacts/${CONTACTO}`) return ok({ contact: { id: CONTACTO, phone: TELEFONO, tags: [] } });
      if (r === `POST /contacts/${CONTACTO}/notes`) { e.notas.push(b.body); return ok({ note: { id: `n${e.notas.length}` } }); }
      if (/^PUT \/contacts\/[^/]+\/notes\//.test(r)) { e.notas.push(b.body); return ok({}); }
      if (r === `POST /contacts/${CONTACTO}/tags`) { e.tags.push(...(b.tags || [])); return ok({ tags: e.tags }); }
      if (/\/tags$/.test(u.pathname) && req.method === 'GET') return ok({ tags: [] });
      if (/\/tags$/.test(u.pathname) && req.method === 'POST') return ok({ tag: { id: `t${++e.n}`, name: b.name } });
      if (/\/customFields/.test(u.pathname)) return ok({ customFields: [], customField: { id: 'cf1' } });
      e.otras.push(r);
      return ok({});
    });
  });
  return new Promise((listo) => srv.listen(0, '127.0.0.1', () => listo({ ...e, estado: e, url: `http://127.0.0.1:${srv.address().port}`, cerrar: () => srv.close() })));
}

async function escenario(nombre, { modo, telefonosPrueba = '', env = {} }, pasos) {
  console.log(`\n${nombre}`);
  const ghl = await ghlFalso(); const e = ghl.estado;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapp-e2e-'));
  const puerto = 3900 + Math.floor(Math.random() * 90);
  const registro = [];
  const hijo = spawn(process.execPath, ['src/index.js'], {
    cwd: raiz,
    env: {
      ...entornoSinIntegraciones(),
      PATH: process.env.PATH, HOME: process.env.HOME, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ...(process.env.AI_MODEL ? { AI_MODEL: process.env.AI_MODEL } : {}),
      PORT: String(puerto), DB_PATH: path.join(dir, 'setter.db'), MEDIA_DIR: path.join(dir, 'media'), PRUEBAS_DB_PATH: path.join(dir, 'pruebas.db'), MODE: modo, TEST_PHONES: telefonosPrueba,
      GHL_WEBHOOK_ENABLED: 'true', GHL_BASE_URL: ghl.url, GHL_TOKEN: 'token-falso', GHL_LOCATION_ID: LOC, WEBHOOK_SECRET: SECRETO, ADMIN_TOKEN: 'admin-de-la-prueba-de-extremo-a-extremo',
      AI_MIN_DELAY: '1', AI_MAX_DELAY: '2', AI_TYPING_SPEED: '20', AI_TYPING_MAX: '1', AI_HORA_INICIO: '0', AI_HORA_FIN: '0',
      TRIAL_OPS_DB: path.join(dir, 'no-existe.sqlite3'), EMBUDO_PRUEBAS_DIR: dir, AIMHARDER_ALTA_DRY_RUN: 'true', AIMHARDER_RESERVA_PRUEBA: 'false', ...env,
    },
  });
  hijo.stdout.on('data', (d) => registro.push(String(d)));
  hijo.stderr.on('data', (d) => registro.push(String(d)));
  const base = `http://127.0.0.1:${puerto}`;
  const webhook = (texto, cabeceras = { 'x-setter-secret': SECRETO }) => fetch(`${base}/webhooks/ghl`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...cabeceras },
    body: JSON.stringify({ contact_id: CONTACTO, first_name: 'Ana', last_name: 'Prueba', full_name: 'Ana Prueba', phone: TELEFONO, tags: '', message: { type: 19, body: texto }, location: { id: 'loc-e2e' }, workflow: { id: 'w', name: 'Sofía · Mensaje entrante' } }),
  });
  const db = () => new Database(path.join(dir, 'setter.db'), { readonly: true });
  const consulta = (sql, ...p) => { const d = db(); try { return d.prepare(sql).all(...p); } finally { d.close(); } };
  const conv = () => consulta('SELECT * FROM conversations WHERE id = ?', CONV)[0];
  /** Espera a que Sofía termine: hay algo enviado (o una nota de borrador) y lleva `quieto` ms sin nada nuevo ni respuesta en cola. */
  const hastaQueTermine = async ({ desde = 0, maxMs = 90000, quieto = 5000, notas = false } = {}) => {
    const fin = Date.now() + maxMs; let ultimo = -1; let cambio = Date.now();
    while (Date.now() < fin) {
      await dormir(500);
      const n = notas ? e.notas.filter((x) => x.startsWith('[Borrador IA')).length : e.enviados.length;
      if (n !== ultimo) { ultimo = n; cambio = Date.now(); }
      const c = conv();
      if (n > desde && Date.now() - cambio > quieto && !c?.respond_at && !c?.respondiendo_desde) return true;
    }
    return false;
  };
  try {
    let arriba = false;
    for (let i = 0; i < 40 && !arriba; i++) { await dormir(250); arriba = await fetch(`${base}/health`).then((r) => r.ok).catch(() => false); }
    comprobar(arriba, 'el servicio arranca y /health responde');
    if (arriba) await pasos({ ghl, e, webhook, consulta, conv, hastaQueTermine, base });
  } catch (err) {
    comprobar(false, `el escenario termina sin excepciones`, err.stack || err.message);
  } finally {
    hijo.kill('SIGTERM');
    await new Promise((ok) => { hijo.on('exit', ok); setTimeout(ok, 30000); });
    ghl.cerrar();
    const errores = registro.join('').split('\n').filter((l) => /Error respondiendo|\[promesa sin capturar\]|\[error no capturado\]|^Webhook:|TypeError|ReferenceError|SqliteError/.test(l));
    comprobar(errores.length === 0, 'sin errores en el registro del servicio', errores.slice(0, 3).join(' | '));
    if (fallos.length && process.env.E2E_VERBOSE) console.log(registro.join(''));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (principal) {
  // ---------- 1. Modo real: ráfaga, duplicados, respuesta única y el equipo que contesta ----------
  await escenario('1. Modo live (aislado en el número propio): ráfaga con copias del conector, webhook repetido y respuesta del equipo', { modo: 'live', env: AISLADO }, async ({ e, webhook, consulta, conv, hastaQueTermine }) => {
    comprobar((await webhook('hola', {})).status === 401, 'el webhook sin secreto se rechaza (401)');
    comprobar((await webhook('hola', { 'x-setter-secret': '' })).status === 401, 'el webhook con secreto vacío se rechaza (401)');
    e.entra('hola');
    comprobar((await webhook('hola')).status === 200, 'el webhook con secreto se acepta (200)');
    // Mientras GHL «procesa» el primero, llega otro del que no avisa
    e.entra('cuánto cuesta Academy en Getafe?');
    comprobar(await hastaQueTermine(), 'Sofía contesta');
    const leads = () => consulta("SELECT texto, external_id FROM messages WHERE conversation_id = ? AND autor = 'lead' ORDER BY id", CONV);
    comprobar(leads().length === 2 && leads().every((m) => /^in\d+$/.test(m.external_id || '')), 'entran los dos mensajes del lead, una vez cada uno y con su id de GHL', JSON.stringify(leads()));
    const turnos = consulta("SELECT count(*) n FROM conversations WHERE id = ? AND ultimo_turno IS NOT NULL", CONV)[0].n;
    const textos = e.enviados.filter((m) => m.message && !m.attachments?.length);
    comprobar(textos.length >= 1 && textos.length <= 4, `la respuesta sale en 1 a 4 burbujas (${textos.length})`);
    comprobar(e.enviados.every((m) => m.type === 'WhatsApp' && m.contactId === CONTACTO), 'todo sale por WhatsApp al contacto correcto');
    comprobar(e.enviados.every((m) => m.fromNumber === NUMERO), 'todo sale con el número propio como emisor');
    comprobar(e.enviados.filter((m) => m.attachments?.length).every((m) => m.message), 'los archivos llevan texto (sin él, WhatsApp los rechaza)');
    comprobar(new Set(textos.map((m) => m.message)).size === textos.length, 'ninguna burbuja repetida');
    comprobar(/getafe/i.test(textos.map((m) => m.message).join(' ')), 'la respuesta tiene en cuenta el segundo mensaje (Getafe)', textos.map((m) => m.message).join(' / '));
    comprobar(turnos === 1 && conv().channel === 'whatsapp' && !conv().ai_paused, 'el chat queda como WhatsApp y sin pausar');
    comprobar(consulta("SELECT count(*) n FROM messages WHERE conversation_id = ? AND autor = 'humano'", CONV)[0].n === 0, 'ni sus mensajes ni las copias del conector se toman por el equipo');
    comprobar(conv().sede === 'getafe', 'el chat queda con la sede (Getafe)', String(conv().sede));

    // Webhook repetido de un mensaje ya registrado
    const antes = e.enviados.length;
    await webhook('cuánto cuesta Academy en Getafe?');
    await dormir(9000);
    comprobar(leads().length === 2 && e.enviados.length === antes, 'un webhook repetido no duplica el mensaje ni provoca otra respuesta');

    // Otro workflow de GHL le manda un mensaje automático y el lead sigue: Sofía no se aparta
    e.workflow('Recordatorio automático: tienes pendiente confirmar tu cita');
    e.entra('y qué horarios hay por la tarde?');
    await webhook('y qué horarios hay por la tarde?');
    comprobar(await hastaQueTermine({ desde: antes }), 'tras un mensaje automático de otro workflow, Sofía sigue contestando');
    comprobar(!conv().ai_paused && consulta("SELECT count(*) n FROM messages WHERE conversation_id = ? AND autor = 'humano'", CONV)[0].n === 0, 'el mensaje automático y su copia no se toman por el equipo');
    comprobar(e.enviados.filter((m) => m.attachments?.length).every((m) => m.message), 'los archivos (tarifas, horarios) llevan texto');
    const antes2 = e.enviados.length;

    // El equipo contesta desde GHL y el lead sigue: Sofía se aparta
    e.equipo('Hola Ana, soy Carlos, te llamo en 5 minutos');
    e.entra('vale, perfecto');
    await webhook('vale, perfecto');
    await dormir(12000);
    const humanos = consulta("SELECT texto FROM messages WHERE conversation_id = ? AND autor = 'humano'", CONV);
    comprobar(humanos.length === 1, 'el mensaje del equipo queda registrado una sola vez (sin su copia)', JSON.stringify(humanos));
    comprobar(conv().ai_paused === 1 && e.enviados.length === antes2, 'Sofía se aparta y no escribe después de que conteste el equipo', `pausa=${conv().ai_paused} enviados=${e.enviados.length - antes2}`);
  });

  // ---------- 1b. Modo real sin aislamiento, y WhatsApp a otro número: Sofía no actúa (no se llama al modelo) ----------
  const nada = async ({ e, webhook, conv }, texto, opciones) => {
    e.entra(texto, opciones);
    comprobar((await webhook(texto)).status === 200, 'el webhook se acepta (200)');
    await dormir(12000);
    comprobar(e.enviados.length === 0 && e.notas.length === 0 && e.tags.length === 0, 'no se envía nada ni se toca el contacto', `enviados=${e.enviados.length} notas=${e.notas.length} tags=${e.tags.length}`);
    comprobar(!conv(), 'no se crea el chat');
  };
  await escenario('1b. Modo live SIN aislamiento: el servicio no actúa', { modo: 'live' }, (x) => nada(x, 'hola, quería información'));
  await escenario('1c. Modo live aislado: un WhatsApp a otro número no se atiende', { modo: 'live', env: AISLADO }, (x) => nada(x, 'hola, esto iba para el otro número', { para: OTRO_GHL }));

  // ---------- 2. Modo prueba: nada sale hacia el lead ----------
  await escenario('2. Modo shadow: solo deja notas', { modo: 'shadow' }, async ({ e, webhook, conv, hastaQueTermine }) => {
    e.entra('hola, quería información de Parla');
    await webhook('hola, quería información de Parla');
    comprobar(await hastaQueTermine({ notas: true }), 'Sofía deja su borrador como nota interna');
    comprobar(e.enviados.length === 0, 'no se envía ningún mensaje al lead', `${e.enviados.length} enviados`);
    // El equipo contesta: en modo prueba Sofía no se aparta y sigue dejando borradores
    e.equipo('Hola Ana, te cuento');
    e.entra('genial, y los horarios?');
    const antes = e.notas.filter((x) => x.startsWith('[Borrador IA')).length;
    await webhook('genial, y los horarios?');
    comprobar(await hastaQueTermine({ notas: true, desde: antes }), 'tras contestar el equipo, Sofía sigue dejando borrador');
    comprobar(e.enviados.length === 0 && !conv().ai_paused, 'sigue sin enviar nada y sin pausarse');
  });

  // ---------- 3. Modo prueba con teléfono de prueba: a ese sí se le contesta ----------
  await escenario('3. Modo shadow con TEST_PHONES: al teléfono de prueba se le contesta de verdad', { modo: 'shadow', telefonosPrueba: TELEFONO }, async ({ e, webhook, consulta, conv, hastaQueTermine }) => {
    e.entra('hola');
    await webhook('hola');
    comprobar(await hastaQueTermine(), 'Sofía contesta al teléfono de prueba');
    comprobar(e.enviados.length >= 1 && !e.notas.some((x) => x.startsWith('[Borrador IA')), 'la respuesta sale como mensaje y no como borrador');

    // #reset desde el teléfono de prueba: borra la conversación y avisa
    const antes = e.enviados.length;
    e.entra('#reset');
    await webhook('#reset');
    await dormir(6000);
    const leads = () => consulta("SELECT texto FROM messages WHERE conversation_id = ? AND autor IN ('lead', 'ia', 'humano') ORDER BY id", CONV);
    comprobar(e.enviados.length === antes + 1 && /reiniciada/.test(e.enviados.at(-1).message), '#reset contesta con la confirmación (un solo mensaje)', JSON.stringify(e.enviados.slice(antes).map((m) => m.message)));
    comprobar(leads().length === 0 && conv() && !conv().ai_paused && !conv().respond_at, 'la conversación queda vacía, sin pausa y sin respuesta pendiente', JSON.stringify(leads()));
    e.entra('hola otra vez');
    await webhook('hola otra vez');
    comprobar(await hastaQueTermine({ desde: antes + 1 }), 'tras el reinicio, Sofía contesta al siguiente mensaje');
    const h = leads().map((m) => m.texto);
    comprobar(h[0] === 'hola otra vez' && !h.includes('hola') && !conv().ai_paused, 'empieza de cero: lo anterior no vuelve a entrar y no se pausa', JSON.stringify(h));
  });

  console.log(`\n${hechos.length} comprobaciones correctas, ${fallos.length} fallidas.`);
  if (fallos.length) { console.log('Fallos:\n' + fallos.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
}
