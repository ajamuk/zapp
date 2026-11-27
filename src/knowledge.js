import fs from 'node:fs';
import path from 'node:path';
import { config, rutaConfig } from './config.js';
import { hoyLocal } from './horario.js';

const read = (f) => fs.readFileSync(rutaConfig(f), 'utf8');
const readJson = (f) => JSON.parse(read(f));

const festivos = readJson('festivos.json');

/** Lista de festivos por sede (comunes + locales), ordenada, para la base de conocimiento. */
export function festivosDeSede(sede, f = festivos) {
  return [...f.comunes, ...(f.locales[sede] || [])].sort((a, b) => a.fecha.localeCompare(b.fecha));
}

export function textoFestivos(f = festivos) {
  const fmt = (x) => {
    const d = new Date(`${x.fecha}T12:00:00Z`);
    const dia = d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    return `- ${dia}: ${x.nombre}`;
  };
  // Sedes con festivos propios en festivos.json (si no hay ninguna, todas las del negocio)
  const conFestivos = config.negocio.sedes.filter((s) => f.locales?.[s.id] || f.pendientes?.[s.id]);
  const nombres = Object.fromEntries((conFestivos.length ? conFestivos : config.negocio.sedes).map((s) => [s.id, s.nombre]));
  return ['## Festivos (el box cierra)', '',
    'Si preguntan por un día concreto, comprueba si está aquí. Si no está, ese día se abre con el horario habitual.', '',
    ...Object.entries(nombres).flatMap(([k, n]) => [`### ${n}`, ...festivosDeSede(k, f).map(fmt), ...(f.pendientes?.[k] ? [`- Pendiente: ${f.pendientes[k]} Si preguntan por esas fechas, dilo y que se confirma más adelante.`] : []), '']),
  ].join('\n');
}

/** El horario del repo, o la copia que el servicio mantiene al día desde AimHarder (junto a la base) si es más reciente. */
function horariosIniciales() {
  const repo = readJson('horarios.json');
  if (process.env.NODE_TEST_CONTEXT) return repo;
  try {
    const copia = JSON.parse(fs.readFileSync(path.join(path.dirname(config.dbPath), 'horarios.json'), 'utf8'));
    const fecha = (h) => h._nota?.match(/\d{4}-\d{2}-\d{2}/)?.[0] || '';
    return fecha(copia) >= fecha(repo) ? copia : repo;
  } catch { return repo; }
}

export const knowledge = {
  prompt: read('prompt-sofia.md'),
  negocio: `${read('negocio.md')}\n\n${textoFestivos()}`,
  horarios: horariosIniciales(),
  tarifas: readJson('tarifas.json'),
  followups: readJson('followups.json'),
  etiquetas: readJson('etiquetas.json'),
  cierres: readJson('cierres.json'),
};

const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];

export function normalizarSede(s) {
  if (!s) return null;
  const t = String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  // La primera sede de config/negocio.json con algún alias en el texto
  return config.negocio.sedes.find((x) => x.id === t || x.alias.some((a) => t.includes(a)))?.id ?? null;
}

export function normalizarModalidad(m) {
  const t = String(m || '').toLowerCase();
  if (t.includes('academy') || t.includes('inicia') || t.includes('principiante')) return 'academy';
  if (t.includes('hyrox')) return 'hyrox';
  if (t.includes('open')) return 'open_box';
  if (t.includes('halter')) return 'halterofilia';
  if (t.includes('partner')) return 'crossfit_partner';
  if (t.includes('crossfit') || t.includes('cross')) return 'crossfit';
  return null;
}

const enFranja = (hora, franja) => {
  if (!franja) return true;
  const h = Number(hora.slice(0, 2));
  return franja === 'manana' ? h < 14 : h >= 14;
};

/**
 * Días en que la sede cierra antes (config/cierres.json): las clases habituales de ese día de la semana que
 * terminan antes del cierre (duran una hora). Si AimHarder ya publica un horario especial para la fecha, no se añade.
 */
export function cierresAnticipados(sede, modalidad, { hoy = hoyLocal().iso, cierres = knowledge.cierres } = {}) {
  const min = (h) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
  return Object.entries(cierres[sede] || {}).filter(([fecha]) => fecha >= hoy && !knowledge.horarios._especiales?.[sede]?.[fecha]).sort().map(([fecha, c]) => {
    const dia = DIAS[(new Date(`${fecha}T12:00:00Z`).getUTCDay() + 6) % 7];
    const horas = (knowledge.horarios[sede]?.[modalidad]?.[dia] || []).filter((h) => min(h) + 60 <= min(c.cierra));
    return { fecha, horas, nota: `${c.motivo ? `${c.motivo}: ` : ''}ese día el centro cierra a las ${c.cierra}; ${horas.length ? 'solo estas horas' : `no hay ${modalidad.replace('_', ' ')}`}` };
  });
}

/**
 * Horario habitual publicado filtrado por sede, modalidad y franja (manana | tarde). `hoy` (AAAA-MM-DD en la zona
 * del negocio) decide qué días especiales ya han pasado; el setter pasa el de su reloj.
 */
export function consultarHorarios({ sede, modalidad, franja }, { hoy = hoyLocal().iso } = {}) {
  const s = normalizarSede(sede);
  const m = normalizarModalidad(modalidad);
  if (s === 'el_canaveral') return { ok: false, error: 'El Cañaveral abre el 1 de febrero de 2027 y sus horarios aún no están publicados (los de CrossFit + HYROX, pendientes de confirmar). Pregunta su disponibilidad (mañana o tarde) y anótala; no inventes horas.' };
  if (!s || !m) return { ok: false, error: 'Falta la sede (parla, getafe, las_rosas) o la modalidad (academy, crossfit, hyrox, open_box, halterofilia, crossfit_partner).' };
  if (!knowledge.horarios[s]?.[m]) return { ok: true, sede: s, modalidad: m, dias: {}, aviso: `En esta sede no hay ${m.replace('_', ' ')}.` };
  const f = franja ? (String(franja).toLowerCase().startsWith('m') ? 'manana' : 'tarde') : null;
  const tabla = knowledge.horarios[s]?.[m] || {};
  // Días sueltos con horario especial (Nochebuena, Nochevieja…): ese día el habitual no vale.
  const especialesAh = Object.entries(knowledge.horarios._especiales?.[s] || {}).filter(([f]) => f >= hoy).map(([fecha, clases]) => ({ fecha, horas: clases[m] || [], nota: clases[m] ? 'ese día solo estas horas' : `ese día hay horario especial y no hay ${m.replace('_', ' ')} publicado` }));
  const especiales = [...especialesAh, ...cierresAnticipados(s, m, { hoy })].sort((a, b) => a.fecha.localeCompare(b.fecha));
  const dias = {};
  for (const d of DIAS) {
    const horas = (tabla[d] || []).filter((h) => enFranja(h, f));
    if (horas.length) dias[d] = horas;
  }
  return { ok: true, sede: s, modalidad: m, franja: f, dias, ...(especiales.length ? { dias_con_horario_especial: especiales } : {}), aviso: 'Horario habitual publicado; no confirma plazas libres. Las plazas se ven en la app.' };
}

export function tarifaRecomendada(familia, dias) {
  const n = Number(dias);
  if (familia === 'academy') return n >= 3 ? 'academy_3' : 'academy_2';
  if (!n) return null;
  if (n <= 1) return 'S';
  if (n === 2) return 'M';
  if (n === 3) return 'L';
  return 'XL';
}

/** Cómo se paga la primera mensualidad en El Cañaveral, según esté o no habilitado el pago en la app. */
export function pagoCanaveral() {
  return knowledge.tarifas.apertura_el_canaveral.pago_habilitado
    ? 'La primera mensualidad se paga al tramitar el alta, desde la app, sin esperar a febrero; el descuento queda fijado al completar ese pago.'
    : 'El recibo de la primera mensualidad se emite el día del alta, pero el pago en la app TODAVÍA NO ESTÁ HABILITADO: no le digas que pague ya. Se le avisa por aquí en cuanto se pueda pagar y lo hace entonces desde la app, sin esperar a febrero. Su plaza queda anotada con el descuento del tramo por orden de alta y se confirma al completar ese pago.';
}

/** Tramo de apertura de El Cañaveral que toca a la siguiente plaza, según las que ya están ocupadas. */
export function tramoCanaveral(ocupadas = 0) {
  const plaza = Math.max(0, Math.floor(Number(ocupadas) || 0)) + 1;
  const t = knowledge.tarifas.apertura_el_canaveral.tramos.find((x) => plaza <= Number(x.plazas.split(' a ')[1]));
  return { plaza, descuento: t ? t.descuento : 0, plazas: t ? t.plazas : null };
}

/**
 * Alta en El Cañaveral: empieza como pronto el día de la apertura (1 feb 2027), con el descuento del tramo en las
 * cuotas hasta abril de 2027 y la primera mensualidad pagada el día del alta.
 */
export function ofertaCanaveral({ tarifa, fecha_inicio, plazas_ocupadas = 0 }) {
  const o = knowledge.tarifas.apertura_el_canaveral;
  const cuota = o.habitual[tarifa];
  if (!cuota) return { ok: false, error: 'Tarifa no válida en El Cañaveral (academy_1, academy_2, academy_3, S, M, L o XL).' };
  const inicio = /^\d{4}-\d{2}-\d{2}$/.test(String(fecha_inicio)) && fecha_inicio > o.apertura ? fecha_inicio : o.apertura;
  const [y, mo, d] = inicio.split('-').map(Number);
  const diasMes = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > diasMes) return { ok: false, error: 'Fecha no válida.' };
  const tramo = tramoCanaveral(plazas_ocupadas);
  const descuento = inicio <= o.descuento_hasta ? tramo.descuento : 0;
  const r2 = (n) => Math.round(n * 100) / 100;
  const conDescuento = r2(cuota * (1 - descuento / 100));
  const restantes = diasMes - d + 1;
  return {
    ok: true, sede: 'el_canaveral', tarifa, fecha_inicio: inicio, cuota_mensual: cuota, descuento_pct: descuento, tramo_plazas: descuento ? tramo.plazas : null,
    cuota_con_descuento: conDescuento, descuento_hasta: descuento ? o.descuento_hasta : null,
    dias_restantes: restantes, dias_mes: diasMes, primer_recibo: r2(conDescuento * restantes / diasMes),
    pago_habilitado: Boolean(o.pago_habilitado),
    nota: (descuento
      ? `Empieza el ${inicio}. Paga ${conDescuento} €/mes en las cuotas hasta abril de 2027 (descuento de apertura del ${descuento} %) y ${cuota} €/mes desde mayo. `
      : `Empieza el ${inicio}. Cuota de ${cuota} €/mes, sin descuento de apertura. `) + pagoCanaveral(),
  };
}

/** El Cañaveral (abre el 1 feb 2027): cuota habitual y precio de apertura de febrero a abril según el tramo. */
function tarifasCanaveral(fam, dias, ocupadas = 0) {
  const o = knowledge.tarifas.apertura_el_canaveral;
  const euros = (n) => Math.round(n * 100) / 100;
  const n = Number(dias);
  const claves = fam === 'academy' ? ['academy_1', 'academy_2', 'academy_3'] : fam === 'crossfit_hyrox' ? ['S', 'M', 'L', 'XL'] : ['academy_1', 'academy_2', 'academy_3', 'S', 'M', 'L', 'XL'];
  const opciones = claves.map((k) => ({
    clave: k, descripcion: k.startsWith('academy') ? `Academy ${k.at(-1)} día${k.at(-1) === '1' ? '' : 's'} por semana` : `CrossFit + HYROX ${k}`, clases_mes: o.clases_mes[k],
    euros_mes_habitual_desde_mayo: o.habitual[k],
    euros_mes_apertura_feb_a_abr: Object.fromEntries(o.tramos.map((t) => [`-${t.descuento}% (plazas ${t.plazas})`, euros(o.habitual[k] * (1 - t.descuento / 100))])),
  }));
  const tramo = tramoCanaveral(ocupadas);
  const rec = !n ? null : fam === 'academy' ? `academy_${Math.max(1, Math.min(3, n))}` : fam === 'crossfit_hyrox' ? (n <= 1 ? 'S' : n === 2 ? 'M' : n === 3 ? 'L' : 'XL') : null;
  return {
    ok: true, sede: 'el_canaveral', familia: fam || 'todas', opciones, recomendada: rec ? opciones.find((x) => x.clave === rec) : null,
    regalos: { en_cualquier_tramo: true, comba: 'Comba profesional de regalo, se entrega en la apertura', seminario: 'Plaza en un seminario exclusivo; fecha, hora y acceso se confirmarán antes de celebrarlo (no hay más datos)' },
    tramo_actual: tramo.descuento ? { descuento_pct: tramo.descuento, plazas: tramo.plazas } : { descuento_pct: 0, nota: 'Las 200 plazas de apertura están cubiertas: cuota habitual.' },
    notas: 'Abre el 1 de febrero de 2027. Sin matrícula ni permanencia. El descuento vale febrero, marzo y abril de 2027; desde mayo, la cuota habitual. Ya se puede tramitar el alta: empieza el 1 de febrero. ' + pagoCanaveral() + ' Da el precio del tramo_actual (es el que se le aplica si se apunta ahora); no lo garantices a quien aún no se ha apuntado ni digas cuántas plazas quedan. Cuéntale siempre los regalos (ver «regalos»): entran en cualquier tramo. No mezclar con precios de otras sedes.',
  };
}

/** Tarifas oficiales de una sede y familia; con días devuelve la recomendada. */
export function consultarTarifas({ sede, familia, dias_por_semana, plazas_ocupadas }) {
  const s = normalizarSede(sede);
  const mod = normalizarModalidad(familia);
  const fam = mod === 'academy' ? 'academy' : ['crossfit', 'hyrox'].includes(mod) || String(familia).includes('crossfit') ? 'crossfit_hyrox' : null;
  if (s === 'el_canaveral') return tarifasCanaveral(fam, dias_por_semana, plazas_ocupadas);
  if (!s || !fam) return { ok: false, error: 'Falta la sede o la familia (academy o crossfit/hyrox).' };
  const t = knowledge.tarifas[s];
  const desc = knowledge.tarifas.descripciones;
  const claves = fam === 'academy' ? ['academy_2', 'academy_3'] : ['S', 'M', 'L', 'XL'];
  const opciones = claves.map((k) => ({ clave: k, descripcion: desc[k], euros_mes: t[k] }));
  const rec = dias_por_semana ? tarifaRecomendada(fam === 'academy' ? 'academy' : 'crossfit', dias_por_semana) : null;
  return {
    ok: true, sede: s, familia: fam, opciones,
    recomendada: rec ? opciones.find((o) => o.clave === rec) : null,
    notas: 'Sin matrícula ni permanencia. Detalle de clases y Open Box en la base de conocimiento. No mezclar con otras sedes.',
  };
}

/** Primer recibo prorrateado: días que quedan del mes (incluido el de inicio) sobre los días del mes. */
export function calcularPrimerRecibo({ sede, tarifa, fecha_inicio, plazas_ocupadas }) {
  const s = normalizarSede(sede);
  if (s === 'el_canaveral') return ofertaCanaveral({ tarifa, fecha_inicio, plazas_ocupadas });
  const cuota = knowledge.tarifas[s]?.[tarifa];
  if (!cuota) return { ok: false, error: 'Sede o tarifa no válidas.' };
  const m = String(fecha_inicio).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return { ok: false, error: 'fecha_inicio debe ser AAAA-MM-DD.' };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const diasMes = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d < 1 || d > diasMes) return { ok: false, error: 'Fecha no válida.' };
  const restantes = diasMes - d + 1;
  const importe = Math.round((cuota * restantes / diasMes) * 100) / 100;
  return { ok: true, cuota_mensual: cuota, dias_restantes: restantes, dias_mes: diasMes, primer_recibo: importe };
}

export function esFestivo(sede, fechaIso) {
  return festivosDeSede(normalizarSede(sede)).some((x) => x.fecha === fechaIso);
}
