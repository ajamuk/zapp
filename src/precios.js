// Precios de la API de Anthropic y coste de cada llamada, calculado con lo que devuelve la propia respuesta.
//
// Por millón de tokens, en dólares: [entrada, salida, lectura de caché, escritura de caché 5 min].
// La escritura de caché de 1 hora cuesta el doble de la entrada. Fuente: tabla de precios de Anthropic (nov. 2026).
// Si Anthropic cambia un precio, se cambia aquí: las llamadas ya apuntadas guardan su coste y no se recalculan.
export const PRECIOS = {
  'claude-sonnet-5-5': [2, 10, 0.10, 2.5],
  'claude-opus-5-5': [4, 20, 0.20, 5],
  'claude-haiku-5-5': [0.10, 0.50, 0.01, 0.125],
  // Modelos a los que puede saltar el respaldo automático (fallbacks) cuando el principal se niega
  'claude-sonnet-5': [2, 10, 0.20, 2.5],
  'claude-opus-5': [5, 25, 0.50, 6.25],
  'claude-opus-4-8': [5, 25, 0.50, 6.25],
  'claude-opus-4-7': [5, 25, 0.50, 6.25],
  'claude-sonnet-4-6': [3, 15, 0.30, 3.75],
  'claude-haiku-4-5': [1, 5, 0.10, 1.25],
  'claude-fable-5-2': [8, 40, 0.20, 10],
};
// Haiku 5.5 cobra 5 veces más cuando el prompt pasa de 100.000 tokens
const HAIKU_LARGO = { modelo: 'claude-haiku-5-5', umbral: 100000, factor: 5 };

/** Nombre canónico del modelo (quita sufijos de fecha) y si su precio es conocido. */
export function modeloConocido(modelo) {
  const m = String(modelo || '');
  if (PRECIOS[m]) return m;
  return Object.keys(PRECIOS).sort((a, b) => b.length - a.length).find((k) => m.startsWith(k)) || null;
}

function precioDe(modelo) {
  const m = modeloConocido(modelo);
  if (m) return PRECIOS[m];
  // Modelo nuevo sin precio en la tabla: se cuenta al precio más caro de su familia para no quedarse corto
  const familia = /haiku/.test(modelo) ? 'claude-haiku-5-5' : /sonnet/.test(modelo) ? 'claude-sonnet-5-5' : /opus/.test(modelo) ? 'claude-opus-5' : 'claude-fable-5-2';
  return PRECIOS[familia];
}

/** Coste en dólares de una fila de uso (tokens ya separados por tipo). */
export function costeUso(r) {
  let [pin, pout, pread, pw5] = precioDe(r.modelo);
  const w1h = r.tokens_cache_write_1h || 0;
  const w5 = Math.max(0, (r.tokens_cache_write || 0));
  const prompt = (r.tokens_in || 0) + (r.tokens_cache_read || 0) + w5 + w1h;
  let pw1h = pin * 2;
  if (modeloConocido(r.modelo) === HAIKU_LARGO.modelo && prompt > HAIKU_LARGO.umbral) {
    const f = HAIKU_LARGO.factor; pin *= f; pout *= f; pread *= f; pw5 *= f; pw1h *= f;
  }
  return ((r.tokens_in || 0) * pin + (r.tokens_out || 0) * pout + (r.tokens_cache_read || 0) * pread + w5 * pw5 + w1h * pw1h) / 1e6;
}

/** Coste de una fila de ai_runs: el guardado al hacer la llamada o, en filas antiguas, recalculado. */
export const costeRun = (r) => (r.coste_usd != null ? r.coste_usd : costeUso(r));

/**
 * Filas de uso facturable de una respuesta de la API. Si el modelo principal se negó y respondió otro (fallbacks),
 * `usage.iterations` trae un intento por modelo y cada uno se cobra a su precio; la `usage` de arriba solo cuenta
 * el último. Se apunta el modelo que respondió de verdad, no el que se pidió.
 */
export function usosDe(res, modeloPedido) {
  const u = res?.usage || {};
  const its = (u.iterations || []).filter((i) => i.type === 'message' || i.type === 'fallback_message');
  const partes = its.length ? its : [{ ...u, model: res?.model }];
  return partes.map((p) => {
    const w1h = p.cache_creation?.ephemeral_1h_input_tokens || 0;
    const fila = {
      modelo: p.model || modeloPedido,
      tokens_in: p.input_tokens || 0, tokens_out: p.output_tokens || 0,
      tokens_cache_read: p.cache_read_input_tokens || 0,
      tokens_cache_write: Math.max(0, (p.cache_creation_input_tokens || 0) - w1h), tokens_cache_write_1h: w1h,
      respaldo: p.type === 'fallback_message' ? 1 : 0,
    };
    return { ...fila, coste_usd: costeUso(fila) };
  }).filter((f) => f.tokens_in || f.tokens_out || f.tokens_cache_read || f.tokens_cache_write || f.tokens_cache_write_1h);
}
