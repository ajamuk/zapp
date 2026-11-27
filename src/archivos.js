// Archivos que el equipo envía a un lead desde el panel (imagen, vídeo, audio o PDF), al momento o programados.
// Se guardan en la carpeta de medios y Meta los descarga de una URL pública con un código aleatorio:
// PUBLIC_URL/r/eq_<código>.<ext> (como los recursos y las notas de voz).
// Los audios grabados en el navegador (WebM) se convierten a OGG/Opus, que es lo que WhatsApp reproduce como nota de voz.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { config } from './config.js';
import { carpetaMedios, guardar, tipoDe } from './medios.js';

// Límites de WhatsApp: imagen 5 MB, vídeo y audio 16 MB, documento 100 MB (aquí, 16 MB como mucho: va en base64 por el panel)
const LIMITE = { imagen: 5, video: 16, audio: 16, documento: 16 };
const PERMITIDOS = /^(image\/(jpeg|png|webp)|video\/(mp4|3gpp)|audio\/(ogg|mpeg|mp4|aac|webm|x-m4a)|application\/pdf)$/;
const RE_CODIGO = /^eq_([\w-]{24})$/;

export const obtener = (db, id) => db.prepare('SELECT * FROM archivos_equipo WHERE id = ?').get(Number(id));
export const porCodigo = (db, codigo) => { const m = RE_CODIGO.exec(String(codigo || '')); return m ? db.prepare('SELECT * FROM archivos_equipo WHERE token = ?').get(m[1]) : null; };
export const urlPublica = (a) => `${config.publicUrl.replace(/\/$/, '')}/r/eq_${a.token}${path.extname(a.media_ruta)}`;
/** Para el panel y la API: sin la ruta en disco ni el código público. */
export const resumen = (a) => (a ? { id: a.id, nombre: a.nombre, tipo: a.tipo, mime: a.mime, tamano: a.tamano } : null);

const ffmpeg = (args) => new Promise((ok, mal) => {
  execFile(config.media.ffmpeg, args, { timeout: 60000, maxBuffer: 1024 * 1024 }, (e, _out, err) => (e ? mal(new Error(`ffmpeg: ${String(err || e.message).slice(-200)}`)) : ok()));
});

/**
 * Sube un archivo del equipo. d: { datos (base64), mime, archivo (nombre original) }.
 * Devuelve la fila guardada. Lanza errores legibles (formato, tamaño, conversión).
 */
export async function subir(db, d = {}, { base = carpetaMedios(), convertir = ffmpeg } = {}) {
  let mime = String(d.mime || '').toLowerCase().split(';')[0].trim();
  if (mime === 'audio/x-m4a') mime = 'audio/mp4';
  if (!PERMITIDOS.test(mime)) throw new Error('Formato no admitido: imagen (JPG, PNG, WebP), vídeo MP4, audio (MP3, M4A, OGG) o PDF.');
  let buffer = Buffer.from(String(d.datos || ''), 'base64');
  if (!buffer.length) throw new Error('El archivo está vacío.');
  const nombre = String(d.archivo || '').replace(/[\\/]/g, '').trim().slice(0, 80) || 'archivo';
  let tipo = tipoDe(mime, nombre);
  if (buffer.length > 16 * 1024 * 1024) throw new Error('Como mucho 16 MB.');
  let media_ruta;
  if (mime === 'audio/webm') {
    // Grabación del navegador: WhatsApp no acepta WebM → OGG/Opus (nota de voz)
    const tmp = guardar(buffer, { mime, base });
    media_ruta = path.join(path.dirname(tmp), `${crypto.randomUUID()}.ogg`);
    try { await convertir(['-y', '-i', path.join(base, tmp), '-vn', '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', path.join(base, media_ruta)]); }
    // El detalle de ffmpeg (lleva rutas del servidor) va al registro, no al panel
    catch (e) { console.error('[archivos] conversión del audio:', e.message); throw new Error('No se ha podido preparar el audio: prueba a grabarlo otra vez.'); }
    finally { fs.rmSync(path.join(base, tmp), { force: true }); }
    mime = 'audio/ogg'; buffer = fs.readFileSync(path.join(base, media_ruta));
  } else {
    if (buffer.length > LIMITE[tipo] * 1024 * 1024) throw new Error(`WhatsApp no admite ${tipo === 'imagen' ? 'imágenes' : `${tipo}s`} de más de ${LIMITE[tipo]} MB.`);
    media_ruta = guardar(buffer, { mime, url: nombre, base });
  }
  tipo = tipoDe(mime, media_ruta);
  const r = db.prepare('INSERT INTO archivos_equipo (nombre, tipo, media_ruta, mime, tamano, token) VALUES (?, ?, ?, ?, ?, ?)')
    .run(nombre, tipo, media_ruta, mime, buffer.length, crypto.randomBytes(18).toString('base64url'));
  return obtener(db, r.lastInsertRowid);
}
