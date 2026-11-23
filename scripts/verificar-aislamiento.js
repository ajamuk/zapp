// Comprueba el aislamiento de Sofía en su número de WhatsApp propio. Solo lee: no envía mensajes ni cambia nada.
//   npm run verificar-aislamiento                 → revisa la configuración
//   npm run verificar-aislamiento -- --contacto <contactId>  → además lee en GHL el último entrante de ese contacto
//   npm run verificar-aislamiento -- <messageId>             → o un mensaje concreto
// y dice si Sofía lo atendería. El contacto es el del móvil del equipo con el que se hace la prueba.
// No imprime teléfonos completos, textos ni claves.
import { config } from '../src/config.js';
import { Ghl } from '../src/ghl.js';
import { estadoAislamiento, evaluarEntrante, enmascarar } from '../src/aislamiento.js';

const a = estadoAislamiento();
console.log(`\nModo del servicio: ${config.mode}`);
if (a.modo === 'apagado') { console.log('Aislamiento: SIN CONFIGURAR (faltan SOFIA_WA_NUMERO y SOFIA_WA_LOCATION_ID). Sofía se comporta como siempre.\n'); process.exit(1); }
if (a.modo === 'invalido') { console.log(`Aislamiento: MAL CONFIGURADO → no entra ni sale nada.\n  - ${a.motivos.join('\n  - ')}\n`); process.exit(1); }
console.log(`Aislamiento: activo · número propio ${enmascarar(a.numero)} · subcuenta ${a.locationId}`);

const [arg, valor] = process.argv.slice(2);
if (!arg) { console.log('\nPara probar un mensaje real: npm run verificar-aislamiento -- --contacto <contactId>   (o -- <messageId>)\n'); process.exit(0); }
if (!config.ghl.token) { console.log('Falta GHL_TOKEN.\n'); process.exit(1); }
let m;
try {
  const ghl = new Ghl();
  let id = arg;
  if (arg === '--contacto') {
    // Último mensaje entrante del contacto de prueba (su id sale en la dirección de su ficha en GHL)
    const conv = await ghl.buscarConversacion(valor);
    const ultimo = conv ? (await ghl.mensajes(conv.id)).filter((x) => x.direccion === 'inbound').pop() : null;
    if (!ultimo) { console.log('Ese contacto no tiene mensajes entrantes en esta subcuenta.\n'); process.exit(1); }
    id = ultimo.id;
    if (ultimo.locationId && ultimo.para != null) m = ultimo;
  }
  m ||= await ghl.mensaje(id);
} catch (e) { console.log(`GHL no deja leer el mensaje: ${e.message}\n`); process.exit(1); }
if (!m) { console.log('GHL no devuelve ese mensaje.\n'); process.exit(1); }
const para = Array.isArray(m.para) ? m.para : m.para == null || m.para === '' ? [] : [m.para];
console.log('\nLo que dice GHL de ese mensaje:');
console.log(`  subcuenta (locationId): ${m.locationId || '(no viene)'}`);
console.log(`  dirección: ${m.direccion || '(no viene)'} · tipo: ${m.tipo || '(no viene)'}`);
console.log(`  destinatario (to): ${para.length ? para.map(enmascarar).join(', ') : '(no viene)'}`);
const v = evaluarEntrante(a, m);
console.log(v.ok ? '\n✔ Sofía lo atendería: es un WhatsApp entrante al número propio.\n' : `\n✘ Sofía lo descartaría: ${v.motivo}.\n`);
process.exit(v.ok ? 0 : 1);
