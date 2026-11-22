// Reglas de seguimiento (follow-ups), editables desde el panel. Viven en la tabla `reglas_seguimiento`; la primera
// vez se copian de config/followups.json (con los interruptores que hubiera en Ajustes).
//
// Tipos:
//   silencio     — Sofía responde y el lead se queda callado: sale `minutos` después. Se cancela si el lead escribe.
//   etiqueta     — al ponerse una etiqueta: sale `minutos` después. Solo se cancela si quitan la etiqueta.
//   cita         — antes de la clase de prueba: sale `minutos` antes. Se cancela si se anula la prueba.
//   tras-cita    — después de la clase de prueba: sale `minutos` después de la hora de la clase. Igual que cita.
//   largo-plazo  — el lead lo deja para más adelante: en la fecha que da (o `minutos` después); `despues_de` encadena.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TIPOS = ['silencio', 'etiqueta', 'cita', 'tras-cita', 'largo-plazo'];
export const TIPOS_CITA = ['cita', 'tras-cita'];
const json = (t, d) => { try { return t ? JSON.parse(t) : d; } catch { return d; } };
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Fila → objeto que usa el código (con los alias de antes: dias, despuesDe, plantillaWhatsapp). */
export function deFila(f) {
  if (!f) return null;
  const excluir = json(f.excluir, {});
  return {
    id: f.id, nombre: f.nombre, tipo: f.tipo, canales: json(f.canales, []), minutos: f.minutos,
    dias: f.tipo === 'largo-plazo' ? Math.round(f.minutos / 1440) : undefined,
    despuesDe: f.despues_de || null, etiquetaId: f.etiqueta_id ?? null,
    condicion: f.condicion || '', instrucciones: f.instrucciones || '', modo: f.modo || 'ia', textoFijo: f.texto_fijo || '',
    excluir: { clientes: excluir.clientes !== false, pausada: excluir.pausada !== false, calladasHoras: Number(excluir.calladas_horas) || 0, soloConPrueba: excluir.solo_con_prueba === true },
    ponerEtiqueta: f.poner_etiqueta ?? null, recursoId: f.recurso_id ?? null, plantilla: Boolean(f.plantilla), plantillaWhatsapp: f.plantilla ? {} : null,
    activo: Boolean(f.activo), orden: f.orden,
  };
}

export const listar = (db) => db.prepare('SELECT * FROM reglas_seguimiento ORDER BY orden, created_at').all().map(deFila);
export const obtener = (db, id) => deFila(db.prepare('SELECT * FROM reglas_seguimiento WHERE id = ?').get(id));

/** Seguimiento después de la clase de prueba de Parla: para cerrar el alta con quien ya ha probado. */
export const TRAS_PRUEBA = {
  id: 'tras-prueba', nombre: 'Después de la clase de prueba', tipo: 'tras-cita', canales: ['whatsapp', 'instagram'], minutos: 180,
  condicion: 'Solo si la clase de prueba se hizo (no la anuló ni la cambió), no se ha dado de alta y no ha escrito después de la clase contando qué tal o diciendo que no sigue.',
  instrucciones: 'Un mensaje breve y cercano: pregúntale qué tal la clase de prueba y, en la misma pregunta, si quiere que le dejes el alta preparada (con la tarifa que ya hablasteis, si la hay). Una sola pregunta, sin presión y sin dar precios nuevos.',
  plantillaWhatsapp: {},
};

/** Bases que ya existían: añade una sola vez la regla de después de la prueba (si la borran, no vuelve). */
function sembrarTrasPrueba(db) {
  if (db.prepare("SELECT 1 FROM ajustes WHERE clave = 'semilla_tras_prueba'").get()) return;
  if (!db.prepare('SELECT 1 FROM reglas_seguimiento WHERE id = ?').get(TRAS_PRUEBA.id)) {
    const orden = (db.prepare('SELECT max(orden) m FROM reglas_seguimiento').get().m ?? -1) + 1;
    db.prepare(`INSERT INTO reglas_seguimiento (id, nombre, tipo, canales, minutos, condicion, instrucciones, modo, excluir, plantilla, activo, orden)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ia', ?, 1, 1, ?)`).run(TRAS_PRUEBA.id, TRAS_PRUEBA.nombre, TRAS_PRUEBA.tipo, JSON.stringify(TRAS_PRUEBA.canales), TRAS_PRUEBA.minutos,
      TRAS_PRUEBA.condicion, TRAS_PRUEBA.instrucciones, JSON.stringify({ clientes: true, pausada: true }), orden);
  }
  db.prepare("INSERT INTO ajustes (clave, valor) VALUES ('semilla_tras_prueba', 'true')").run();
}

/** Copia las reglas de config/followups.json la primera vez (y añade el recordatorio y el seguimiento de la clase de prueba). */
export function sembrarReglas(db) {
  if (db.prepare('SELECT count(*) n FROM reglas_seguimiento').get().n) return sembrarTrasPrueba(db);
  let base;
  try { base = JSON.parse(fs.readFileSync(path.join(raiz, 'config', 'followups.json'), 'utf8')); } catch { return; }
  let toggles = {};
  try { toggles = JSON.parse(db.prepare("SELECT valor FROM ajustes WHERE clave = 'seguimientos'").get()?.valor || '{}'); } catch { /* sin ajustes */ }
  const reglas = [...base.reglas];
  if (!reglas.some((r) => r.tipo === 'cita')) {
    reglas.push({
      id: 'recordatorio-prueba', nombre: 'Recordatorio de la clase de prueba', tipo: 'cita', canales: ['whatsapp', 'instagram'], minutos: 180,
      condicion: 'Solo si la clase de prueba sigue en pie (no la ha anulado ni cambiado) y no le hemos recordado ya la hora.',
      instrucciones: 'Recordatorio breve y cercano: día y hora de su clase de prueba en Parla, dirección de la sede (copiada de la base de conocimiento), venir 10 minutos antes con ropa y calzado deportivo limpio. Sin venta.',
      plantillaWhatsapp: {},
    });
  }
  if (!reglas.some((r) => r.tipo === 'tras-cita')) reglas.push(TRAS_PRUEBA);
  const ins = db.prepare(`INSERT INTO reglas_seguimiento (id, nombre, tipo, canales, minutos, despues_de, condicion, instrucciones, modo, excluir, plantilla, activo, orden)
    VALUES (@id, @nombre, @tipo, @canales, @minutos, @despues_de, @condicion, @instrucciones, 'ia', @excluir, @plantilla, @activo, @orden)`);
  db.transaction(() => reglas.forEach((r, i) => ins.run({
    id: r.id, nombre: r.nombre, tipo: r.tipo || 'silencio', canales: JSON.stringify(r.canales || ['whatsapp', 'instagram']),
    minutos: r.tipo === 'largo-plazo' ? (r.dias || 21) * 1440 : r.minutos || 0, despues_de: r.despuesDe || null,
    condicion: r.condicion || null, instrucciones: r.instrucciones || null, excluir: JSON.stringify({ clientes: true, pausada: true, ...(r.soloConPrueba ? { solo_con_prueba: true } : {}) }),
    plantilla: r.plantillaWhatsapp ? 1 : 0, activo: toggles[r.id] === false ? 0 : 1, orden: i,
  })))();
  db.prepare("INSERT OR IGNORE INTO ajustes (clave, valor) VALUES ('semilla_tras_prueba', 'true')").run();
}

const slug = (t) => String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'regla';

/** Valida lo que llega del panel. Lanza Error con un mensaje para el usuario. */
export function validar(d = {}, db, id = null) {
  const nombre = String(d.nombre ?? '').trim().slice(0, 60);
  if (!nombre) throw new Error('Ponle un nombre al seguimiento.');
  const tipo = TIPOS.includes(d.tipo) ? d.tipo : null;
  if (!tipo) throw new Error('Elige cuándo se envía.');
  const canales = (Array.isArray(d.canales) ? d.canales : []).filter((c) => ['whatsapp', 'instagram'].includes(c));
  if (!canales.length) throw new Error('Elige al menos un canal.');
  const minutos = Math.round(Number(d.minutos));
  if (!(minutos >= 1 && minutos <= 2 * 365 * 1440)) throw new Error('El tiempo de espera va de 1 minuto a 2 años.');
  const etiquetaId = tipo === 'etiqueta' ? Number(d.etiquetaId) : null;
  if (tipo === 'etiqueta' && !(etiquetaId && db.prepare('SELECT 1 FROM etiquetas WHERE id = ?').get(etiquetaId))) throw new Error('Elige la etiqueta que lo dispara.');
  const modo = d.modo === 'fijo' ? 'fijo' : 'ia';
  const textoFijo = String(d.textoFijo ?? '').trim().slice(0, 1000);
  if (modo === 'fijo' && !textoFijo) throw new Error('Escribe el texto fijo.');
  if (modo === 'fijo' && (textoFijo.match(/\[[^\]]+\]/g) || []).length > 3) throw new Error('Como mucho 3 huecos [entre corchetes]: si necesita más, que lo escriba Sofía.');
  const instrucciones = String(d.instrucciones ?? '').trim().slice(0, 1500);
  if (modo === 'ia' && !instrucciones) throw new Error('Explica a Sofía qué debe decir.');
  const despuesDe = tipo === 'largo-plazo' && d.despuesDe ? String(d.despuesDe) : null;
  if (despuesDe && (despuesDe === id || !obtener(db, despuesDe))) throw new Error('La regla anterior no existe.');
  const ponerEtiqueta = d.ponerEtiqueta ? Number(d.ponerEtiqueta) : null;
  const e = d.excluir || {};
  return {
    nombre, tipo, canales: JSON.stringify(canales), minutos, despues_de: despuesDe, etiqueta_id: etiquetaId,
    condicion: String(d.condicion ?? '').trim().slice(0, 1500) || null, instrucciones: instrucciones || null, modo, texto_fijo: modo === 'fijo' ? textoFijo : null,
    excluir: JSON.stringify({ clientes: e.clientes !== false, pausada: e.pausada !== false, calladas_horas: Math.max(0, Math.min(720, Number(e.calladasHoras) || 0)), ...(e.soloConPrueba ? { solo_con_prueba: true } : {}) }),
    poner_etiqueta: ponerEtiqueta, recurso_id: d.recursoId ? Number(d.recursoId) : null, plantilla: d.plantilla === false ? 0 : 1, activo: d.activo === false ? 0 : 1,
  };
}

export function crear(db, d) {
  const r = validar(d, db);
  let id = slug(d.nombre); let n = 2;
  while (obtener(db, id)) id = `${slug(d.nombre)}-${n++}`;
  if (r.tipo === 'largo-plazo' && !id.startsWith('largo-plazo')) id = `largo-plazo-${id}`;
  const orden = (db.prepare('SELECT max(orden) m FROM reglas_seguimiento').get().m ?? 0) + 1;
  db.prepare(`INSERT INTO reglas_seguimiento (id, nombre, tipo, canales, minutos, despues_de, etiqueta_id, condicion, instrucciones, modo, texto_fijo, excluir, poner_etiqueta, recurso_id, plantilla, activo, orden)
    VALUES (@id, @nombre, @tipo, @canales, @minutos, @despues_de, @etiqueta_id, @condicion, @instrucciones, @modo, @texto_fijo, @excluir, @poner_etiqueta, @recurso_id, @plantilla, @activo, @orden)`).run({ ...r, id, orden });
  return obtener(db, id);
}

export function actualizar(db, id, d) {
  const actual = obtener(db, id);
  if (!actual) return null;
  const r = validar({ ...actual, ...d, excluir: { ...actual.excluir, ...(d.excluir || {}) } }, db, id);
  if (r.tipo !== actual.tipo && (actual.tipo === 'largo-plazo') !== (r.tipo === 'largo-plazo')) throw new Error('Una regla de largo plazo no puede cambiar de tipo: crea otra.');
  db.prepare(`UPDATE reglas_seguimiento SET nombre=@nombre, tipo=@tipo, canales=@canales, minutos=@minutos, despues_de=@despues_de, etiqueta_id=@etiqueta_id,
    condicion=@condicion, instrucciones=@instrucciones, modo=@modo, texto_fijo=@texto_fijo, excluir=@excluir, poner_etiqueta=@poner_etiqueta, recurso_id=@recurso_id, plantilla=@plantilla, activo=@activo WHERE id=@id`).run({ ...r, id });
  return obtener(db, id);
}

export function borrar(db, id) {
  db.prepare("UPDATE scheduled SET estado = 'cancelado', detalle = 'regla borrada' WHERE regla_id = ? AND estado = 'pendiente'").run(id);
  db.prepare('UPDATE reglas_seguimiento SET despues_de = NULL WHERE despues_de = ?').run(id);
  return db.prepare('DELETE FROM reglas_seguimiento WHERE id = ?').run(id).changes > 0;
}

/** Regla «virtual» para lo que no sale de una regla: mensajes programados a mano y lanzamientos. */
export const reglaFija = (tipo, nombre) => ({ id: tipo, nombre, tipo, canales: ['whatsapp', 'instagram'], modo: 'fijo', textoFijo: '', condicion: '', instrucciones: '', excluir: { clientes: false, pausada: false, calladasHoras: 0 }, plantilla: true, plantillaWhatsapp: {}, activo: true });
