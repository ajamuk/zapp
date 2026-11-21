// Clase de prueba (solo Parla): reserva directa en AimHarder como invitado y seguimiento del resultado.
//
// - Reserva: la API pública de AimHarder (POST /classes/booking/guest) con la sesión real del calendario de ese día.
//   Solo escribe con AIMHARDER_RESERVA_PRUEBA=true y Sofía en live; si no, la reserva queda «simulada» y la
//   confirma el equipo como antes.
// - Resultado: después de la clase se mira (1) la reserva de AimHarder (cancelada / marcada como ausencia),
//   (2) metro-trial-ops, que sigue las pruebas de los calendarios de GHL y verifica asistencia y alta, y
//   (3) si ya es socio o Sofía le hizo el alta. Con eso el seguimiento «después de la prueba» pregunta qué tal
//   y ofrece el alta, propone otro día si no vino, o no sale si ya se ha apuntado.
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { horaMadrid } from './followups.js';

export const SEDES_RESERVA = ['parla'];

/** Nombre de la clase en AimHarder para cada modalidad de prueba. */
const CLASE = { academy: /academy/i, crossfit: /^\s*crossfit\s*$/i, hyrox: /hyrox/i };

export const RESULTADOS = {
  asistio: 'vino a la clase',
  sin_ausencia: 'la clase ya pasó y AimHarder no la marca como ausencia',
  no_vino: 'no vino a la clase',
  cancelada: 'anuló la clase',
  alta: 'ya se ha dado de alta',
  sin_dato: 'sin datos de asistencia',
};

export function crearTabla(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS pruebas_clase (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    sede TEXT NOT NULL,
    modalidad TEXT NOT NULL,
    fecha_hora TEXT NOT NULL,          -- AAAA-MM-DD HH:MM (hora de Madrid)
    estado TEXT NOT NULL,              -- reservada | simulada | fallida | anulada
    schedule_id INTEGER,
    booking_id TEXT,
    nombre TEXT,
    detalle TEXT,
    resultado TEXT,                    -- asistio | sin_ausencia | no_vino | cancelada | alta | sin_dato
    resultado_fuente TEXT,
    resultado_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS pruebas_clase_conv ON pruebas_clase(conversation_id, id);`);
}

export const ultimaPrueba = (db, convId) => db.prepare("SELECT * FROM pruebas_clase WHERE conversation_id = ? AND estado != 'anulada' ORDER BY id DESC LIMIT 1").get(convId) || null;

export function guardarPrueba(db, p) {
  const r = db.prepare(`INSERT INTO pruebas_clase (conversation_id, sede, modalidad, fecha_hora, estado, schedule_id, booking_id, nombre, detalle)
    VALUES (@conversation_id, @sede, @modalidad, @fecha_hora, @estado, @schedule_id, @booking_id, @nombre, @detalle)`)
    .run({ schedule_id: null, booking_id: null, nombre: null, detalle: null, ...p });
  return Number(r.lastInsertRowid);
}

export function actualizarPrueba(db, id, patch) {
  const campos = Object.keys(patch);
  if (!campos.length) return;
  db.prepare(`UPDATE pruebas_clase SET ${campos.map((c) => `${c} = @${c}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`).run({ ...patch, id });
}

/** Separa «Nombre Apellido1 Apellido2» en lo que pide AimHarder. */
export function partirNombre(completo) {
  const p = String(completo || '').trim().split(/\s+/).filter(Boolean);
  return { name: p[0] || '', first_surname: p[1] || '', second_surname: p.slice(2).join(' ') };
}

/** Sesión del calendario de ese día para la modalidad y hora, o null. */
export function buscarSesion(sesiones, modalidad, hora) {
  const re = CLASE[modalidad];
  if (!re) return null;
  return (sesiones || []).find((s) => !s.cancelled && re.test(s.name || '') && String(s.time).slice(0, 5) === hora) || null;
}

/** Horas de esa modalidad ese día (para proponer otra si la pedida no existe). */
export function horasDe(sesiones, modalidad) {
  const re = CLASE[modalidad];
  return (sesiones || []).filter((s) => !s.cancelled && re?.test(s.name || '')).map((s) => String(s.time).slice(0, 5)).sort();
}

const idDe = (r) => {
  const v = r?.booking_id ?? r?.bookingId ?? r?.id ?? r?.guest_id ?? r?.data?.id ?? null;
  return v == null ? null : String(v);
};

/**
 * Reserva la clase de prueba como invitado. Devuelve { estado, schedule_id?, booking_id?, horas?, detalle }:
 *   reservada · simulada (no se escribe) · no_hay_clase (esa hora no existe ese día) · fallida (AimHarder no la aceptó)
 */
export async function reservarEnAimHarder(api, { modalidad, fecha, hora, nombre_completo, telefono, email, notas }, { escribir = false } = {}) {
  if (!api) return { estado: 'fallida', detalle: 'No hay acceso a la API de AimHarder de esa sede.' };
  let sesiones;
  try { sesiones = await api.calendario(fecha); } catch (e) { return { estado: 'fallida', detalle: `No se pudo leer el calendario de AimHarder: ${e.message}` }; }
  const sesion = buscarSesion(sesiones, modalidad, hora);
  if (!sesion) return { estado: 'no_hay_clase', horas: horasDe(sesiones, modalidad), detalle: `No hay clase de ${modalidad} a las ${hora} el ${fecha} en AimHarder.` };
  if (!escribir) return { estado: 'simulada', schedule_id: sesion.schedule_id, detalle: 'Reserva directa desactivada (modo prueba o AIMHARDER_RESERVA_PRUEBA≠true): no se ha escrito en AimHarder.' };
  const n = partirNombre(nombre_completo);
  const datos = { schedule_id: sesion.schedule_id, booking_date: fecha, name: n.name, ...(n.first_surname ? { first_surname: n.first_surname } : {}),
    ...(n.second_surname ? { second_surname: n.second_surname } : {}), ...(email ? { email } : {}), ...(telefono ? { phone: telefono } : {}),
    booking_notes: notas || 'Clase de prueba reservada por Sofía (WhatsApp/Instagram)' };
  try {
    const r = await api.reservarInvitado(datos);
    return { estado: 'reservada', schedule_id: sesion.schedule_id, booking_id: idDe(r), detalle: `Reservada en AimHarder (sesión ${sesion.schedule_id}).` };
  } catch (e) {
    return { estado: 'fallida', schedule_id: sesion.schedule_id, detalle: e.message };
  }
}

/** Resultado según la reserva de AimHarder: cancelada | no_vino | sin_ausencia | null (sin dato). */
export async function resultadoAimHarder(api, bookingId) {
  if (!api || !bookingId) return null;
  const g = await api.invitado(bookingId);
  if (!g) return null;
  if (g.cancellation_date) return 'cancelada';
  if (g.no_show === true || g.no_show === 1) return 'no_vino';
  return 'sin_ausencia';
}

/**
 * Pruebas que sigue metro-trial-ops (calendarios de prueba de GHL) para ese contacto, solo lectura.
 * Devuelve la última { center, class_type, start_time, lifecycle, outcome } o null.
 */
export function pruebaTrialOps(contactId, ruta = config.trialOps.db) {
  if (!ruta || !contactId || !fs.existsSync(ruta)) return null;
  let db;
  try {
    db = new Database(ruta, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 2000');
    return db.prepare(`SELECT center, class_type, start_time, lifecycle, outcome, appointment_status FROM trials
      WHERE contact_id = ? ORDER BY datetime(start_time) DESC LIMIT 1`).get(contactId) || null;
  } catch (e) {
    console.warn('[metro-trial-ops]', e.message);
    return null;
  } finally { db?.close(); }
}

/** outcome/lifecycle de metro-trial-ops → resultado de aquí (null si aún no hay). */
export function resultadoTrialOps(t) {
  if (!t) return null;
  const v = `${t.outcome || ''} ${t.lifecycle || ''}`;
  if (/converted/.test(v)) return 'alta';
  if (/no_show/.test(v)) return 'no_vino';
  if (/attended/.test(v)) return 'asistio';
  if (/cancel/.test(v) || /cancel/.test(t.appointment_status || '')) return 'cancelada';
  return null;
}

/** Texto corto de una prueba para el contexto de Sofía. */
export function describir(p, ahora = new Date()) {
  const cuando = fechaLegible(p.fecha_hora);
  const clase = horaMadrid(p.fecha_hora);
  const pasada = clase ? clase < ahora : false;
  const como = { reservada: 'reservada en AimHarder', simulada: 'pedida (el equipo la confirma)', fallida: 'pedida (el equipo la confirma)' }[p.estado] || p.estado;
  return `Clase de prueba de ${p.modalidad} en Parla el ${cuando}: ${como}${pasada && p.resultado ? `; resultado: ${RESULTADOS[p.resultado] || p.resultado}` : ''}.`;
}

export function fechaLegible(fechaHora) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(fechaHora || ''));
  if (!m) return String(fechaHora || '');
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  return `${d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })} a las ${m[4]}:${m[5]}`;
}

/** Instrucciones del seguimiento «después de la prueba» según el resultado. null = las de la regla tal cual. */
export function instruccionesTrasPrueba(resultado) {
  if (resultado === 'no_vino' || resultado === 'cancelada') {
    return {
      condicion: 'Envíalo salvo que en el chat ya haya explicado por qué no vino o haya dicho que no sigue.',
      instrucciones: `Según AimHarder ${RESULTADOS[resultado]}. No le preguntes qué tal la clase. Un mensaje breve y sin reproches: que no pasa nada y, si le apetece, le buscas otro día para la prueba (propón dos horas reales de su modalidad con consultar_horarios). Una sola pregunta.`,
    };
  }
  if (resultado === 'asistio' || resultado === 'sin_ausencia') {
    return {
      condicion: 'Envíalo salvo que después de la clase ya haya contado qué tal o haya dicho que no sigue.',
      instrucciones: `Según AimHarder ${RESULTADOS[resultado]} y todavía no tiene el alta. Un mensaje breve y cercano: pregúntale qué tal la clase y, en la misma pregunta, si quiere que le dejes el alta preparada (con la tarifa que ya hablasteis, si la hay). Sin presión y sin dar precios nuevos.`,
    };
  }
  return null;
}
