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
  if (s === 'el_canaveral') return { ok: false, error: 'El Cañaveral abre el 1 de febrero de 2027; aún no hay horario publicado.' };
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

/** Tarifas oficiales de una sede y familia; con días devuelve la recomendada. */
export function consultarTarifas({ sede, familia, dias_por_semana }) {
  const s = normalizarSede(sede);
  if (s === 'el_canaveral') return { ok: false, error: 'El Cañaveral: ofertas de preapertura en preparación; no dar precios.' };
  const mod = normalizarModalidad(familia);
  const fam = mod === 'academy' ? 'academy' : ['crossfit', 'hyrox'].includes(mod) || String(familia).includes('crossfit') ? 'crossfit_hyrox' : null;
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
