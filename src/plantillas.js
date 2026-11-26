// Plantillas de WhatsApp (aprobadas por Meta) que el equipo envía desde el panel, al momento o programadas.
// La API de GHL no deja listar las plantillas con nuestra clave, así que se dan de alta aquí copiando de GHL
// (Ajustes → WhatsApp → Plantillas) su nombre, su idioma y su texto tal cual. Las variables son {{1}}, {{2}}…
// El envío va por POST /conversations/messages con `whatsapp.type = 'template'` (Ghl.enviarPlantillaWa).

export const CATEGORIAS = ['MARKETING', 'UTILITY'];
const RE_NOMBRE = /^[a-z0-9_]{1,512}$/;
const RE_IDIOMA = /^[a-z]{2,3}(_[A-Z]{2})?$/;

const fila = (r) => (r ? { ...r, activa: Boolean(r.activa), variables: numVariables(r.cuerpo) } : null);
export const listar = (db, { activas = false } = {}) => db.prepare(`SELECT * FROM plantillas_wa ${activas ? 'WHERE activa = 1' : ''} ORDER BY nombre`).all().map(fila);
export const obtener = (db, id) => fila(db.prepare('SELECT * FROM plantillas_wa WHERE id = ?').get(Number(id)));

/** Cuántas variables tiene el texto ({{1}}, {{2}}…: la más alta). */
export function numVariables(cuerpo) {
  return Math.max(0, ...[...String(cuerpo || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])));
}

/** Texto final con las variables puestas (es lo que queda en el chat). */
export const rellenar = (cuerpo, valores = []) => String(cuerpo || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => valores[Number(n) - 1] ?? `{{${n}}}`);

function validar(d, db, id = null) {
  const nombre = String(d.nombre || '').trim();
  if (!RE_NOMBRE.test(nombre)) throw new Error('El nombre de la plantilla va tal cual está en GHL: minúsculas, números y guiones bajos (p. ej. sofia_seguimiento_v1).');
  const otra = db.prepare('SELECT id FROM plantillas_wa WHERE nombre = ?').get(nombre);
  if (otra && otra.id !== id) throw new Error('Ya hay una plantilla con ese nombre.');
  const idioma = String(d.idioma || '').trim();
  if (!RE_IDIOMA.test(idioma)) throw new Error('Idioma: el código exacto de la plantilla en GHL (p. ej. es o es_ES).');
  const categoria = String(d.categoria || 'MARKETING').toUpperCase();
  if (!CATEGORIAS.includes(categoria)) throw new Error('Categoría: marketing o utilidad.');
  const cuerpo = String(d.cuerpo || '').trim();
  if (!cuerpo) throw new Error('Copia el texto de la plantilla (con sus {{1}}, {{2}}…).');
  if (cuerpo.length > 1024) throw new Error('El texto de una plantilla tiene como mucho 1024 caracteres.');
  const n = numVariables(cuerpo);
  for (let i = 1; i <= n; i++) if (!new RegExp(`\\{\\{\\s*${i}\\s*\\}\\}`).test(cuerpo)) throw new Error(`Falta la variable {{${i}}}: las variables van seguidas desde {{1}}.`);
  return { nombre, idioma, categoria, cuerpo, descripcion: String(d.descripcion || '').trim().slice(0, 300), activa: d.activa === false ? 0 : 1 };
}

export function crear(db, d = {}) {
  const v = validar(d, db);
  const r = db.prepare('INSERT INTO plantillas_wa (nombre, idioma, categoria, cuerpo, descripcion, activa) VALUES (@nombre, @idioma, @categoria, @cuerpo, @descripcion, @activa)').run(v);
  return obtener(db, r.lastInsertRowid);
}

export function actualizar(db, id, d = {}) {
  const actual = obtener(db, id);
  if (!actual) return null;
  const v = validar({ ...actual, ...d }, db, actual.id);
  db.prepare('UPDATE plantillas_wa SET nombre = @nombre, idioma = @idioma, categoria = @categoria, cuerpo = @cuerpo, descripcion = @descripcion, activa = @activa WHERE id = @id').run({ ...v, id: actual.id });
  return obtener(db, actual.id);
}

export const borrar = (db, id) => db.prepare('DELETE FROM plantillas_wa WHERE id = ?').run(Number(id)).changes > 0;

/**
 * Comprueba un envío: la plantilla existe y está activa, y llegan todas sus variables (texto, sin saltos de línea:
 * Meta los rechaza dentro de una variable). Devuelve { plantilla, variables, texto }.
 */
export function prepararEnvio(db, plantillaId, variables = []) {
  const p = obtener(db, plantillaId);
  if (!p) throw new Error('Esa plantilla no existe.');
  if (!p.activa) throw new Error('Esa plantilla está desactivada.');
  const vals = (Array.isArray(variables) ? variables : []).slice(0, p.variables).map((x) => String(x ?? '').replace(/\s*\n+\s*/g, ' ').replace(/\s{5,}/g, '    ').trim());
  for (let i = 0; i < p.variables; i++) if (!vals[i]) throw new Error(`Rellena la variable {{${i + 1}}}.`);
  if (vals.some((x) => x.length > 1000)) throw new Error('Cada variable tiene como mucho 1000 caracteres.');
  return { plantilla: p, variables: vals, texto: rellenar(p.cuerpo, vals) };
}
