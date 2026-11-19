// Chat de terminal con Sofía, usando el modelo real y sin tocar GHL ni AimHarder.
// Uso: ANTHROPIC_API_KEY=... npm run simular   (escribe "salir" para terminar, "reiniciar" para empezar de cero)
import readline from 'node:readline/promises';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';

const repo = crearRepo(openDb(':memory:'));
const ghl = {
  sendMessage: async ({ texto }) => { console.log(`  sofía › ${texto}`); return {}; },
  sendTemplate: async ({ variables }) => console.log(`  sofía (plantilla) › ${variables[0]}`),
  addTags: async (_, t) => console.log(`  · etiquetas: ${t.join(', ')}`),
  removeTags: async () => {}, assign: async () => {}, addNote: async () => {},
  getContact: async () => ({ contact: {} }),
};
const setter = new Setter({
  repo, ghl, live: true, sleep: async () => {},
  avisar: async (t) => console.log(`  · aviso al equipo: ${t}`),
  aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: false }), prepararAlta: async () => ({ estado: 'simulada', detalle: 'simulador' }) },
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let n = 0, conv = 'sim-1';
console.log('Simulador de Sofía. Escribe como si fueras un lead.\n');
for (;;) {
  const texto = (await rl.question('lead › ')).trim();
  if (texto === 'salir') break;
  if (texto === 'reiniciar') { conv = `sim-${Date.now()}`; console.log('(nueva conversación)'); continue; }
  if (!texto) continue;
  await setter.onInbound({ conversationId: conv, contactId: conv, canal: 'whatsapp', texto, messageId: `${conv}-${++n}` });
  repo.updateConv(conv, { respond_at: null });
  try { await setter.responder(conv); } catch (e) { console.error('  ! error:', e.message); }
}
rl.close();
