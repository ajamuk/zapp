// Comprueba la conexión con GoHighLevel antes de activar la entrada de webhooks.
// Uso (en el VPS, con el .env cargado): npm run comprobar-ghl
// Solo lee: no envía mensajes ni toca contactos.
import { config } from '../src/config.js';
import { Ghl } from '../src/ghl.js';
import { knowledge } from '../src/knowledge.js';

const ok = (t) => console.log(`  ✔ ${t}`);
const mal = (t) => { console.log(`  ✘ ${t}`); fallos++; };
const aviso = (t) => console.log(`  · ${t}`);
let fallos = 0;

console.log('\nConfiguración');
for (const [k, v] of Object.entries({ GHL_TOKEN: config.ghl.token, GHL_LOCATION_ID: config.ghl.locationId, WEBHOOK_SECRET: config.webhookSecret, ADMIN_TOKEN: config.adminToken })) {
  if (v) ok(`${k} definido`); else mal(`${k} vacío`);
}
if (config.webhookSecret && config.webhookSecret.length < 24) mal('WEBHOOK_SECRET demasiado corto (usa 32+ caracteres aleatorios)');
aviso(`MODE=${config.mode}${config.mode === 'live' ? '  ← Sofía ENVÍA mensajes' : ' (borradores como notas en GHL)'}`);
aviso(`GHL_WEBHOOK_ENABLED=${config.ghlWebhookEnabled}`);

if (!config.ghl.token || !config.ghl.locationId) {
  console.log('\nSin token o subcuenta no se puede seguir.\n');
  process.exit(1);
}

const ghl = new Ghl();
const probar = async (titulo, fn) => {
  try { return await fn(); } catch (e) { mal(`${titulo}: ${e.message.slice(0, 300)}`); return null; }
};

console.log('\nSubcuenta');
const loc = await probar('leer la subcuenta', () => ghl.req('GET', `/locations/${config.ghl.locationId}`));
if (loc) ok(`${loc.location?.name || config.ghl.locationId} · zona horaria ${loc.location?.timezone || '?'}`);

console.log('\nPermisos del token');
const conv = await probar('conversaciones (leer)', () => ghl.req('GET', `/conversations/search?${new URLSearchParams({ locationId: config.ghl.locationId, limit: '1' })}`));
if (conv) ok(`conversaciones: leer (${conv.total ?? conv.conversations?.length ?? 0} en total)`);
const cont = await probar('contactos (leer)', () => ghl.req('GET', `/contacts/?${new URLSearchParams({ locationId: config.ghl.locationId, limit: '1' })}`));
if (cont) ok('contactos: leer');
aviso('Escritura (enviar mensajes, etiquetas, notas, asignar) no se prueba aquí para no tocar contactos: se ve en modo prueba.');

console.log('\nUsuarios por sede');
const users = await probar('usuarios', () => ghl.req('GET', `/users/?${new URLSearchParams({ locationId: config.ghl.locationId })}`));
const ids = new Map((users?.users || []).map((u) => [u.id, `${u.name || [u.firstName, u.lastName].filter(Boolean).join(' ')} <${u.email || ''}>`]));
// El Cañaveral usa el mismo responsable que Las Rosas (GHL_USER_LAS_ROSAS)
for (const [sede, id] of Object.entries(config.ghl.users).filter(([s]) => s !== 'el_canaveral')) {
  if (!id) mal(`${sede}: sin usuario (GHL_USER_${sede.toUpperCase()})`);
  else if (users && !ids.has(id)) mal(`${sede}: el usuario ${id} no existe en la subcuenta`);
  else ok(`${sede}: ${ids.get(id) || id}`);
}
if (ids.size) {
  console.log('  Usuarios de la subcuenta (para copiar el ID):');
  for (const [id, n] of ids) console.log(`    ${id}  ${n}`);
}

console.log('\nCalendario de la prueba de Parla');
if (!config.ghl.calendarPruebaParla) aviso('GHL_CALENDAR_PRUEBA_PARLA vacío (hoy la prueba se pide al equipo por aviso; no es obligatorio)');
else {
  const cal = await probar('calendario', () => ghl.req('GET', `/calendars/${config.ghl.calendarPruebaParla}`));
  if (cal) ok(cal.calendar?.name || config.ghl.calendarPruebaParla);
}

console.log('\nEtiquetas');
const tags = await probar('etiquetas', () => ghl.req('GET', `/locations/${config.ghl.locationId}/tags`));
if (tags) {
  const existentes = new Set((tags.tags || []).map((t) => String(t.name).toLowerCase()));
  const E = knowledge.etiquetas;
  const usadas = [...Object.values(E.sedes).map((s) => s.tag), ...Object.values(E.tipo), ...Object.values(E.tareas), ...Object.values(E.control), ...E.embudo];
  const faltan = usadas.filter((t) => !existentes.has(t));
  if (faltan.length) aviso(`Aún no existen (GHL las crea al primer uso; créalas antes si hay workflows que dependan de ellas): ${faltan.join(', ')}`);
  else ok('todas las etiquetas existen');
}

console.log('\nPendiente de comprobar a mano en GHL');
aviso('Workflow «Customer Replied» → Webhook con la cabecera x-setter-secret (ver docs/ghl.md).');
aviso('Plantilla de WhatsApp aprobada para seguimientos fuera de 24 h (zapp_seguimiento_programado).');
aviso('Tras activar la entrada, revisar los primeros webhooks: GET /admin/webhooks.');

console.log(fallos ? `\n${fallos} problema(s) que resolver.\n` : '\nTodo correcto.\n');
process.exit(fallos ? 1 : 0);
