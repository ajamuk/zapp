import fs from 'node:fs';
import { leerAjustes } from './ajustes.js';

/**
 * Plazas de apertura de El Cañaveral ya ocupadas.
 *
 * La fuente es el registro que el servicio «metro-paid-signup-sheet» saca cada hora del AimHarder de El Cañaveral
 * (el mismo que alimenta la hoja «El Cañaveral · Promoción de apertura · 200 plazas»): una entrada por socio anotado.
 * A eso se suman las altas que Sofía ha pasado al equipo y que todavía no aparecen en ese registro (se emparejan por
 * teléfono, para no contar dos veces a la misma persona). Si el registro no se puede leer, se usa el número que el
 * equipo tenga apuntado en Ajustes.
 */
const RUTA = '/var/lib/metro-paid-signup-sheet/el-canaveral/ledger.json';
const tel9 = (t) => String(t ?? '').replace(/\D/g, '').slice(-9);

export function rutaRegistro() {
  if (process.env.CANAVERAL_REGISTRO != null) return process.env.CANAVERAL_REGISTRO || null;
  return process.env.NODE_TEST_CONTEXT ? null : RUTA; // en los tests no se lee el registro real
}

/** Lee el registro: { anotados, telefonos, actualizado } o null si no existe o no tiene la forma esperada. */
export function leerRegistro(ruta = rutaRegistro()) {
  if (!ruta) return null;
  try {
    const d = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    const filas = Object.values(d);
    if (filas.some((f) => !f || typeof f.tab !== 'string' || !Array.isArray(f.row))) return null;
    return { anotados: filas.length, telefonos: new Set(filas.map((f) => tel9(f.row[2])).filter((t) => t.length === 9)), actualizado: fs.statSync(ruta).mtime.toISOString() };
  } catch { return null; }
}

/** Total de plazas ocupadas y de dónde sale. `sinConv`: no contar el alta de ese chat (es la que se está tramitando). */
export function plazasCanaveral(repo, { sinConv = null, ruta } = {}) {
  const registro = leerRegistro(ruta);
  const altas = repo.db.prepare(`SELECT conversation_id AS c, json_extract(datos, '$.telefono') AS tel FROM altas
    WHERE json_extract(datos, '$.sede') = 'el_canaveral' AND estado != 'rechazada' AND conversation_id != ? GROUP BY conversation_id`).all(sinConv || '');
  const propias = altas.filter((a) => !registro?.telefonos.has(tel9(a.tel))).length;
  const base = registro ? registro.anotados : (leerAjustes(repo).canaveralPlazasOcupadas || 0);
  return { total: base + propias, origen: registro ? 'registro' : 'manual', base, propias, actualizado: registro?.actualizado || null };
}
