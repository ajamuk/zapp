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
    // Se avanza por cuartos de hora en punto: un mensaje de las 7:54 se contesta a las 8:00, no a las 8:09
    d.setMinutes(Math.floor(d.getMinutes() / 15) * 15 + 15, 0, 0);
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

/**
 * Retardo humano. Devuelve, en milisegundos:
 * - `lectura`: lo que tarda Sofía en ver el mensaje y ponerse a contestar. Al azar entre `min` y `max` (Ajustes),
 *   más lo que se tarda en leer lo que ha escrito el lead (`leido`, en letras; unas 30 por segundo, 6 s como mucho).
 *   Si la conversación está `caliente` (Sofía acaba de escribir y el lead contesta enseguida), se queda en el tramo
 *   bajo de la franja: quien ya está en el chat contesta antes que quien tiene que abrirlo.
 * - `escritura`: espera antes de cada burbuja, según su longitud y la velocidad de Ajustes. Cada una varía un ±20 %
 *   para que no lleguen a intervalos clavados; las largas pasan del `tope` solo un poco (un 20 % del exceso, hasta
 *   1,75 × tope) en vez de tardar todas lo mismo; y de la segunda en adelante hay una pausa corta entre burbuja y
 *   burbuja, para que dos frases cortas no salgan pegadas.
 */
export function retardoHumano(textos, { min = config.ai.minDelay, max = config.ai.maxDelay, velocidad = config.ai.typingSpeed, tope = config.ai.typingMax, random = Math.random, caliente = false, leido = 0 } = {}) {
  const franja = Math.max(0, max - min) * (caliente ? 0.4 : 1);
  const lectura = (min + random() * franja + Math.min(6, Math.max(0, leido) / 30)) * 1000;
  const escritura = textos.map((t, i) => {
    const bruto = String(t).length / Math.max(1, velocidad);
    const base = bruto <= tope ? bruto : Math.min(tope * 1.75, tope + (bruto - tope) * 0.2);
    const pausa = i === 0 ? 0 : 0.8 + random() * 1.2; // entre burbujas: releer, pensar la siguiente
    return Math.round((base * (0.8 + random() * 0.4) + pausa) * 1000);
  });
  return { lectura, escritura };
}

/** ¿Está el chat «caliente»? Sofía escribió hace menos de 3 minutos: se supone que sigue con el chat abierto. */
export const chatCaliente = (ultimoIa, ahora = new Date()) => { const t = ultimoIa ? ahora.getTime() - new Date(ultimoIa).getTime() : NaN; return t >= 0 && t < 3 * 60000; };
