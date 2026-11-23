// Diagnóstico histórico de captación: pasa el diagnóstico (nivel de conciencia, motivo y freno) por las
// conversaciones que ya hay y saca un informe agregado, sin nombres ni teléfonos. No envía nada a ningún lead,
// no escribe en la base (la abre en solo lectura) y no toca GHL.
//
//   npm run diagnostico-captacion                       # la base del servicio (DB_PATH), por reglas, sin red
//   npm run diagnostico-captacion -- --db otra.db       # otra base
//   npm run diagnostico-captacion -- --jsonl eval/casos-zapp.jsonl   # un export anonimizado ({ contexto: [[quién, texto]] })
//   npm run diagnostico-captacion -- --ia               # con el modelo de Sofía (Anthropic, el proveedor que ya se usa;
//                                                       # la conversación sale sin emails, teléfonos ni nombre)
//   --limite N   --salida fichero.md
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../src/config.js';
import * as cap from '../src/captacion.js';

function argumentos(argv) {
  const a = { db: null, jsonl: null, ia: false, limite: 0, salida: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--ia') a.ia = true;
    else if (['--db', '--jsonl', '--salida', '--limite'].includes(k)) a[k.slice(2)] = argv[++i];
    else throw new Error(`Opción desconocida: ${k}`);
  }
  a.limite = Number(a.limite) || 0;
  return a;
}

/** Conversaciones de la base, con lo que el lead llegó a ver y si hoy habría que dejarle en paz. */
function deBase(ruta, cfg, ahora) {
  const db = new Database(ruta, { readonly: true, fileMustExist: true });
  const convs = db.prepare(`SELECT c.*, (SELECT max(created_at) FROM messages m WHERE m.conversation_id = c.id AND m.autor != 'sistema') ultima
    FROM conversations c WHERE c.id NOT LIKE 'prueba-%' AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.autor = 'lead')`).all();
  const filas = convs.map((c) => {
    const mensajes = db.prepare("SELECT autor, IFNULL(texto, transcripcion) texto FROM messages WHERE conversation_id = ? AND enviado = 1 AND autor != 'sistema' ORDER BY id").all(c.id);
    const pendiente = db.prepare("SELECT 1 FROM scheduled WHERE conversation_id = ? AND estado IN ('pendiente', 'enviando') LIMIT 1").get(c.id);
    const ultima = cap.instante(c.ultima);
    const dias = ultima ? (ahora - ultima) / 864e5 : null;
    const parada = cap.motivoParada(db, c);
    const situacion = parada ? `parado: ${parada.motivo}` : pendiente ? 'con seguimientos de Sofía pendientes' : dias < cfg.diagnostico_dias ? 'conversación reciente' : dias > cfg.antiguedad_max_dias ? `más de ${cfg.antiguedad_max_dias} días sin actividad` : null;
    return { conv: c, mensajes, ultima, situacion };
  });
  db.close();
  return filas;
}

/** Export anonimizado: una conversación por línea, { id, canal, contexto: [[quién, texto], …] }. */
function deJsonl(ruta) {
  return fs.readFileSync(ruta, 'utf8').split('\n').filter((l) => l.trim()).map((l, i) => {
    const j = JSON.parse(l);
    return { conv: { id: j.id || `linea-${i + 1}`, contact_id: j.id || `linea-${i + 1}`, channel: j.canal || 'whatsapp', sede: j.sede || null },
      mensajes: (j.contexto || []).map(([autor, texto]) => ({ autor: autor === 'lead' ? 'lead' : 'ia', texto })), ultima: null, situacion: null };
  });
}

const contar = (lista, clave) => { const m = new Map(); for (const x of lista) { const k = clave(x); if (k != null) m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]); };
const tabla = (cab, filas) => [`| ${cab.join(' | ')} |`, `| ${cab.map(() => '---').join(' | ')} |`, ...filas.map((f) => `| ${f.join(' | ')} |`)].join('\n');

export async function diagnosticoHistorico({ db = null, jsonl = null, ia = false, limite = 0, ahora = new Date(), cfg = cap.cargarConfig(), complete = null } = {}) {
  let filas = jsonl ? deJsonl(jsonl) : deBase(db || config.dbPath, cfg, ahora);
  if (limite) filas = filas.slice(0, limite);
  const res = [];
  for (const f of filas) {
    const d = await cap.diagnosticar(f.conv, f.mensajes, { ia, complete });
    const grupo = cap.grupoDe(f.conv.contact_id, cfg.control_pct);
    const situacion = f.situacion || (d.oposicion ? 'parado: oposición' : null);
    // Qué recibiría si hoy entrase en el sistema (sin contar el grupo de control, para ver la demanda de contenidos)
    const plan = situacion ? [] : cap.planificar({ ...d, toques_sin_respuesta: 0 }, f.conv, f.ultima || new Date(ahora - cfg.diagnostico_dias * 864e5), ahora, cfg);
    res.push({ ...d, sede: f.conv.sede || 'sin sede', canal: f.conv.channel, grupo, situacion, plan: plan.map((t) => t.pieza) });
  }
  return { res, cfg, origen: jsonl ? path.basename(jsonl) : 'base del servicio', ia, ahora };
}

export function informe({ res, cfg, origen, ia, ahora }) {
  const n = res.length;
  const pct = (x) => (n ? `${Math.round((100 * x) / n)} %` : '—');
  const piezas = Object.fromEntries(cfg.piezas.map((p) => [p.id, p]));
  const conPlan = res.filter((r) => r.plan.length);
  const sinPlan = (r) => r.situacion || (r.nivel === 1 ? 'nivel 1: solo lanzamientos' : r.canal !== 'whatsapp' ? 'Instagram: fuera de plazo' : !r.plan.length ? 'sin piezas para su perfil' : null);
  const material = contar(conPlan.flatMap((r) => [...new Set(r.plan.map((id) => piezas[id]?.material).filter(Boolean))]), (x) => x);
  const frenos = cap.FRENOS.filter((f) => res.some((r) => r.freno === f));
  return [
    '# Diagnóstico histórico de captación',
    '',
    `Fecha: ${ahora.toISOString().slice(0, 10)} · Origen: ${origen} · Conversaciones con mensajes del lead: ${n} · Diagnóstico: ${ia ? 'modelo de IA (con respaldo por reglas)' : 'reglas de texto (sin IA ni red)'}.`,
    'Solo cifras agregadas: sin nombres, teléfonos ni textos de los leads. No se ha enviado ni cambiado nada.',
    '',
    '## Nivel de conciencia',
    '',
    tabla(['Nivel', 'Leads', '%'], Object.keys(cap.NIVELES).map(Number).map((k) => { const c = res.filter((r) => r.nivel === k).length; return [`${k}. ${cap.NIVELES[k]}`, c, pct(c)]; })),
    '',
    '## Freno principal',
    '',
    tabla(['Freno', 'Leads', '%'], contar(res, (r) => r.freno).map(([k, c]) => [k, c, pct(c)])),
    '',
    '## Motivo',
    '',
    tabla(['Motivo', 'Leads', '%'], contar(res, (r) => r.motivo).map(([k, c]) => [k, c, pct(c)])),
    '',
    '## Nivel por freno',
    '',
    tabla(['Nivel', ...frenos], Object.keys(cap.NIVELES).map(Number).map((k) => [k, ...frenos.map((f) => res.filter((r) => r.nivel === k && r.freno === f).length)])),
    '',
    '## Nivel por sede',
    '',
    tabla(['Sede', '1', '2', '3', '4', '5'], contar(res, (r) => r.sede).map(([s]) => [s, ...[1, 2, 3, 4, 5].map((k) => res.filter((r) => r.sede === s && r.nivel === k).length)])),
    '',
    '## Qué pasaría hoy con estos leads',
    '',
    tabla(['Situación', 'Leads'], [['Recibirían un plan de contenidos', conPlan.length], ...contar(res.filter((r) => !r.plan.length), sinPlan)]),
    '',
    `De los ${conPlan.length} con plan, ${conPlan.filter((r) => r.grupo === 'control').length} caerían en el grupo de control (${cfg.control_pct} %) y no recibirían contenidos.`,
    '',
    '## Contenidos más pedidos',
    '',
    conPlan.length ? tabla(['Contenido', 'Como primer toque', 'En total'], contar(conPlan.flatMap((r) => r.plan), (x) => x).map(([id, c]) => [piezas[id]?.nombre || id, conPlan.filter((r) => r.plan[0] === id).length, c])) : 'Ningún lead recibiría contenidos.',
    '',
    '## Material real que hace falta primero',
    '',
    material.length ? tabla(['Recurso', 'Leads que lo recibirían', 'Qué es'], material.map(([k, c]) => [`\`${k}\``, c, `${cfg.material[k].descripcion} (${cfg.material[k].formato})`])) : 'Los contenidos que saldrían no necesitan material.',
    '',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const a = argumentos(process.argv.slice(2));
  if (a.ia && !config.ai.apiKey) { console.error('Para --ia hace falta ANTHROPIC_API_KEY (la misma que usa Sofía).'); process.exit(1); }
  const texto = informe(await diagnosticoHistorico(a));
  const salida = path.resolve(a.salida || path.join(path.dirname(config.dbPath), 'diagnostico-captacion.md'));
  fs.mkdirSync(path.dirname(salida), { recursive: true });
  fs.writeFileSync(salida, texto);
  console.log(texto);
  console.error(`\nInforme guardado en ${salida}`);
}
