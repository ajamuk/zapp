import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const read = (f) => fs.readFileSync(path.join(config.root, 'config', f), 'utf8');
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
  const nombres = { parla: 'Parla', getafe: 'Getafe', las_rosas: 'Las Rosas' };
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
  festivos,
  followups: readJson('followups.json'),
  etiquetas: readJson('etiquetas.json'),
};

const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];

export function normalizarSede(s) {
  if (!s) return null;
  const t = String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (t.includes('parla')) return 'parla';
  if (t.includes('getafe') || t.includes('bercial')) return 'getafe';
  if (t.includes('rosas') || t.includes('rozas') || t.includes('san blas')) return 'las_rosas';
  if (t.includes('canaveral') || t.includes('vicalvaro')) return 'el_canaveral';
  return null;
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

/** Horario habitual publicado filtrado por sede, modalidad y franja (manana | tarde). */
export function consultarHorarios({ sede, modalidad, franja }) {
  const s = normalizarSede(sede);
  const m = normalizarModalidad(modalidad);
  if (s === 'el_canaveral') return { ok: false, error: 'El Cañaveral abre el 1 de febrero de 2027 y sus horarios aún no están publicados (los de CrossFit + HYROX, pendientes de confirmar). Pregunta su disponibilidad (mañana o tarde) y anótala; no inventes horas.' };
  if (!s || !m) return { ok: false, error: 'Falta la sede (parla, getafe, las_rosas) o la modalidad (academy, crossfit, hyrox, open_box, halterofilia, crossfit_partner).' };
  if (!knowledge.horarios[s]?.[m]) return { ok: true, sede: s, modalidad: m, dias: {}, aviso: `En esta sede no hay ${m.replace('_', ' ')}.` };
  const f = franja ? (String(franja).toLowerCase().startsWith('m') ? 'manana' : 'tarde') : null;
  const tabla = knowledge.horarios[s]?.[m] || {};
  // Días sueltos con horario especial (Nochebuena, Nochevieja…): ese día el habitual no vale.
  const hoy = new Date().toISOString().slice(0, 10);
  const especiales = Object.entries(knowledge.horarios._especiales?.[s] || {}).filter(([f]) => f >= hoy).map(([fecha, clases]) => ({ fecha, horas: clases[m] || [], nota: clases[m] ? 'ese día solo estas horas' : `ese día hay horario especial y no hay ${m.replace('_', ' ')} publicado` }));
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

/** El Cañaveral (abre el 1 feb 2027): cuota habitual y precio de apertura de febrero a abril según el tramo. */
function tarifasCanaveral(fam, dias) {
  const o = knowledge.tarifas.apertura_el_canaveral;
  const euros = (n) => Math.round(n * 100) / 100;
  const n = Number(dias);
  const claves = fam === 'academy' ? ['academy_1', 'academy_2', 'academy_3'] : fam === 'crossfit_hyrox' ? ['S', 'M', 'L', 'XL'] : ['academy_1', 'academy_2', 'academy_3', 'S', 'M', 'L', 'XL'];
  const opciones = claves.map((k) => ({
    clave: k, descripcion: k.startsWith('academy') ? `Academy ${k.at(-1)} día${k.at(-1) === '1' ? '' : 's'} por semana` : `CrossFit + HYROX ${k}`, clases_mes: o.clases_mes[k],
    euros_mes_habitual_desde_mayo: o.habitual[k],
    euros_mes_apertura_feb_a_abr: Object.fromEntries(o.tramos.map((t) => [`-${t.descuento}% (plazas ${t.plazas})`, euros(o.habitual[k] * (1 - t.descuento / 100))])),
  }));
  const rec = !n ? null : fam === 'academy' ? `academy_${Math.max(1, Math.min(3, n))}` : fam === 'crossfit_hyrox' ? (n <= 1 ? 'S' : n === 2 ? 'M' : n === 3 ? 'L' : 'XL') : null;
  return {
    ok: true, sede: 'el_canaveral', familia: fam || 'todas', opciones, recomendada: rec ? opciones.find((x) => x.clave === rec) : null,
    notas: 'Abre el 1 de febrero de 2027. Sin matrícula ni permanencia. El descuento vale febrero, marzo y abril de 2027; desde mayo, la cuota habitual. El tramo se asigna por orden de primer pago completado y el pago aún no está habilitado: no garantices tramo ni plaza, ni digas cuántas quedan (está por confirmar). Regalos en cualquier tramo: comba profesional y plaza en un seminario exclusivo. No mezclar con precios de otras sedes.',
  };
}

/** Tarifas oficiales de una sede y familia; con días devuelve la recomendada. */
export function consultarTarifas({ sede, familia, dias_por_semana }) {
  const s = normalizarSede(sede);
  const mod = normalizarModalidad(familia);
  const fam = mod === 'academy' ? 'academy' : ['crossfit', 'hyrox'].includes(mod) || String(familia).includes('crossfit') ? 'crossfit_hyrox' : null;
  if (s === 'el_canaveral') return tarifasCanaveral(fam, dias_por_semana);
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
export function calcularPrimerRecibo({ sede, tarifa, fecha_inicio }) {
  const s = normalizarSede(sede);
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
