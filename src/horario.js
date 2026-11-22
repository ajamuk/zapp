import { config } from './config.js';

/** Hora local (0-23) en la zona del negocio. */
export function horaLocal(date = new Date(), tz = config.tz) {
  return Number(new Intl.DateTimeFormat('es-ES', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(date));
}

/** ¿Está la IA en su franja de respuesta? inicio=8, fin=0 → de 8:00 a 23:59. */
const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
/** Día de la semana local (lunes…domingo, sin tildes). */
export function diaLocal(date = new Date(), tz = config.tz) {
  const d = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: tz }).format(date);
  return DIAS[['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(d)];
}

/** ¿Está la IA en su franja de respuesta? Por día si hay horario por día (null = ese día no contesta). */
export function dentroDeHorario(date = new Date(), { inicio = config.ai.horaInicio, fin = config.ai.horaFin, tz = config.tz, dias = config.ai.horarioDias || {} } = {}) {
  const dia = diaLocal(date, tz);
  if (dia in dias) {
    if (dias[dia] === null) return false;
    ({ desde: inicio, hasta: fin } = dias[dia]);
  }
  const h = horaLocal(date, tz);
  const finEf = fin === 0 ? 24 : fin;
  return inicio < finEf ? h >= inicio && h < finEf : h >= inicio || h < finEf;
}

/** Siguiente instante en que la IA puede contestar (para guardar mensajes fuera de horario). */
export function siguienteApertura(date = new Date(), opts = {}) {
  const d = new Date(date);
  for (let i = 0; i < 8 * 24 * 4; i++) { // hasta una semana (por si hay días cerrados)
    if (dentroDeHorario(d, opts)) return d;
    d.setMinutes(d.getMinutes() + 15, 0, 0);
  }
  return d;
}

/** Fecha de hoy en la zona del negocio, AAAA-MM-DD y día de la semana. */
export function hoyLocal(date = new Date(), tz = config.tz) {
  const f = new Intl.DateTimeFormat('es-ES', { timeZone: tz, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const g = (t) => f.find((p) => p.type === t)?.value;
  return { iso: `${g('year')}-${g('month')}-${g('day')}`, dia: g('weekday') };
}

export const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retardo humano: espera aleatoria + tiempo de escritura según longitud. */
export function retardoHumano(textos, { min = config.ai.minDelay, max = config.ai.maxDelay, velocidad = config.ai.typingSpeed, tope = config.ai.typingMax, random = Math.random } = {}) {
  const lectura = (min + random() * (max - min)) * 1000;
  const escritura = textos.map((t) => Math.min(tope * 1000, (t.length / Math.max(1, velocidad)) * 1000));
  return { lectura, escritura };
}
