// Audios e imágenes que mandan los leads: se descargan, se guardan junto a la base de datos, los audios se
// transcriben con Whisper en local (sin enviar la voz a ningún servicio externo) y las imágenes se le pasan a
// Sofía para que las vea.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import dns from 'node:dns/promises';
import { execFile } from 'node:child_process';
import { config } from './config.js';

const MAX_BYTES = 25 * 1024 * 1024;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'video/mp4': 'mp4' };
export const IMAGEN_API = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export const carpetaMedios = () => config.media.dir || path.join(path.dirname(config.dbPath === ':memory:' ? './data/x' : config.dbPath), 'media');

/** Tipo de adjunto por el content-type o la extensión. */
export function tipoDe(mime = '', url = '') {
  const s = `${mime} ${url}`.toLowerCase();
  if (/image\/|\.(jpe?g|png|gif|webp|heic)(\?|$)/.test(s)) return 'imagen';
  if (/audio\/|\.(mp3|ogg|opus|m4a|wav|aac|webm)(\?|$)/.test(s)) return 'audio';
  if (/video\/|\.(mp4|mov|avi|3gp)(\?|$)/.test(s)) return 'video';
  return 'documento';
}

// Hosts de GoHighLevel a los que se puede enviar el token si la descarga pide autenticación. A cualquier otro
// host nunca se le manda (un adjunto alojado fuera no debe recibir la clave de GHL). GHL_MEDIA_HOSTS añade más.
const hostsGhl = () => {
  let propio = '';
  try { propio = new URL(config.ghl.baseUrl).hostname; } catch { /* sin base */ }
  return [propio, 'leadconnectorhq.com', 'gohighlevel.com', 'msgsndr.com', 'highlevel.com', ...String(process.env.GHL_MEDIA_HOSTS || '').split(',')]
    .map((h) => h.trim().toLowerCase()).filter(Boolean);
};
export const esHostGhl = (host) => { const h = String(host || '').toLowerCase(); return hostsGhl().some((x) => h === x || h.endsWith(`.${x}`)); };

/** ¿Dirección interna (este servidor, red privada, enlace local)? A esas no se descarga nada. */
export function ipPrivada(ip) {
  const s = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  let v4 = s.startsWith('::ffff:') ? s.slice(7) : s;
  // IPv4 dentro de IPv6 escrita en hexadecimal (::ffff:7f00:1 es 127.0.0.1)
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v4);
  if (s.startsWith('::ffff:') && hex) { const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16); v4 = `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`; }
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (net.isIPv6(s)) return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s);
  return false;
}

/** Comprueba que la URL es https y no apunta al propio servidor ni a una red interna. Devuelve el objeto URL. */
export async function urlSegura(url, { resolver = null } = {}) {
  let u;
  try { u = new URL(String(url)); } catch { throw new Error('dirección del adjunto no válida'); }
  if (u.protocol !== 'https:') throw new Error('el adjunto no está en una dirección https');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || ipPrivada(host)) throw new Error('el adjunto apunta a una dirección interna');
  if (resolver && !net.isIP(host.replace(/^\[|\]$/g, ''))) {
    const dirs = await resolver(host);
    if (!dirs.length || dirs.some((d) => ipPrivada(d.address))) throw new Error('el adjunto apunta a una dirección interna');
  }
  return u;
}

/** Lee el cuerpo sin pasar nunca del tamaño máximo (aunque el servidor no diga cuánto ocupa). */
async function leerConTope(r, max = MAX_BYTES) {
  if (Number(r.headers?.get?.('content-length') || 0) > max) throw new Error('archivo demasiado grande');
  const lector = r.body?.getReader?.();
  if (!lector) {
    const buffer = Buffer.from(await r.arrayBuffer());
    if (buffer.length > max) throw new Error('archivo demasiado grande');
    return buffer;
  }
  const trozos = []; let total = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await lector.cancel().catch(() => {}); throw new Error('archivo demasiado grande'); }
    trozos.push(Buffer.from(value));
  }
  return Buffer.concat(trozos);
}

/**
 * Descarga un adjunto de GHL. Solo https y nunca de una dirección interna (ni siguiendo una redirección). Si pide
 * autenticación, se reintenta con el token de GHL, pero solo cuando el archivo está en un host de GHL.
 */
export async function descargar(url, { fetchImpl = fetch, token = config.ghl.token, resolver } = {}) {
  // Con el fetch real se resuelve el nombre para descartar redes internas; en los tests no hay red
  const res = resolver !== undefined ? resolver : fetchImpl === fetch ? (h) => dns.lookup(h, { all: true }) : null;
  const limite = AbortSignal.timeout(30000);
  let actual = await urlSegura(url, { resolver: res });
  let r;
  for (let salto = 0; ; salto++) {
    const pedir = (cab) => fetchImpl(actual.href, { headers: cab, signal: limite, redirect: 'manual' });
    r = await pedir({});
    if ((r.status === 401 || r.status === 403) && token && esHostGhl(actual.hostname)) r = await pedir({ Authorization: `Bearer ${token}` });
    const destino = r.status >= 300 && r.status < 400 ? r.headers?.get?.('location') : null;
    if (!destino) break;
    if (salto >= 3) throw new Error('demasiadas redirecciones');
    actual = await urlSegura(new URL(destino, actual).href, { resolver: res });
  }
  if (!r.ok) throw new Error(`descarga ${r.status}`);
  const buffer = await leerConTope(r);
  const mime = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  return { buffer, mime };
}

/** Guarda el archivo y devuelve su ruta relativa a la carpeta de medios. */
export function guardar(buffer, { mime = '', url = '', base = carpetaMedios() } = {}) {
  const ext = EXT[mime] || (String(url).split('?')[0].match(/\.([a-z0-9]{2,4})$/i)?.[1] || 'bin').toLowerCase();
  const mes = new Date().toISOString().slice(0, 7);
  const rel = path.join(mes, `${crypto.randomUUID()}.${ext}`);
  fs.mkdirSync(path.join(base, mes), { recursive: true });
  fs.writeFileSync(path.join(base, rel), buffer, { mode: 0o600 });
  return rel;
}

const ejecutar = (cmd, args, { timeout = 180000, env } = {}) => new Promise((ok, mal) => {
  execFile(cmd, args, { timeout, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, ...env } }, (e, stdout, stderr) => (e ? mal(new Error(String(stderr || e.message).slice(-300))) : ok(String(stdout).trim())));
});

// Una transcripción cada vez: Whisper usa mucha CPU y memoria.
let cola = Promise.resolve();
const enCola = (fn) => { const p = cola.then(fn, fn); cola = p.catch(() => {}); return p; };

/**
 * Transcribe un audio. Primero con faster-whisper (rápido, int8), y si no está disponible con el
 * transcriptor de reserva del VPS (openai-whisper). Devuelve el texto (puede ser '').
 */
export function transcribir(ruta, { ejecutarImpl = ejecutar } = {}) {
  return enCola(async () => {
    const m = config.media;
    const script = path.join(config.root, 'scripts', 'transcribir.py');
    if (m.python && fs.existsSync(m.python)) {
      try {
        return await ejecutarImpl(m.python, ['-I', script, ruta, 'es'], { env: { HF_HUB_OFFLINE: '1', TRANSCRIPTOR_MODELOS: m.modelos || '' } });
      } catch (e) { console.error('[medios] faster-whisper:', e.message); }
    }
    if (m.reserva && fs.existsSync(m.reserva)) return ejecutarImpl(m.reserva, [ruta], { timeout: 300000 });
    throw new Error('no hay transcriptor configurado');
  });
}

/**
 * Imagen lista para el modelo: JPEG/PNG/WebP/GIF de menos de ~3,5 MB y como mucho 1568 px de lado
 * (el resto se convierte con ffmpeg). Devuelve { data (base64), media_type } o null.
 */
export async function imagenParaModelo(ruta, { ejecutarImpl = ejecutar } = {}) {
  const abs = path.join(carpetaMedios(), ruta);
  if (!fs.existsSync(abs)) return null;
  const ext = path.extname(abs).slice(1).toLowerCase();
  const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }[ext];
  const tam = fs.statSync(abs).size;
  if (mime && tam <= 3.5 * 1024 * 1024) return { data: fs.readFileSync(abs).toString('base64'), media_type: mime };
  const salida = abs.replace(/\.[^.]+$/, '') + '.modelo.jpg';
  if (!fs.existsSync(salida)) {
    await ejecutarImpl(config.media.ffmpeg || 'ffmpeg', ['-v', 'error', '-y', '-i', abs, '-vf', "scale='min(1568,iw)':'min(1568,ih)':force_original_aspect_ratio=decrease", '-frames:v', '1', '-q:v', '4', salida], { timeout: 60000 });
  }
  return { data: fs.readFileSync(salida).toString('base64'), media_type: 'image/jpeg' };
}

/**
 * Procesa los adjuntos de un mensaje del lead: descarga, guarda y (audios) transcribe.
 * Devuelve { adjunto, media_ruta, media_mime, transcripcion, media_error }.
 */
export async function procesarAdjuntos(adjuntos = [], opciones = {}) {
  const url = adjuntos.map((a) => (typeof a === 'string' ? a : a?.url)).find(Boolean);
  if (!url) return null;
  const out = { adjunto: tipoDe('', url), media_ruta: null, media_mime: null, transcripcion: null, media_error: null };
  try {
    const { buffer, mime } = await (opciones.descargarImpl || descargar)(url);
    out.adjunto = tipoDe(mime, url);
    out.media_mime = mime || null;
    out.media_ruta = guardar(buffer, { mime, url, base: opciones.base });
    if (out.adjunto === 'audio') out.transcripcion = await (opciones.transcribirImpl || transcribir)(path.join(opciones.base || carpetaMedios(), out.media_ruta));
  } catch (e) {
    out.media_error = e.message;
    console.error('[medios]', e.message);
  }
  return out;
}

/** Desde un archivo subido en el panel (Probar IA). */
export async function procesarSubida({ datos, mime, nombre = '' }, opciones = {}) {
  const buffer = Buffer.from(String(datos || ''), 'base64');
  if (!buffer.length) throw new Error('Archivo vacío.');
  if (buffer.length > MAX_BYTES) throw new Error('El archivo es demasiado grande (máximo 25 MB).');
  const adjunto = tipoDe(mime, nombre);
  if (!['audio', 'imagen'].includes(adjunto)) throw new Error('Solo se pueden probar audios e imágenes.');
  const media_ruta = guardar(buffer, { mime, url: nombre, base: opciones.base });
  const out = { adjunto, media_ruta, media_mime: mime || null, transcripcion: null, media_error: null };
  if (adjunto === 'audio') {
    try { out.transcripcion = await (opciones.transcribirImpl || transcribir)(path.join(opciones.base || carpetaMedios(), media_ruta)); } catch (e) { out.media_error = e.message; }
  }
  return out;
}
