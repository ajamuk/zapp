// Réplica de conversaciones reales de Zapp: Sofía (nuestro modelo) contesta a los mismos momentos
// y se compara con lo que contestó Zapp, con comprobaciones automáticas.
// Uso: ANTHROPIC_API_KEY=... npm run evaluar [-- --solo precio] [-- --max 10]
// Resultado: data/informe-evaluacion.md
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';
import { knowledge, normalizarSede } from '../src/knowledge.js';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : null; };
const casos = fs.readFileSync(path.join(config.root, 'eval', 'casos-zapp.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((c) => !opt('solo') || c.tema === opt('solo')).slice(0, Number(opt('max')) || Infinity);

export const horasValidas = (sede) => {
  const s = new Set();
  for (const mod of Object.values(knowledge.horarios[sede] || {})) for (const hs of Object.values(mod)) hs.forEach((h) => s.add(h.slice(0, 5)));
  return s;
};

/** Archivo enviado por Sofía (imagen de tarifas, documento…): en el chat queda como «[imagen: nombre]». */
export const esAdjunto = (m) => /^\[(imagen|audio|video|documento): [^\]]*\]$/.test(String(m).trim());

/** Comprobaciones automáticas sobre la respuesta. Devuelve la lista de fallos. */
export function comprobar(caso, todos) {
  const fallos = [];
  // Los archivos que salen junto al texto no son mensajes escritos: no cuentan para el límite ni para el estilo
  const mensajes = todos.filter((m) => !esAdjunto(m));
  const todo = caso.contexto.map(([, t]) => t).join('\n');
  const ultimoLead = [...caso.contexto].reverse().find(([r]) => r === 'lead')?.[1] || '';
  const sede = caso.sede !== undefined ? caso.sede : normalizarSede(todo);
  const texto = mensajes.join('\n');
  if (mensajes.length > 4) fallos.push('más de 4 mensajes');
  if (/[¿¡]/.test(texto)) fallos.push('usa ¿ o ¡');
  if (mensajes.some((m) => /\.\s*$/.test(m) && !/\.\.\.$/.test(m))) fallos.push('punto final');
  if (/lesi[oó]n/i.test(texto)) fallos.push('dice «lesión»');
  if (/precio|cu[aá]nto|cuota|tarifa|cuesta|pagar/i.test(ultimoLead) && sede && sede !== 'el_canaveral' && !/€/.test(texto)) fallos.push('preguntó el precio con la sede clara y no lo da');
  if (sede && ['getafe', 'las_rosas'].includes(sede) && /prueba/i.test(texto) && !/no (hay|ofrecemos|tenemos)/i.test(texto)) fallos.push('habla de prueba fuera de Parla');
  if (sede && sede !== 'el_canaveral') {
    const validas = horasValidas(sede);
    // Las 22:00 de «las clases se abren para reservar a las 22:00» no son una hora de clase
    const malas = (mensajes.filter((x) => !/se abren|reservar|se publica/i.test(x)).join('\n').match(/\b\d{1,2}:\d{2}\b/g) || []).map((h) => h.padStart(5, '0')).filter((h) => !validas.has(h));
    if (malas.length) fallos.push(`horas que no existen en ${sede}: ${[...new Set(malas)].join(', ')}`);
  }
  return fallos;
}

async function main() {
  if (!config.ai.apiKey) { console.error('Falta ANTHROPIC_API_KEY'); process.exit(1); }
  const repo = crearRepo(openDb(':memory:'));
  const ghl = { sendMessage: async () => ({}), sendTemplate: async () => ({}), addTags: async () => {}, removeTags: async () => {}, assign: async () => {}, addNote: async () => {}, getContact: async () => ({ contact: {} }) };
  const avisos = [];
  const setter = new Setter({
    repo, ghl, live: true, sleep: async () => {}, avisar: async (t) => avisos.push(t),
    aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: false }), prepararAlta: async () => ({ estado: 'simulada' }) },
  });

  const filas = [];
  let ok = 0;
  for (const c of casos) {
    const id = `eval-${c.id}`;
    repo.upsertConv({ id, contact_id: id, channel: c.canal });
    repo.updateConv(id, { tipo: 'captacion' });
    for (const [rol, texto] of c.contexto) repo.addMessage({ conversation_id: id, autor: rol, texto });
    let mensajes = [], error = null;
    try { mensajes = (await setter.responder(id))?.mensajes || []; } catch (e) { error = e.message; }
    const fallos = error ? [`error: ${error}`] : comprobar(c, mensajes);
    if (!fallos.length) ok++;
    filas.push({ c, mensajes, fallos });
    console.log(`${fallos.length ? '✗' : '✓'} ${c.id} (${c.tema})${fallos.length ? ' — ' + fallos.join('; ') : ''}`);
  }

  const costes = repo.costes(1)[0] || {};
  const md = [
    `# Evaluación de Sofía contra conversaciones reales de Zapp`,
    ``,
    `${new Date().toISOString().slice(0, 16)} · modelo ${config.ai.model} · ${casos.length} casos · **${ok} sin fallos automáticos**`,
    `Tokens: entrada ${costes.entrada || 0}, caché ${costes.cache || 0}, salida ${costes.salida || 0}.`,
    ``,
    ...filas.flatMap(({ c, mensajes, fallos }) => [
      `## ${c.id} · ${c.tema} ${fallos.length ? '✗' : '✓'}`,
      ``,
      ...c.contexto.map(([r, t]) => `> **${r}:** ${t.replace(/\n/g, ' / ')}`),
      ``,
      `| Zapp | Sofía (nuevo) |`,
      `| --- | --- |`,
      `| ${c.zapp.join('<br>').replace(/\|/g, '/')} | ${mensajes.join('<br>').replace(/\|/g, '/')} |`,
      ``,
      fallos.length ? `Fallos: ${fallos.join('; ')}` : '',
      ``,
    ]),
  ].join('\n');
  const out = path.join(config.root, 'data', 'informe-evaluacion.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, md);
  console.log(`\n${ok}/${casos.length} sin fallos. Informe: ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
