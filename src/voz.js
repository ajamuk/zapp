// Notas de voz de Sofía: de vez en cuando, en vez de escribir, manda su respuesta como nota de voz de WhatsApp.
// La voz la genera ElevenLabs (texto → MP3) y aquí se pasa a OGG/Opus mono, que es lo que WhatsApp trata como nota
// de voz. El archivo se guarda en data/media/voz y GHL/Meta lo descargan de PUBLIC_URL/r/voz_<código>.ogg.
// Cuándo sale por voz lo deciden las normas de Ajustes (apagado por defecto); si algo falla, sale el texto de siempre.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { config } from './config.js';
import { carpetaMedios } from './medios.js';

export const MIME_VOZ = 'audio/ogg';
const RE_CODIGO = /^voz_([\w-]{24})$/;

/** Normas con sus valores por defecto: apagado, solo teléfonos de prueba y solo si el lead ha mandado un audio. */
export function ajustesVoz(g = {}) {
  return {
    activo: g.activo ?? false,
    soloPruebas: g.soloPruebas ?? true,           // solo a los teléfonos de prueba del equipo (TEST_PHONES)
    soloSiLeadAudio: g.soloSiLeadAudio ?? true,   // solo si lo último que mandó el lead fue una nota de voz
    maxPorConversacion: g.maxPorConversacion ?? 2,
    maxCaracteres: g.maxCaracteres ?? 350,        // respuestas más largas se quedan en texto (350 letras ≈ 25 s)
    topeMensual: g.topeMensual ?? 25000,          // letras al mes (el plan Starter de ElevenLabs trae unas 30.000)
    vozId: typeof g.vozId === 'string' ? g.vozId : '', // vacío = la de ELEVENLABS_VOICE_ID
  };
}

/** Valida el cambio que llega del panel. Lanza un error legible. */
export function validarVoz(actual, cambio = {}) {
  const n = { ...actual, ...cambio };
  for (const k of ['activo', 'soloPruebas', 'soloSiLeadAudio']) if (typeof n[k] !== 'boolean') throw new Error(`Notas de voz: ${k} debe ser sí o no`);
  const entero = (k, min, max, nombre) => { n[k] = Number(n[k]); if (!Number.isInteger(n[k]) || n[k] < min || n[k] > max) throw new Error(`Notas de voz: ${nombre} debe ser un número entre ${min} y ${max}`); };
  entero('maxPorConversacion', 1, 50, 'el máximo por conversación');
  entero('maxCaracteres', 50, 1500, 'el máximo de letras por nota');
  entero('topeMensual', 0, 5000000, 'el tope mensual de letras');
  n.vozId = String(n.vozId ?? '').trim();
  if (n.vozId && !/^[A-Za-z0-9]{10,40}$/.test(n.vozId)) throw new Error('Notas de voz: el identificador de la voz no parece válido (es el «Voice ID» de ElevenLabs)');
  return n;
}

export const hayClave = () => Boolean(config.voz.apiKey);
export const vozElegida = (a) => a?.vozId || config.voz.vozId;

/** Lo que se le manda a ElevenLabs: las burbujas seguidas, sin emojis ni marcas de formato de WhatsApp. */
export function textoHablado(mensajes = []) {
  return mensajes.map((m) => String(m).replace(/\p{Extended_Pictographic}|️|‍/gu, '').replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean).map((m) => (/[.!?…:]$/.test(m) ? m : `${m}.`)).join(' ');
}

// Lo que hay que poder leer y pulsar, y no tiene sentido oír: enlaces y correos. Precios y horas sí se dicen de viva voz.
const MEJOR_ESCRITO = /https?:\/\/|www\.|\S+@\S+\.\S+/i;

/**
 * ¿Sale esta respuesta como nota de voz? Función pura: recibe las normas y los datos del chat.
 * Devuelve { voz, motivo } (el motivo, para el registro y las pruebas).
 */
export function decidirVoz({ ajustes, canal, clave, vozId, esPrueba, ultimoLeadAudio, enviadasConv = 0, caracteresMes = 0, mensajes = [] }) {
  const no = (motivo) => ({ voz: false, motivo });
  if (!ajustes?.activo) return no('apagado');
  if (!clave || !vozId) return no('falta la clave o la voz de ElevenLabs');
  if (canal !== 'whatsapp') return no('solo por WhatsApp');
  if (ajustes.soloPruebas && !esPrueba) return no('solo teléfonos de prueba');
  if (ajustes.soloSiLeadAudio && !ultimoLeadAudio) return no('el lead no ha mandado un audio');
  if (enviadasConv >= ajustes.maxPorConversacion) return no('máximo por conversación');
  const texto = textoHablado(mensajes);
  if (!texto) return no('sin texto');
  if (texto.length > ajustes.maxCaracteres) return no('respuesta demasiado larga');
  if (MEJOR_ESCRITO.test(mensajes.join('\n'))) return no('lleva enlaces o correos');
  if (caracteresMes + texto.length > ajustes.topeMensual) return no('tope mensual');
  return { voz: true, motivo: 'normas cumplidas', texto };
}

/** Letras gastadas este mes y notas de voz ya enviadas en un chat (cuentan las que salieron de verdad). */
export function uso(db, convId = null, ahora = new Date()) {
  const mes = `${ahora.toISOString().slice(0, 7)}-01`;
  const caracteresMes = db.prepare("SELECT COALESCE(SUM(length(texto)), 0) n FROM messages WHERE media_ruta LIKE 'voz/%' AND enviado = 1 AND date(created_at) >= ?").get(mes).n;
  const enviadasConv = convId ? db.prepare("SELECT count(*) n FROM messages WHERE conversation_id = ? AND media_ruta LIKE 'voz/%' AND enviado = 1").get(convId).n : 0;
  return { caracteresMes, enviadasConv };
}

export const urlPublica = (mediaRuta) => `${config.publicUrl.replace(/\/$/, '')}/r/voz_${path.basename(mediaRuta, '.ogg')}.ogg`;

/** Ruta (relativa a la carpeta de medios) de la nota de voz de un código público, o null si no es uno. */
export function rutaDeCodigo(codigo) {
  const m = RE_CODIGO.exec(String(codigo || ''));
  return m ? path.join('voz', `${m[1]}.ogg`) : null;
}

const ffmpeg = (args) => new Promise((ok, mal) => {
  execFile(config.media.ffmpeg, args, { timeout: 30000, maxBuffer: 1024 * 1024 }, (e, _out, err) => (e ? mal(new Error(`ffmpeg: ${String(err || e.message).slice(-200)}`)) : ok()));
});

/**
 * Genera la nota de voz de un texto. Devuelve { media_ruta, media_mime, url }. Lanza un error si ElevenLabs o la
 * conversión fallan (quien llama envía entonces el texto).
 */
export async function sintetizar(texto, { vozId = config.voz.vozId, base = carpetaMedios(), fetchImpl = fetch, convertir = ffmpeg } = {}) {
  if (!config.voz.apiKey) throw new Error('falta ELEVENLABS_API_KEY');
  if (!vozId) throw new Error('falta elegir la voz');
  const r = await fetchImpl(`${config.voz.baseUrl}/v1/text-to-speech/${encodeURIComponent(vozId)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': config.voz.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text: texto, model_id: config.voz.modelo }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`ElevenLabs → ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const mp3 = Buffer.from(await r.arrayBuffer());
  if (mp3.length < 200) throw new Error('ElevenLabs devolvió un audio vacío');
  const dir = path.join(base, 'voz');
  fs.mkdirSync(dir, { recursive: true });
  const codigo = crypto.randomBytes(18).toString('base64url');
  const entrada = path.join(dir, `${codigo}.mp3`);
  const salida = path.join(dir, `${codigo}.ogg`);
  try {
    fs.writeFileSync(entrada, mp3, { mode: 0o600 });
    // OGG/Opus mono a 48 kHz: el formato de las notas de voz de WhatsApp
    await convertir(['-y', '-loglevel', 'error', '-i', entrada, '-vn', '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', '-ar', '48000', '-application', 'voip', salida]);
    if (!fs.existsSync(salida) || !fs.statSync(salida).size) throw new Error('la conversión a nota de voz no ha dejado archivo');
  } catch (e) {
    fs.rmSync(salida, { force: true });
    throw e;
  } finally {
    fs.rmSync(entrada, { force: true });
  }
  const media_ruta = path.join('voz', `${codigo}.ogg`);
  return { media_ruta, media_mime: MIME_VOZ, url: urlPublica(media_ruta) };
}
