// Instrucciones de Sofía con versiones: el prompt («prompt») y la base de conocimiento («negocio»). La primera vez
// se copian de config/prompt-sofia.md y config/negocio.md. Siempre hay una versión en producción; los borradores
// se prueban en Probar IA y se pasan a producción desde el panel (o al aplicar un reporte). Los festivos se añaden
// a la base de conocimiento al usarla, no se guardan aquí.
import fs from 'node:fs';
import { rutaConfig } from './config.js';

export const DOCS = { prompt: { archivo: 'prompt-sofia.md', nombre: 'Prompt de Sofía' }, negocio: { archivo: 'negocio.md', nombre: 'Base de conocimiento' } };

export function sembrarDocumentos(db) {
  for (const [doc, d] of Object.entries(DOCS)) {
    if (db.prepare('SELECT 1 FROM documentos WHERE doc = ?').get(doc)) continue;
    let texto;
    try { texto = fs.readFileSync(rutaConfig(d.archivo), 'utf8'); } catch { continue; }
    db.prepare("INSERT INTO documentos (doc, version, texto, nota, autor, estado) VALUES (?, 1, ?, 'Versión inicial (archivo de configuración)', 'inicial', 'produccion')").run(doc, texto);
  }
}

export const enProduccion = (db, doc) => db.prepare("SELECT * FROM documentos WHERE doc = ? AND estado = 'produccion' ORDER BY version DESC LIMIT 1").get(doc);
export const obtener = (db, id) => db.prepare('SELECT * FROM documentos WHERE id = ?').get(id);
export const versiones = (db, doc) => db.prepare('SELECT id, doc, version, nota, autor, estado, reporte_id, created_at, length(texto) largo FROM documentos WHERE doc = ? ORDER BY version DESC').all(doc);

/** Textos que usa Sofía: los de producción, o los de los borradores indicados ({ prompt: id, negocio: id }). */
export function textosActivos(db, borradores = {}) {
  const out = {};
  for (const doc of Object.keys(DOCS)) {
    const b = borradores[doc] ? obtener(db, borradores[doc]) : null;
    out[doc] = (b && b.doc === doc ? b : enProduccion(db, doc))?.texto ?? null;
  }
  return out;
}

/** Nueva versión. `produccion: true` la pone en producción (y archiva la anterior). */
export function crearVersion(db, doc, texto, { nota = '', autor = 'panel', reporteId = null, produccion = false } = {}) {
  if (!DOCS[doc]) throw new Error('Documento desconocido.');
  const t = String(texto ?? '');
  if (t.trim().length < 200) throw new Error('El texto es demasiado corto: parece que falta casi todo.');
  if (t.length > 60000) throw new Error('El texto es demasiado largo.');
  const v = (db.prepare('SELECT max(version) m FROM documentos WHERE doc = ?').get(doc).m || 0) + 1;
  return db.transaction(() => {
    if (produccion) db.prepare("UPDATE documentos SET estado = 'archivada' WHERE doc = ? AND estado = 'produccion'").run(doc);
    const r = db.prepare('INSERT INTO documentos (doc, version, texto, nota, autor, reporte_id, estado) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(doc, v, t, String(nota).slice(0, 300), autor, reporteId, produccion ? 'produccion' : 'borrador');
    return obtener(db, r.lastInsertRowid);
  })();
}

/** Pone en producción una versión (un borrador o una anterior, para volver atrás). */
export function activar(db, id) {
  const d = obtener(db, id);
  if (!d) throw new Error('Esa versión no existe.');
  db.transaction(() => {
    db.prepare("UPDATE documentos SET estado = 'archivada' WHERE doc = ? AND estado = 'produccion'").run(d.doc);
    db.prepare("UPDATE documentos SET estado = 'produccion' WHERE id = ?").run(id);
  })();
  return obtener(db, id);
}

/**
 * Aplica cambios «buscar → reemplazar» a un texto. Cada `buscar` debe aparecer exactamente una vez
 * (si no, no se sabe dónde va). `buscar` vacío = añadir al final. Lanza Error con el problema.
 */
export function aplicarCambios(texto, cambios = []) {
  let t = texto;
  for (const [i, c] of cambios.entries()) {
    const buscar = String(c.buscar ?? ''); const reemplazar = String(c.reemplazar ?? '');
    if (!buscar) { t = `${t.trimEnd()}\n\n${reemplazar.trim()}\n`; continue; }
    const n = t.split(buscar).length - 1;
    if (n === 0) throw new Error(`Cambio ${i + 1}: el texto a sustituir no aparece en las instrucciones actuales.`);
    if (n > 1) throw new Error(`Cambio ${i + 1}: el texto a sustituir aparece ${n} veces; hace falta un trozo más largo para saber cuál.`);
    t = t.replace(buscar, () => reemplazar);
  }
  return t;
}

/** Números de versión que usa Sofía ahora (producción o los borradores indicados). */
export function versionesActivas(db, borradores = {}) {
  const out = {};
  for (const doc of Object.keys(DOCS)) {
    const b = borradores[doc] ? obtener(db, borradores[doc]) : null;
    out[doc] = (b && b.doc === doc ? b : enProduccion(db, doc))?.version ?? null;
  }
  return out;
}
