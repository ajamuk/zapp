// Recursos (como en Zapp): archivos que Sofía puede enviar cuando encajan en la conversación (PDF de horarios,
// fotos del box, un vídeo, la ubicación…) y que un seguimiento puede adjuntar. Se suben desde el panel. GHL los
// descarga de una URL pública con un código aleatorio: /r/<token> (solo lectura, solo los activos).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { carpetaMedios, guardar, tipoDe } from './medios.js';

const MAX = 25 * 1024 * 1024;
const PERMITIDOS = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|quicktime)|application\/pdf|audio\/(mpeg|ogg|mp4|aac))$/;

export const listar = (db, { activos = false } = {}) => db.prepare(`SELECT * FROM recursos ${activos ? 'WHERE activo = 1' : ''} ORDER BY nombre COLLATE NOCASE`).all();
export const obtener = (db, id) => db.prepare('SELECT * FROM recursos WHERE id = ?').get(id);
export const porNombre = (db, nombre) => db.prepare('SELECT * FROM recursos WHERE nombre = ? COLLATE NOCASE AND activo = 1').get(String(nombre || '').trim());
export const porToken = (db, token) => db.prepare('SELECT * FROM recursos WHERE token = ? AND activo = 1').get(String(token || ''));
export const urlPublica = (r) => `${config.publicUrl.replace(/\/$/, '')}/r/${r.token}${path.extname(r.media_ruta)}`;

function validarTexto(d, db, id = null) {
  const nombre = String(d.nombre || '').trim().slice(0, 60);
  if (!nombre) throw new Error('Ponle un nombre al recurso.');
  const otro = db.prepare('SELECT id FROM recursos WHERE nombre = ? COLLATE NOCASE').get(nombre);
  if (otro && otro.id !== id) throw new Error('Ya hay un recurso con ese nombre.');
  const descripcion = String(d.descripcion || '').trim().slice(0, 500);
  if (!descripcion) throw new Error('Explica cuándo debe enviarlo Sofía.');
  return { nombre, descripcion };
}

/** Sube un recurso nuevo. d: { nombre, descripcion, datos (base64), mime, archivo } */
export function crear(db, d, { base = carpetaMedios() } = {}) {
  const t = validarTexto(d, db);
  const mime = String(d.mime || '').toLowerCase();
  if (!PERMITIDOS.test(mime)) throw new Error('Formato no admitido: imagen (JPG, PNG, WebP), vídeo MP4, PDF o audio.');
  const buffer = Buffer.from(String(d.datos || ''), 'base64');
  if (!buffer.length) throw new Error('El archivo está vacío.');
  if (buffer.length > MAX) throw new Error('Como mucho 25 MB.');
  const media_ruta = guardar(buffer, { mime, url: d.archivo || '', base });
  const r = db.prepare('INSERT INTO recursos (nombre, descripcion, tipo, media_ruta, mime, tamano, token) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(t.nombre, t.descripcion, tipoDe(mime, d.archivo), media_ruta, mime, buffer.length, crypto.randomBytes(18).toString('base64url'));
  return obtener(db, r.lastInsertRowid);
}

export function actualizar(db, id, d) {
  const r = obtener(db, id);
  if (!r) return null;
  const t = validarTexto({ ...r, ...d }, db, id);
  db.prepare('UPDATE recursos SET nombre = ?, descripcion = ?, activo = ? WHERE id = ?').run(t.nombre, t.descripcion, d.activo === false ? 0 : d.activo === true ? 1 : r.activo, id);
  return obtener(db, id);
}

export function borrar(db, id, { base = carpetaMedios() } = {}) {
  const r = obtener(db, id);
  if (!r) return false;
  db.prepare('DELETE FROM recursos WHERE id = ?').run(id);
  db.prepare('UPDATE reglas_seguimiento SET recurso_id = NULL WHERE recurso_id = ?').run(id);
  // El archivo se queda si algún mensaje enviado lo usa (para que el chat lo siga mostrando)
  const usado = db.prepare('SELECT 1 FROM messages WHERE media_ruta = ? LIMIT 1').get(r.media_ruta);
  if (!usado) fs.rmSync(path.join(base, r.media_ruta), { force: true });
  return true;
}

/** Bloque de contexto para Sofía con los recursos que puede enviar. */
export function contextoIA(db) {
  const rs = listar(db, { activos: true });
  if (!rs.length) return '';
  return ['# Archivos que puedes enviar', 'Si encaja en la conversación, llama a `enviar_recurso` con el nombre exacto (como mucho uno por turno; no lo repitas si ya lo enviaste). El archivo sale junto a tus mensajes: no pegues enlaces ni digas «te adjunto» si no lo envías.',
    ...rs.map((r) => `- «${r.nombre}» (${r.tipo}): ${r.descripcion}`)].join('\n');
}
