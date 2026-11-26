// Comprueba, desde el VPS, que todo está listo para que Sofía funcione en GHL. No envía mensajes ni cambia nada.
//   node scripts/verificar-ghl.js            (lee /etc/codex-hosting/zapp.env si se exporta antes, o el .env)
import { config } from '../src/config.js';
import { Ghl } from '../src/ghl.js';

const ok = (t) => console.log(`  ✔ ${t}`);
const mal = (t) => { console.log(`  ✘ ${t}`); fallos++; };
const ojo = (t) => console.log(`  ! ${t}`);
let fallos = 0;

console.log('\nConfiguración');
config.ghl.token ? ok('GHL_TOKEN puesto') : mal('Falta GHL_TOKEN (Ajustes → Integraciones privadas en GHL)');
config.ghl.locationId ? ok(`GHL_LOCATION_ID = ${config.ghl.locationId}`) : mal('Falta GHL_LOCATION_ID');
(config.webhookSecret || '').length >= 24 ? ok('WEBHOOK_SECRET con 24+ caracteres') : mal('WEBHOOK_SECRET falta o es corto (openssl rand -hex 24)');
config.ai.apiKey ? ok('ANTHROPIC_API_KEY puesta') : mal('Falta ANTHROPIC_API_KEY');
config.ghlWebhookEnabled ? ok('GHL_WEBHOOK_ENABLED=true') : mal('GHL_WEBHOOK_ENABLED=false: el webhook responde 503 y no entra nada');
config.mode === 'live' ? ojo('MODE=live: Sofía ENVÍA mensajes a los leads (solo con el aislamiento bien configurado: npm run verificar-aislamiento)') : ok(`MODE=${config.mode}: Sofía deja su respuesta como nota interna, no envía`);

if (!config.ghl.token || !config.ghl.locationId) { console.log(`\n${fallos} problema(s). Sin token no se puede seguir.\n`); process.exit(1); }

const ghl = new Ghl();
console.log('\nGHL');
try {
  const r = await ghl.req('GET', `/locations/${config.ghl.locationId}`, null, { intentos: 1 });
  ok(`El token entra en la cuenta «${r?.location?.name || config.ghl.locationId}»`);
} catch (e) { mal(`El token no sirve para esa cuenta: ${e.message}`); }

try {
  const r = await ghl.req('GET', `/users/?locationId=${config.ghl.locationId}`, null, { intentos: 1 });
  const usuarios = r?.users || [];
  const ids = new Set(usuarios.map((u) => u.id));
  for (const [sede, id] of Object.entries({ PARLA: config.ghl.users.parla, GETAFE: config.ghl.users.getafe, LAS_ROSAS: config.ghl.users.las_rosas })) {
    if (!id) mal(`Falta GHL_USER_${sede}`);
    else if (!ids.has(id)) mal(`GHL_USER_${sede}=${id} no es un usuario de esta cuenta`);
    else ok(`GHL_USER_${sede} → ${usuarios.find((u) => u.id === id)?.name}`);
  }
  if (usuarios.length) { console.log('    Usuarios de la cuenta:'); for (const u of usuarios) console.log(`      ${u.id}  ${u.name || ''} ${u.email ? `<${u.email}>` : ''}`); }
} catch (e) { ojo(`No se pueden listar usuarios (falta el permiso users.readonly?): ${e.message}`); }

try {
  const tags = (await ghl.listarTags()).map((t) => String(t.name).toLowerCase());
  for (const t of ['parar ia', 'continuar ia']) tags.includes(t) ? ok(`Etiqueta «${t}» existe`) : ojo(`La etiqueta «${t}» no existe todavía en GHL (créala para poder pausar/reanudar)`);
} catch (e) { mal(`No se pueden leer las etiquetas (permiso de contactos/tags): ${e.message}`); }

try {
  const q = new URLSearchParams({ locationId: config.ghl.locationId, limit: '1' });
  await ghl.req('GET', `/conversations/search?${q}`, null, { intentos: 1 });
  ok('Lectura de conversaciones (necesaria con el webhook de workflow)');
} catch (e) { mal(`No se pueden leer conversaciones (permiso conversations.readonly): ${e.message}`); }

console.log(fallos ? `\n${fallos} problema(s) que arreglar antes de activar.\n` : '\nTodo listo por la parte de GHL. Falta el workflow (docs/activar-ghl.md).\n');
process.exit(fallos ? 1 : 0);
