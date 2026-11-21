// Horario habitual de clases desde AimHarder. Lo usan el script `npm run sync-aimharder` y el bucle diario del
// servicio, que mantiene al día lo que Sofía contesta sin tocar el repositorio (guarda una copia junto a la base).
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { knowledge } from './knowledge.js';

const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const MAPA = { crossfit: 'crossfit', 'crossfit academy': 'academy', hyrox: 'hyrox', 'open box': 'open_box', halterofilia: 'halterofilia', 'crossfit partner': 'crossfit_partner', fuerza: 'fuerza' };
const ORDEN = ['academy', 'crossfit', 'hyrox', 'open_box', 'halterofilia', 'crossfit_partner', 'fuerza'];
const DIA_MS = 86400000;
export const rutaCopia = () => path.join(path.dirname(config.dbPath), 'horarios.json');

/** Primera fecha (AAAA-MM-DD) igual o posterior a `desde` que cae en ese día de la semana (0 = lunes). */
function fechaDe(desde, weekday) {
  const d = new Date(`${desde}T12:00:00Z`);
  while ((d.getUTCDay() + 6) % 7 !== weekday) d.setTime(d.getTime() + DIA_MS);
  return d.toISOString().slice(0, 10);
}

/**
 * Lee de AimHarder el horario vigente de cada sede y los días sueltos con horario especial (clases dadas de
 * alta para una sola fecha, como Nochebuena). Devuelve { horarios, especiales, fallos }.
 * Una sede que falla o viene vacía no se toca: se queda con lo que había.
 */
export async function leerHorarios(apis, { hoy = new Date().toISOString().slice(0, 10), anterior = knowledge.horarios } = {}) {
  const horarios = { _nota: `Horario habitual sacado de la API de AimHarder el ${hoy}. Se actualiza solo cada día. No confirma plazas libres.`, _plazas: anterior._plazas };
  const especiales = {}; const fallos = [];
  for (const [sede, api] of Object.entries(apis)) {
    try {
      const clases = (await api.clases()).filter((c) => !c.deactivation_date);
      const tablaSede = {}; const esp = {};
      for (const c of clases) {
        const k = MAPA[c.name.trim().toLowerCase()];
        if (!k) continue;
        const tabla = {};
        for (const h of await api.horariosDeClase(c.id)) {
          const unDia = h.start_date >= hoy && h.end_date && (h.end_date < h.start_date || (new Date(h.end_date) - new Date(h.start_date)) / DIA_MS <= 6);
          if (unDia) { ((esp[fechaDe(h.start_date, h.weekday)] ??= {})[k] ??= new Set()).add(h.time); continue; }
          if (h.start_date <= hoy && (!h.end_date || h.end_date >= hoy)) (tabla[DIAS[h.weekday]] ??= new Set()).add(h.time);
        }
        const dias = Object.fromEntries(DIAS.filter((d) => tabla[d]).map((d) => [d, [...tabla[d]].sort()]));
        if (Object.keys(dias).length) tablaSede[k] = dias;
      }
      if (!tablaSede.crossfit) throw new Error('AimHarder no ha devuelto clases de CrossFit');
      horarios[sede] = Object.fromEntries(ORDEN.filter((k) => tablaSede[k]).map((k) => [k, tablaSede[k]]));
      especiales[sede] = Object.fromEntries(Object.keys(esp).sort().map((f) => [f, Object.fromEntries(Object.entries(esp[f]).map(([k, s]) => [k, [...s].sort()]))]));
    } catch (e) {
      fallos.push(`${sede}: ${e.message}`);
      if (anterior[sede]) horarios[sede] = anterior[sede];
      if (anterior._especiales?.[sede]) especiales[sede] = anterior._especiales[sede];
    }
  }
  for (const s of Object.keys(anterior)) if (!s.startsWith('_') && !horarios[s]) horarios[s] = anterior[s];
  horarios._especiales = especiales;
  return { horarios, especiales, fallos };
}

/** Diferencias legibles entre dos horarios: «getafe · crossfit · viernes: quita 20:00, añade 21:00». */
export function diferencias(a, b) {
  const out = [];
  for (const sede of new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => !k.startsWith('_')))) {
    for (const m of new Set([...Object.keys(a[sede] || {}), ...Object.keys(b[sede] || {})])) {
      for (const d of DIAS) {
        const x = a[sede]?.[m]?.[d] || []; const y = b[sede]?.[m]?.[d] || [];
        const quita = x.filter((h) => !y.includes(h)); const pone = y.filter((h) => !x.includes(h));
        if (quita.length || pone.length) out.push(`${sede} · ${m} · ${d}: ${[quita.length ? `quita ${quita.join(', ')}` : '', pone.length ? `añade ${pone.join(', ')}` : ''].filter(Boolean).join(', ')}`);
      }
    }
  }
  return out;
}

/** Trae el horario de AimHarder, lo aplica a lo que usa Sofía y guarda la copia. Devuelve { cambios, fallos }. */
export async function sincronizarHorarios(apis, { ruta = rutaCopia(), hoy } = {}) {
  const { horarios, fallos } = await leerHorarios(apis, { hoy });
  const cambios = diferencias(knowledge.horarios, horarios);
  const espCambia = JSON.stringify(knowledge.horarios._especiales || {}) !== JSON.stringify(horarios._especiales);
  for (const k of Object.keys(knowledge.horarios)) delete knowledge.horarios[k];
  Object.assign(knowledge.horarios, horarios);
  if (cambios.length || espCambia || !fs.existsSync(ruta)) { fs.mkdirSync(path.dirname(ruta), { recursive: true }); fs.writeFileSync(ruta, JSON.stringify(horarios, null, 2) + '\n'); }
  return { cambios, fallos };
}
