import { config } from '../config.js';

/**
 * Búsqueda de socios por teléfono en AimHarder.
 * El endpoint exacto se configura con AIMHARDER_API_URL (ver docs/aimharder.md).
 * Se espera una respuesta JSON con una lista de clientes; se considera socio
 * a quien tenga una tarifa activa.
 */
export async function buscarSocioPorTelefono(telefono, { fetchImpl = fetch } = {}) {
  if (!config.aimharder.apiUrl || !telefono) return { configurado: false, esSocio: false };
  const tel = String(telefono).replace(/[^\d+]/g, '');
  const url = new URL(config.aimharder.apiUrl);
  url.searchParams.set('phone', tel);
  const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${config.aimharder.apiKey}`, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`AimHarder búsqueda → ${r.status}`);
  const data = await r.json();
  const lista = Array.isArray(data) ? data : data.clients || data.data || [];
  const activo = lista.find((c) => c.active === true || c.status === 'active' || c.activo === true);
  return {
    configurado: true,
    esSocio: Boolean(activo),
    exSocio: !activo && lista.length > 0,
    nombre: activo?.name || activo?.nombre || null,
    sede: activo?.box || activo?.sede || null,
  };
}

export { prepararAltaNavegador } from './alta-navegador.js';
