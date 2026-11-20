import { config } from './config.js';
import * as reglas from './reglas.js';

/**
 * Ajustes que se cambian desde el panel sin reiniciar (se guardan en la base de datos).
 * Lo que no esté guardado sale de .env / config. El modo (prueba o real) NO se cambia desde aquí:
 * pasar a real es una decisión de producción y va en .env.
 */
export function leerAjustes(repo) {
  const g = repo.ajustesGuardados();
  // Interruptores de los seguimientos: viven en cada regla (tabla reglas_seguimiento)
  const seguimientos = Object.fromEntries(reglas.listar(repo.db).map((r) => [r.id, r.activo]));
  return {
    ia_activa: g.ia_activa ?? true,
    canales: { whatsapp: g.canales?.whatsapp ?? true, instagram: g.canales?.instagram ?? true },
    horaInicio: g.horaInicio ?? config.ai.horaInicio,
    horaFin: g.horaFin ?? config.ai.horaFin,
    minDelay: g.minDelay ?? config.ai.minDelay,
    maxDelay: g.maxDelay ?? config.ai.maxDelay,
    typingSpeed: g.typingSpeed ?? config.ai.typingSpeed,
    seguimientos,
  };
}

/** Aplica los ajustes guardados a la configuración en memoria (horario y retrasos). */
export function aplicarAjustes(repo) {
  const a = leerAjustes(repo);
  Object.assign(config.ai, { horaInicio: a.horaInicio, horaFin: a.horaFin, minDelay: a.minDelay, maxDelay: a.maxDelay, typingSpeed: a.typingSpeed });
  return a;
}

const hora = (v) => Number.isInteger(v) && v >= 0 && v <= 23;

/** Valida y guarda un cambio parcial. Devuelve los ajustes nuevos o lanza un error legible. */
export function guardarAjustes(repo, cambio = {}) {
  const actual = leerAjustes(repo);
  const n = { ...actual, ...cambio, canales: { ...actual.canales, ...(cambio.canales || {}) }, seguimientos: { ...actual.seguimientos, ...(cambio.seguimientos || {}) } };
  if (typeof n.ia_activa !== 'boolean') throw new Error('ia_activa debe ser sí o no');
  if (!hora(n.horaInicio) || !hora(n.horaFin)) throw new Error('Las horas van de 0 a 23');
  if (!(n.minDelay >= 0 && n.maxDelay >= n.minDelay && n.maxDelay <= 600)) throw new Error('Retraso: mínimo ≥ 0, máximo ≥ mínimo y como mucho 600 s');
  if (!(n.typingSpeed >= 1 && n.typingSpeed <= 20)) throw new Error('Velocidad de escritura: de 1 a 20 letras por segundo');
  for (const [id, on] of Object.entries(cambio.seguimientos || {})) repo.db.prepare('UPDATE reglas_seguimiento SET activo = ? WHERE id = ?').run(on ? 1 : 0, id);
  for (const k of ['ia_activa', 'canales', 'horaInicio', 'horaFin', 'minDelay', 'maxDelay', 'typingSpeed']) {
    if (JSON.stringify(n[k]) !== JSON.stringify(actual[k])) repo.guardarAjuste(k, n[k]);
  }
  return aplicarAjustes(repo);
}
