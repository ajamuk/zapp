import fs from 'node:fs';
import Database from 'better-sqlite3';
import path from 'node:path';
import { config } from '../config.js';
import { AimHarderApi } from './api.js';

export const SEDES = ['parla', 'getafe', 'las_rosas'];
const ficheroTokens = () => path.join(path.dirname(config.dbPath), 'aimharder-tokens.json');

/** Teléfono a 9 dígitos españoles (sin +34 / 0034, espacios ni guiones). */
export function normalizarTelefono(t) {
  const d = String(t || '').replace(/\D/g, '');
  if (!d) return null;
  const sin = d.replace(/^(0034|34)(?=\d{9}$)/, '');
  return sin.length >= 9 ? sin.slice(-9) : null;
}

/**
 * Almacén de tokens compartido con las demás apps del VPS (formato de aimharder-mcp:
 * { centers: { parla: { accessToken, refreshToken } } }). Lo mantiene al día un cron central.
 */
export function leerTokenCompartido(fichero, sede) {
  const t = JSON.parse(fs.readFileSync(fichero, 'utf8')).centers?.[sede]?.accessToken;
  if (!t) throw new Error(`AimHarder: no hay token de ${sede} en ${fichero}`);
  return t;
}

/**
 * Un cliente de API por sede. Con AIMHARDER_TOKEN_STORE se usan los tokens compartidos (sin renovarlos);
 * si no, los del .env, y los renovados se guardan en data/aimharder-tokens.json.
 */
export function clientesApi() {
  const store = config.aimharder.tokenStore;
  if (store) {
    const out = {};
    for (const sede of SEDES) {
      try { leerTokenCompartido(store, sede); } catch (e) { console.warn(e.message); continue; }
      out[sede] = new AimHarderApi({ leerToken: () => leerTokenCompartido(store, sede) });
    }
    return out;
  }
  let guardados = {};
  try { guardados = JSON.parse(fs.readFileSync(ficheroTokens(), 'utf8')); } catch { /* primera vez */ }
  const out = {};
  for (const sede of SEDES) {
    const env = config.aimharder.tokens[sede];
    const t = guardados[sede] || env;
    if (!t?.access) continue;
    out[sede] = new AimHarderApi({
      access: t.access, refresh: t.refresh,
      onRefresh: (access, refresh) => {
        guardados[sede] = { access, refresh };
        fs.mkdirSync(path.dirname(ficheroTokens()), { recursive: true });
        fs.writeFileSync(ficheroTokens(), JSON.stringify(guardados), { mode: 0o600 });
      },
    });
  }
  return out;
}

/**
 * Sedes cuyo índice de socios tiene más de `maxHoras` (o está vacío). Sirve para no volver a descargar
 * todos los socios en cada reinicio: AimHarder limita las peticiones y el límite se comparte con otras apps.
 */
export function sedesPorSincronizar(repo, { maxHoras = 4, ahora = Date.now(), sedes = SEDES } = {}) {
  const ultima = Object.fromEntries(repo.db.prepare('SELECT sede, max(actualizado) t FROM socios GROUP BY sede').all().map((r) => [r.sede, r.t]));
  return sedes.filter((s) => !ultima[s] || ahora - Date.parse(ultima[s].replace(' ', 'T') + 'Z') > maxHoras * 3600 * 1000);
}

/** Sincroniza solo las sedes con datos viejos. Devuelve null si todas están al día. */
export async function sincronizarSiHaceFalta(repo, { apis = clientesApi(), maxHoras = 4, ahora } = {}) {
  const pendientes = sedesPorSincronizar(repo, { maxHoras, ahora, sedes: Object.keys(apis) });
  if (!pendientes.length) return null;
  return sincronizarSocios(repo, Object.fromEntries(pendientes.map((s) => [s, apis[s]])));
}

/** Fila del índice de socios a partir de un cliente de la API (null si no tiene teléfono). */
export function filaSocio(sede, c) {
  const tel = normalizarTelefono(c.mobile_number) || normalizarTelefono(c.land_number);
  if (!tel) return null;
  const tarifas = c.current_memberships || [];
  return { telefono: tel, sede, aimharder_id: c.id, nombre: [c.name, c.first_surname].filter(Boolean).join(' '),
    activo: tarifas.length > 0 && !c.deactivation_date ? 1 : 0, tarifa: tarifas.map((m) => m.membership_name).join(', ') || null };
}

/**
 * La API no busca por teléfono: se descargan los clientes de cada sede (con sus tarifas vigentes)
 * y se guarda un índice teléfono → socio en SQLite. Se repite cada pocas horas.
 * Socio = tiene alguna tarifa vigente hoy. Con ficha pero sin tarifa = exsocio: si su última tarifa pagada terminó
 * hace menos de `exsocioRecienteMeses` se trata como socio (ver buscarSocioPorTelefono); si no, como lead.
 */
export async function sincronizarSocios(repo, apis = clientesApi()) {
  const resumen = {};
  for (const [sede, api] of Object.entries(apis)) {
    const clientes = await api.clientes({ conTarifas: true });
    const filas = [];
    for (const c of clientes) {
      const f = filaSocio(sede, c);
      if (f) filas.push(f);
    }
    // Una lista vacía o a menos de la mitad que la anterior es un fallo de AimHarder, no una fuga de socios:
    // se conserva el índice que había (si no, Sofía trataría a los socios como leads).
    const antes = repo.db.prepare('SELECT count(*) n FROM socios WHERE sede = ?').get(sede).n;
    if (antes >= 20 && filas.length < antes / 2) throw new Error(`AimHarder devolvió ${filas.length} clientes en ${sede} (había ${antes}): no se actualiza el índice`);
    repo.reemplazarSocios(sede, filas);
    resumen[sede] = { clientes: clientes.length, socios: filas.filter((f) => f.activo).length };
  }
  return resumen;
}

/**
 * Hasta cuándo cubría el último pago de cuota de ese teléfono, según el registro de socios de cada sede
 * (clientes-analytics: `members.active_until`, AAAA-MM-DD). Devuelve { hasta, sede } o null.
 * `rutas`: { sede: fichero SQLite }. Una sede sin registro legible se salta.
 */
export function ultimaTarifaHasta(telefono, rutas = config.embudo.sociosDb) {
  const tel = normalizarTelefono(telefono);
  if (!tel) return null;
  let mejor = null;
  for (const [sede, ruta] of Object.entries(rutas || {})) {
    if (!ruta || !fs.existsSync(ruta)) continue;
    let db;
    try {
      db = new Database(ruta, { readonly: true, fileMustExist: true, timeout: 2000 });
      const filas = db.prepare("SELECT phone, active_until FROM members WHERE replace(replace(replace(replace(phone, ' ', ''), '-', ''), '.', ''), '+', '') LIKE ? AND active_until IS NOT NULL AND active_until != ''").all(`%${tel}`);
      for (const f of filas) {
        if (normalizarTelefono(f.phone) !== tel) continue;
        const hasta = String(f.active_until).slice(0, 10);
        if (!mejor || hasta > mejor.hasta) mejor = { hasta, sede };
      }
    } catch (e) { console.error(`Socios de ${sede} (última tarifa):`, e.message); } finally { try { db?.close(); } catch { /* ya cerrada */ } }
  }
  return mejor;
}

/** Fecha (AAAA-MM-DD) de hace `meses` meses. */
function haceMeses(meses, ahora = new Date()) {
  const d = new Date(ahora);
  d.setMonth(d.getMonth() - meses);
  return d.toISOString().slice(0, 10);
}

/**
 * ¿Es socio ese teléfono? Socio = tarifa vigente hoy en AimHarder, o un pago que aún cubre hoy o más adelante
 * (`pagoVigente`: alta nueva cuya tarifa empieza el mes que viene). Un exsocio cuya última tarifa terminó hace
 * menos de `meses` (por defecto 3) cuenta también como socio (`exSocioReciente`): Sofía no le contesta. Más antiguo,
 * o sin fecha de última tarifa, es un exsocio y se trata como lead.
 */
export function buscarSocioPorTelefono(repo, telefono, { rutas = config.embudo.sociosDb, meses = config.aimharder.exsocioRecienteMeses ?? 3, ahora = new Date() } = {}) {
  const tel = normalizarTelefono(telefono);
  if (!tel) return { esSocio: false };
  const filas = repo.sociosPorTelefono(tel);
  const activo = filas.find((f) => f.activo);
  if (activo) return { esSocio: true, exSocio: false, sede: activo.sede, nombre: activo.nombre || null, tarifa: activo.tarifa || null };
  const ultima = ultimaTarifaHasta(tel, rutas);
  // Pago que aún cubre hoy (o que empieza más adelante): es cliente, aunque AimHarder no le marque tarifa vigente
  // (alta nueva con inicio el mes que viene). Se trata como socio, no como exsocio.
  if (ultima && ultima.hasta >= new Date(ahora).toISOString().slice(0, 10)) {
    return { esSocio: true, exSocio: false, pagoVigente: true, tarifaHasta: ultima.hasta, sede: filas[0]?.sede || ultima.sede, nombre: null, tarifa: null };
  }
  const reciente = Boolean(meses > 0 && ultima && ultima.hasta >= haceMeses(meses, ahora));
  return {
    esSocio: reciente,
    exSocio: filas.length > 0 || Boolean(ultima),
    ...(reciente ? { exSocioReciente: true, tarifaHasta: ultima.hasta } : {}),
    sede: filas[0]?.sede || ultima?.sede || null,
    nombre: null,
    tarifa: null,
  };
}

/** Ficha de AimHarder de ese teléfono en esa sede (antiguo socio), para reutilizarla en el alta. */
export function fichaEnSede(repo, telefono, sede) {
  const tel = normalizarTelefono(telefono);
  if (!tel) return null;
  return repo.sociosPorTelefono(tel).find((f) => f.sede === sede && f.aimharder_id) || null;
}

export { prepararAltaNavegador } from './alta-navegador.js';
