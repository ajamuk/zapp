// Lo que factura Anthropic a la API key de zapp, día a día y por modelo, para ponerlo al lado de lo que apunta
// zapp (Consumo). Usa la Usage and Cost Analytics API con una clave de administrador (ANTHROPIC_ADMIN_KEY).
// Los datos de Anthropic llegan con unas horas de retraso: el día de hoy puede salir incompleto.
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

let cache = null; // { clave, hasta, datos }
const MINUTOS_CACHE = 30;

/** Busca el id de la API key de zapp entre las de la organización comparando su pista («sk-ant-api03-Ab…xyZ»). */
async function idDeLaClave(admin, apiKey) {
  if (config.ai.apiKeyId) return config.ai.apiKeyId;
  if (!apiKey) return null;
  for await (const k of admin.beta.organization.apiKeys.list({ limit: 100 })) {
    const [ini, fin] = String(k.partial_key_hint || '').split(/\.{3}|…/);
    if (ini && fin && apiKey.startsWith(ini) && apiKey.endsWith(fin)) return k.id;
  }
  return null;
}

/**
 * { disponible, motivo?, apiKeyId, dias: [{ dia, usd, modelos: { modelo: usd } }], actualizado }.
 * `cliente` se puede sustituir en tests.
 */
export async function facturaAnthropic({ dias = 31, cliente, ahora = new Date() } = {}) {
  if (!config.ai.adminKey && !cliente) return { disponible: false, motivo: 'Falta ANTHROPIC_ADMIN_KEY en el VPS: sin ella solo se ve lo que apunta zapp.' };
  const n = Math.max(1, Math.min(92, Number(dias) || 31));
  const clave = `${n}`;
  if (!cliente && cache?.clave === clave && cache.hasta > Date.now()) return cache.datos;
  const admin = cliente || new Anthropic({ apiKey: config.ai.adminKey });
  const hoy = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate()));
  const desde = new Date(hoy.getTime() - (n - 1) * 864e5);
  const hasta = new Date(hoy.getTime() + 864e5);
  let apiKeyId;
  try { apiKeyId = await idDeLaClave(admin, config.ai.apiKey); } catch (e) { return { disponible: false, motivo: `No se pudo leer las claves de la organización: ${e.message}` }; }
  if (!apiKeyId) return { disponible: false, motivo: 'No se encontró la API key de zapp en la organización. Pon ANTHROPIC_API_KEY_ID en el VPS.' };
  const porDia = {};
  try {
    for await (const fila of admin.beta.organization.analytics.cost.list({
      starting_at: desde.toISOString(), ending_at: hasta.toISOString(), time_bucket_width: '1d',
      group_by: ['model'], api_key_ids: [apiKeyId], limit: 1000,
    })) {
      const dia = String(fila.starting_at).slice(0, 10);
      const usd = Number(fila.cost?.amount || 0) / 100; // la API da céntimos de dólar en texto
      const d = (porDia[dia] ??= { dia, usd: 0, modelos: {} });
      d.usd += usd;
      const m = fila.group?.model || 'otros';
      d.modelos[m] = (d.modelos[m] || 0) + usd;
    }
  } catch (e) {
    return { disponible: false, motivo: `Anthropic no ha devuelto la factura: ${e.message}` };
  }
  const datos = { disponible: true, apiKeyId, dias: Object.values(porDia).sort((a, b) => b.dia.localeCompare(a.dia)), actualizado: new Date().toISOString() };
  if (!cliente) cache = { clave, hasta: Date.now() + MINUTOS_CACHE * 60e3, datos };
  return datos;
}
