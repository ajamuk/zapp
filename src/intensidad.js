// Intensidad de los seguimientos: cuántos mensajes recibe un lead que se queda callado y con qué tono.
// Se elige en el panel (Seguimientos) y se aplica a las reglas comerciales de «silencio» y «largo plazo».
// Las operativas (recordatorio de la prueba, información tras reservar…) salen igual en cualquier nivel.

export const NIVELES = {
  suave: {
    nombre: 'Suave',
    descripcion: 'Un solo seguimiento si se queda callado (el primero que sale pasadas 20 h) y uno a largo plazo. Tono informativo.',
    silencioMinHoras: 20, silencioMax: 1, largoPlazoMax: 1,
    tono: 'Intensidad suave: mensaje informativo y breve. No termines con una pregunta de cierre ni pidas una decisión; deja la puerta abierta.',
  },
  normal: {
    nombre: 'Normal',
    descripcion: 'Hasta dos seguimientos si se queda callado (pasadas 12 h, nunca a las pocas horas) y los de largo plazo. Una propuesta concreta, sin presión.',
    silencioMinHoras: 12, silencioMax: 2, largoPlazoMax: Infinity,
    tono: 'Intensidad normal: como mucho una propuesta concreta y fácil de responder, sin presión.',
  },
  intensa: {
    nombre: 'Intensa',
    descripcion: 'Todos los seguimientos activos, tal como están configurados.',
    silencioMinHoras: 0, silencioMax: Infinity, largoPlazoMax: Infinity,
    tono: '',
  },
};
export const NIVEL_POR_DEFECTO = 'normal';

export const nivelValido = (n) => (Object.hasOwn(NIVELES, n) ? n : NIVEL_POR_DEFECTO);
export function validarNivel(n) {
  if (!Object.hasOwn(NIVELES, n)) throw new Error(`Intensidad de seguimientos no válida: elige ${Object.keys(NIVELES).join(', ')}`);
  return n;
}

/** Normas para todos los seguimientos comerciales, sea cual sea el nivel. */
const NORMAS_COMUNES = [
  'No crees urgencia ni escasez (nada de «que no se pierda el hueco», «quedan pocas plazas», «solo hoy»).',
  'No des precios ni propongas el alta si el lead no preguntó por ellos.',
  'No repitas el argumento ni la propuesta de tus mensajes anteriores: si no hay nada nuevo que aportar, no lo envíes.',
];

/** Seguimiento operativo (no comercial): sale en cualquier nivel. */
export const esOperativa = (regla) => Boolean(regla?.excluir?.soloConPrueba);
const comercial = (r) => (r.tipo === 'silencio' || r.tipo === 'largo-plazo') && !esOperativa(r);

/** Cadena de largo plazo en orden (la primera y las que van detrás). */
function cadenaLargoPlazo(reglas) {
  const lp = reglas.filter((r) => r.tipo === 'largo-plazo');
  const out = []; const vistos = new Set();
  for (let r = lp.find((x) => !x.despuesDe); r && !vistos.has(r.id); r = lp.find((x) => x.despuesDe === r.id)) { vistos.add(r.id); out.push(r); }
  return out;
}

/**
 * Ids de las reglas comerciales que entran en el nivel (solo las activas cuentan). Las operativas y las de otros
 * tipos (etiqueta, cita, tras-cita) no se filtran: entran siempre.
 */
export function reglasDelNivel(reglas, nivel) {
  const n = NIVELES[nivelValido(nivel)];
  const silencio = reglas.filter((r) => r.tipo === 'silencio' && r.activo && !esOperativa(r) && r.minutos >= n.silencioMinHoras * 60)
    .sort((a, b) => a.minutos - b.minutos).slice(0, n.silencioMax);
  const largo = cadenaLargoPlazo(reglas).filter((r) => r.activo).slice(0, n.largoPlazoMax);
  return new Set([...silencio, ...largo].map((r) => r.id));
}

/** ¿Sale esta regla con este nivel? */
export function entraEnNivel(regla, reglas, nivel) {
  return !comercial(regla) || reglasDelNivel(reglas, nivel).has(regla.id);
}

/** ¿Es el último mensaje comercial de su cadena (silencio o largo plazo) con este nivel? */
export function esUltimaDelNivel(regla, reglas, nivel) {
  if (!comercial(regla)) return false;
  const ids = reglasDelNivel(reglas, nivel);
  const mismas = reglas.filter((r) => ids.has(r.id) && r.tipo === regla.tipo);
  if (regla.tipo === 'largo-plazo') return mismas.at(-1)?.id === regla.id; // ya van en el orden de la cadena
  return mismas.every((r) => r.minutos <= regla.minutos);
}

/** Líneas de tono que se añaden a las instrucciones de un seguimiento comercial. */
export function normasDeTono(regla, reglas, nivel) {
  if (!comercial(regla) || regla.modo === 'fijo') return [];
  const n = NIVELES[nivelValido(nivel)];
  return [
    'Normas de todos los seguimientos:', ...NORMAS_COMUNES.map((x) => `- ${x}`),
    n.tono ? `- ${n.tono}` : '',
    esUltimaDelNivel(regla, reglas, nivel) ? '- Es el último mensaje que le vas a mandar si no contesta: despídete con la puerta abierta, sin pregunta y sin pedirle nada.' : '',
    '- Puede que no se hayan enviado otros seguimientos anteriores: si la condición menciona uno que no aparece en la conversación, no lo tengas en cuenta.',
  ].filter(Boolean);
}
