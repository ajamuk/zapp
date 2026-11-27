import fs from 'node:fs';
import Database from 'better-sqlite3';
import path from 'node:path';
import { config } from '../config.js';
import { AimHarderApi } from './api.js';

// Sedes con AimHarder propio (config/negocio.json)
export const SEDES = config.aimharder.sedes;
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

/** Tokens renovados guardados ({ sede: { access, refresh } }); {} si no hay fichero o no se puede leer. */
export function leerTokensGuardados(fichero = ficheroTokens()) {
  try { return JSON.parse(fs.readFileSync(fichero, 'utf8')) || {}; } catch { return {}; }
}

/**
 * Guarda la pareja nueva de una sede sin pisar las demás: se relee el fichero justo antes (otra sede u otro proceso
 * puede haberlo cambiado) y se escribe entero de una vez (temporal + rename), solo legible por el servicio.
 */
export function guardarTokenSede(sede, par, fichero = ficheroTokens()) {
  const todos = { ...leerTokensGuardados(fichero), [sede]: par };
  fs.mkdirSync(path.dirname(fichero), { recursive: true });
  const tmp = `${fichero}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(todos), { mode: 0o600 });
  fs.renameSync(tmp, fichero);
}

// Con tokens propios, un solo cliente por sede en todo el proceso: cada renovación cambia la pareja, y dos clientes
// con copias distintas se dejarían sin acceso el uno al otro.
const clientesPropios = new Map();
/** Solo para las pruebas: olvida los clientes creados. */
export const olvidarClientesApi = () => clientesPropios.clear();

/**
 * Un cliente de API por sede. Con AIMHARDER_TOKEN_STORE se usan los tokens compartidos (sin renovarlos);
 * si no, los del .env, y los renovados se guardan en data/aimharder-tokens.json.
 */
export function clientesApi({ fichero = ficheroTokens(), fetchImpl } = {}) {
  const store = config.aimharder.tokenStore;
  if (store) {
    const out = {};
    for (const sede of SEDES) {
      try { leerTokenCompartido(store, sede); } catch (e) { console.warn(e.message); continue; }
      out[sede] = new AimHarderApi({ leerToken: () => leerTokenCompartido(store, sede), ...(fetchImpl ? { fetchImpl } : {}) });
    }
    return out;
  }
  const guardados = leerTokensGuardados(fichero);
  const out = {};
  for (const sede of SEDES) {
    const clave = `${fichero}:${sede}`;
    if (!clientesPropios.has(clave)) {
      const t = guardados[sede] || config.aimharder.tokens[sede];
      if (!t?.access) continue;
      clientesPropios.set(clave, new AimHarderApi({
        access: t.access, refresh: t.refresh, ...(fetchImpl ? { fetchImpl } : {}),
        leerGuardado: () => leerTokensGuardados(fichero)[sede],
        onRefresh: (access, refresh) => guardarTokenSede(sede, { access, refresh }, fichero),
      }));
    }
    out[sede] = clientesPropios.get(clave);
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
  const fallos = [];
  for (const [sede, api] of Object.entries(apis)) {
    // Una sede que falla no deja sin actualizar a las demás: el error sale al final
    try {
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
    } catch (e) { fallos.push(e); }
  }
  if (fallos.length) {
    const e = fallos.length === 1 ? fallos[0] : new Error(fallos.map((x) => x.message).join(' · '));
    e.resumen = resumen; // lo que sí se sincronizó
    throw e;
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
