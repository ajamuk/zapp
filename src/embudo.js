// Embudo mensual por sede. Cada sede tiene el suyo:
//   Parla               leads nuevos → reservan prueba → asisten → primer pago
//   Getafe y Las Rosas  leads nuevos → primer pago
//
// - Leads nuevos: chats que Sofía ha abierto en el mes (hora de Madrid), por la sede que tiene anotada el chat.
//   No cuentan los socios, los marcados con una etiqueta de «no es un lead» ni los números de prueba. Los que aún
//   no tienen sede van aparte (`sin_sede`) y los interesados en El Cañaveral también.
// - Primer pago (= alta): socios cuyo primer pago de toda su historia cae en el mes, hayan hecho o no clase de
//   prueba. Sale del registro de socios de cada sede (clientes-analytics, un SQLite por sede que se rehace solo).
// - Reservan y asisten (solo Parla): el informe mensual de pruebas que saca metro-trial-crm del panel de
//   AimHarder (/opt/metro-trial-crm/data/aimharder-AAAA-MM.json). Reservan = pruebas no canceladas; asisten =
//   marcadas como asistidas. No hace ninguna petición a AimHarder: solo lee ese fichero.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { plazasCanaveral } from './canaveral.js';
import { sqlEsLead } from './etiquetas.js';
import { sqlSinNumerosPrueba } from './panel.js';

export const PLAZAS_APERTURA_CANAVERAL = 200;

export const SEDES_EMBUDO = ['parla', 'getafe', 'las_rosas'];
/** Pasos del embudo de cada sede, en orden. Solo Parla trabaja con clase de prueba. */
export const PASOS_SEDE = { parla: ['leads', 'reservan', 'asisten', 'pagan'], getafe: ['leads', 'pagan'], las_rosas: ['leads', 'pagan'] };

const NOMBRE_SEDE = { parla: 'Parla', getafe: 'Getafe', las_rosas: 'Las Rosas' };

/** Medianoche en Madrid del día 1 de un mes, como instante UTC (respeta el horario de verano). */
function medianocheMadrid(a, m) {
  const utc = Date.UTC(a, m - 1, 1);
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hourCycle: 'h23' }).format(utc));
  return new Date(utc - h * 3600 * 1000);
}

/** Inicio (incluido) y fin (excluido) del mes 'AAAA-MM' en hora de Madrid. */
export function rangoMes(mes) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) throw new Error('Mes con formato AAAA-MM');
  const [a, m] = mes.split('-').map(Number);
  return { desde: medianocheMadrid(a, m), hasta: m === 12 ? medianocheMadrid(a + 1, 1) : medianocheMadrid(a, m + 1) };
}

export function mesActual(ahora = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit' }).format(ahora);
}

/**
 * Leads nuevos del mes por sede, de los chats de Sofía: { parla, getafe, las_rosas, el_canaveral, sin_sede, no_leads }.
 * `no_leads` son los chats del mes marcados como «no es un lead», que quedan fuera de las demás cifras.
 */
export function leadsDeSofia(db, mes) {
  const { desde, hasta } = rangoMes(mes);
  const cuenta = { parla: 0, getafe: 0, las_rosas: 0, el_canaveral: 0, sin_sede: 0, no_leads: 0 };
  const filas = db.prepare(`SELECT IFNULL(c.sede, '') sede, ${sqlEsLead('c.id')} lead, count(*) n FROM conversations c
    WHERE c.id NOT LIKE 'prueba-%' AND IFNULL(c.tipo, '') != 'socio' AND ${sqlSinNumerosPrueba()}
      AND datetime(c.created_at) >= datetime(?) AND datetime(c.created_at) < datetime(?) GROUP BY 1, 2`).all(desde.toISOString(), hasta.toISOString());
  for (const f of filas) {
    if (!f.lead) cuenta.no_leads += f.n;
    else cuenta[['parla', 'getafe', 'las_rosas', 'el_canaveral'].includes(f.sede) ? f.sede : 'sin_sede'] += f.n;
  }
  return cuenta;
}

/** Lee el informe de pruebas de AimHarder del mes. Devuelve null si todavía no existe. */
export function pruebasPorSede(mes, dir = config.embudo.pruebasDir) {
  const fichero = path.join(dir, `aimharder-${mes}.json`);
  let datos;
  try { datos = JSON.parse(fs.readFileSync(fichero, 'utf8')); } catch { return null; }
  const out = Object.fromEntries(SEDES_EMBUDO.map((s) => [s, { reservan: 0, asisten: 0, pagan: 0 }]));
  for (const t of datos.trials || []) {
    const s = out[t.boxId];
    if (!s || t.cancelled) continue;
    s.reservan++;
    if (t.attended) s.asisten++;
    if (t.enrolled) s.pagan++;
  }
  return { porSede: out, actualizado: fs.statSync(fichero).mtime.toISOString() };
}

/**
 * Altas del mes por sede: socios cuyo primer pago histórico (`first_payment`, AAAA-MM-DD) cae en ese mes.
 * `rutas`: { sede: fichero SQLite }. Una sede sin registro legible queda en null.
 */
export function altasPorSede(mes, rutas = config.embudo.sociosDb) {
  const porSede = {}; let actualizado = null;
  for (const sede of SEDES_EMBUDO) {
    porSede[sede] = null;
    const ruta = rutas?.[sede];
    if (!ruta || !fs.existsSync(ruta)) continue;
    let db;
    try {
      db = new Database(ruta, { readonly: true, fileMustExist: true, timeout: 2000 });
      porSede[sede] = db.prepare("SELECT count(*) n FROM members WHERE first_payment LIKE ? AND id != '__undefined_client__'").get(`${mes}-%`).n;
      const t = fs.statSync(ruta).mtime.toISOString();
      if (!actualizado || t < actualizado) actualizado = t; // la más antigua: el dato es tan reciente como el peor registro
    } catch (e) { console.error(`Embudo, socios de ${sede}:`, e.message); } finally { try { db?.close(); } catch { /* ya cerrada */ } }
  }
  return { porSede, actualizado };
}

/** Embudo completo del mes. Todo se lee en el momento: chats de Sofía, registro de socios e informe de pruebas. */
/**
 * El Cañaveral (abre el 1 de febrero de 2027): aún no hay clases de prueba, así que su embudo es otro.
 * Interesados del mes (GHL) → plazas de apertura anotadas → primer pago. Las plazas y los pagos son el acumulado
 * de la promoción hasta hoy (el registro de la hoja de 200 plazas, que se rehace cada hora, más las altas que
 * Sofía ha pasado al equipo y aún no están ahí), no del mes.
 */
export function embudoCanaveral(repo, interesados, { ruta } = {}) {
  let plazas = null;
  try { plazas = repo ? plazasCanaveral(repo, { ruta }) : null; } catch (e) { console.error('Embudo El Cañaveral:', e.message); }
  return {
    interesados, plazas: plazas?.total ?? null, pagadas: plazas?.pagados ?? null, de: PLAZAS_APERTURA_CANAVERAL,
    origen: plazas?.origen ?? null, actualizado: plazas?.actualizado ?? null,
  };
}

export async function embudo(mes = mesActual(), { dir, socios, repo = null, rutaCanaveral } = {}) {
  let leads = null; let errorLeads = null;
  try { if (repo?.db) leads = leadsDeSofia(repo.db, mes); else errorLeads = 'No se han podido leer los leads de Sofía.'; }
  catch (e) { errorLeads = 'No se han podido leer los leads de Sofía.'; console.error('Embudo, leads:', e.message); }
  const pruebas = pruebasPorSede(mes, dir);
  const altas = altasPorSede(mes, socios);
  const sedes = SEDES_EMBUDO.map((sede) => {
    const pasos = PASOS_SEDE[sede];
    const conPrueba = pasos.includes('reservan');
    return {
      sede, pasos,
      leads: leads ? leads[sede] : null,
      ...(conPrueba ? { reservan: pruebas ? pruebas.porSede[sede].reservan : null, asisten: pruebas ? pruebas.porSede[sede].asisten : null } : {}),
      pagan: altas.porSede[sede],
    };
  });
  const sinRegistro = SEDES_EMBUDO.filter((s) => altas.porSede[s] === null);
  const faltaPruebas = !pruebas && sedes.some((x) => x.pasos.includes('reservan'));
  const valor = {
    mes, sedes,
    sin_sede: leads?.sin_sede ?? null,
    // El Cañaveral aún no abre: sus interesados se cuentan aparte y no entran en el total ni en la conversión
    el_canaveral: leads?.el_canaveral ?? null,
    no_leads: leads?.no_leads ?? 0, // contactos del mes marcados como «no es un lead»: fuera de todas las cifras
    pruebas_actualizadas: pruebas?.actualizado ?? null,
    altas_actualizadas: altas.actualizado,
    avisos: [errorLeads, faltaPruebas ? 'Todavía no hay informe de pruebas de AimHarder para este mes.' : null,
      sinRegistro.length ? `No se ha podido leer el registro de socios de ${sinRegistro.map((s) => NOMBRE_SEDE[s]).join(', ')}: falta su primer pago.` : null].filter(Boolean),
  };
  return { ...valor, canaveral: embudoCanaveral(repo, valor.el_canaveral, { ruta: rutaCanaveral }) };
}

