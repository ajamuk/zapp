// Embudo mensual por sede: leads nuevos → reservan prueba → asisten → primer pago.
//
// - Leads nuevos: contactos creados en GHL en el mes con la etiqueta de su sede (parla / getafe / las rosas,
//   o "mpo <sede>"). Se descartan los que ya son socios (etiqueta "activo…" o "socio").
// - Reservan, asisten y primer pago: el informe mensual de pruebas que saca metro-trial-crm del panel de
//   AimHarder (/opt/metro-trial-crm/data/aimharder-AAAA-MM.json). Reservan = pruebas no canceladas; asisten =
//   marcadas como asistidas en AimHarder; primer pago = alta con primer pago posterior a la prueba.
//   No hace ninguna petición a AimHarder: solo lee ese fichero.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { Ghl } from './ghl.js';

export const SEDES_EMBUDO = ['parla', 'getafe', 'las_rosas'];
const CACHE_MS = 15 * 60 * 1000;
const cache = new Map();

/** Sede de un contacto de GHL según sus etiquetas, o null. */
export function sedeDeEtiquetas(tags = []) {
  const t = tags.map((x) => String(x).toLowerCase().trim());
  for (const [sede, nombres] of [['parla', ['parla', 'mpo parla']], ['getafe', ['getafe', 'mpo getafe']], ['las_rosas', ['las rosas', 'mpo las rosas']]]) {
    if (t.some((x) => nombres.includes(x))) return sede;
  }
  return null;
}

const esSocio = (tags = []) => tags.some((x) => /^(activo|socio)\b/i.test(String(x).trim()));

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

/** Cuenta los leads nuevos del mes por sede, paginando la búsqueda de contactos de GHL. */
export async function leadsPorSede(ghl, mes) {
  const { desde, hasta } = rangoMes(mes);
  const cuenta = { parla: 0, getafe: 0, las_rosas: 0, sin_sede: 0 };
  let searchAfter;
  for (let pagina = 0; pagina < 50; pagina++) {
    const r = await ghl.req('POST', '/contacts/search', {
      locationId: config.ghl.locationId, pageLimit: 100,
      filters: [{ field: 'dateAdded', operator: 'range', value: { gte: desde.toISOString(), lt: hasta.toISOString() } }],
      sort: [{ field: 'dateAdded', direction: 'asc' }],
      ...(searchAfter ? { searchAfter } : {}),
    });
    const contactos = r?.contacts || [];
    for (const c of contactos) {
      if (esSocio(c.tags)) continue;
      cuenta[sedeDeEtiquetas(c.tags) || 'sin_sede']++;
    }
    searchAfter = contactos.at(-1)?.searchAfter;
    if (contactos.length < 100 || !searchAfter) break;
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

/** Embudo completo del mes. Se guarda 15 minutos en memoria para no repetir llamadas a GHL. */
export async function embudo(mes = mesActual(), { ghl = new Ghl(), dir, ahora = Date.now() } = {}) {
  const clave = `${mes}|${dir || ''}`;
  const enCache = cache.get(clave);
  if (enCache && ahora - enCache.t < CACHE_MS) return enCache.valor;

  let leads = null; let errorLeads = null;
  try { leads = await leadsPorSede(ghl, mes); } catch (e) { errorLeads = 'No se han podido leer los leads de GHL.'; console.error('Embudo GHL:', e.message); }
  const pruebas = pruebasPorSede(mes, dir);
  const sedes = SEDES_EMBUDO.map((sede) => ({
    sede,
    leads: leads ? leads[sede] : null,
    reservan: pruebas ? pruebas.porSede[sede].reservan : null,
    asisten: pruebas ? pruebas.porSede[sede].asisten : null,
    pagan: pruebas ? pruebas.porSede[sede].pagan : null,
  }));
  const valor = {
    mes, sedes,
    sin_sede: leads?.sin_sede ?? null,
    pruebas_actualizadas: pruebas?.actualizado ?? null,
    avisos: [errorLeads, pruebas ? null : 'Todavía no hay informe de pruebas de AimHarder para este mes.'].filter(Boolean),
  };
  if (!errorLeads) cache.set(clave, { t: ahora, valor });
  return valor;
}

export function limpiarCacheEmbudo() { cache.clear(); }
