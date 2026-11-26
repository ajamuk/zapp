import fs from 'node:fs';
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
 * Socio = tiene alguna tarifa vigente hoy. Con ficha pero sin tarifa = exsocio (se trata como lead).
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

export function buscarSocioPorTelefono(repo, telefono) {
  const tel = normalizarTelefono(telefono);
  if (!tel) return { esSocio: false };
  const filas = repo.sociosPorTelefono(tel);
  const activo = filas.find((f) => f.activo);
  return {
    esSocio: Boolean(activo),
    exSocio: !activo && filas.length > 0,
    sede: activo?.sede || filas[0]?.sede || null,
    nombre: activo?.nombre || null,
    tarifa: activo?.tarifa || null,
  };
}

/** Ficha de AimHarder de ese teléfono en esa sede (antiguo socio), para reutilizarla en el alta. */
export function fichaEnSede(repo, telefono, sede) {
  const tel = normalizarTelefono(telefono);
  if (!tel) return null;
  return repo.sociosPorTelefono(tel).find((f) => f.sede === sede && f.aimharder_id) || null;
}

export { prepararAltaNavegador } from './alta-navegador.js';
