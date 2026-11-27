// Instagram con aislamiento: Sofía solo abre un chat de Instagram cuando el mensaje es una petición clara de
// información (precios, horarios, clase de prueba, apuntarse…). No contesta respuestas ni reacciones a historias,
// publicaciones compartidas, emojis sueltos ni mensajes sin texto: esos los atiende el equipo en GHL.
import { config } from './config.js';
import { pedirJSON } from './llm.js';

/** Adjuntos que Instagram manda al responder o reaccionar a una historia, o al compartir una publicación. */
const ADJUNTO_HISTORIA = /lookaside\.fbsbx\.com\/ig_messaging_cdn|ig_messaging_cdn|cdninstagram\.com/i;

/**
 * Filtro fijo para cualquier entrante de Instagram (chat nuevo o ya abierto). `m` es el mensaje normalizado de GHL.
 * Devuelve { ok: true } o { ok: false, motivo }.
 */
export function filtroInstagram(m) {
  const adjuntos = (m?.adjuntos || []).map((a) => String(a?.url || a || ''));
  if (adjuntos.some((u) => ADJUNTO_HISTORIA.test(u))) return { ok: false, motivo: 'Instagram: respuesta a una historia o publicación compartida' };
  const texto = String(m?.texto || '').trim();
  if (!texto) return { ok: false, motivo: 'Instagram: mensaje sin texto (reacción, foto o audio)' };
  if (!/\p{L}/u.test(texto)) return { ok: false, motivo: 'Instagram: solo emojis o signos (reacción)' };
  return { ok: true };
}

/** Respaldo sin modelo: solo frases inequívocas de alguien que quiere entrenar. */
const CLARO = /\b(precios?|tarifas?|cuotas?|cu[aá]nto (cuesta|vale|es|sale)|mensualidad|matr[ií]cula|clases? de prueba|prueba gratis|probar (una )?clase|apuntar(me|se)|inscribir(me|se)|darme de alta|horarios?|m[aá]s info(rmaci[oó]n)?|me (das|dais|puedes|pod[eé]is) (dar )?info|quiero info(rmaci[oó]n)?|info(rmaci[oó]n)? (de|sobre|por favor|porfa))\b/i;
export const pideInformacionSinModelo = (texto) => CLARO.test(String(texto || ''));

const SISTEMA = `Eres el filtro de entrada de Instagram de CrossFit MetroPolitano (boxes de CrossFit en Parla, Getafe, Las Rosas y El Cañaveral, con CrossFit Academy y Hyrox).
Decide si el mensaje es de una persona que pide de forma clara información para entrenar con nosotros: precios o tarifas, horarios, clase de prueba, cómo apuntarse o empezar, qué clases hay, dónde estamos. Un mensaje corto que solo pide información («info», «info porfa», «más información», «precio?») también cuenta como lead.
Responde lead=false si es cualquier otra cosa: saludos o agradecimientos sueltos, comentarios sobre una historia o publicación, bromas, felicitaciones, colaboraciones, patrocinios, eventos o ligas para el box, proveedores, marketing, ofertas de trabajo, socios que ya entrenan y escriben por una gestión, o si hay dudas.`;
const ESQUEMA = { type: 'object', properties: { lead: { type: 'boolean' } }, required: ['lead'], additionalProperties: false };

/**
 * Sin razonamiento para un sí/no: en Haiku 5.5 el razonamiento va activado por defecto y cuenta dentro de
 * max_tokens (con 200 se cortaba y decidía el respaldo). Haiku admite apagarlo; otros modelos actuales no
 * (400), así que con ellos se baja el esfuerzo.
 */
export const sinRazonar = (modelo) => (/haiku/.test(String(modelo)) ? { thinking: { type: 'disabled' } } : { effort: 'low' });

/**
 * ¿Es una petición clara de información? Se pregunta a un modelo pequeño; si falla, decide el respaldo sin modelo.
 * Corre en la cola del chat (antes de abrirlo): tiempo límite corto y un solo reintento. Devuelve { ok, motivo, via }.
 */
export async function pideInformacion(texto, { complete = null, onUsage = null, modelo = config.ai.modeloFiltroInstagram } = {}) {
  try {
    const r = await pedirJSON({ system: SISTEMA, contenido: `Mensaje recibido por Instagram:\n"""${String(texto).slice(0, 1500)}"""`, schema: ESQUEMA, modelo, complete, maxTokens: 1024, timeout: 15000, maxRetries: 1, ...sinRazonar(modelo), onUsage });
    return r?.lead === true ? { ok: true, via: 'modelo' } : { ok: false, via: 'modelo', motivo: 'Instagram: no pide información clara' };
  } catch (e) {
    const ok = pideInformacionSinModelo(texto);
    console.warn(`[instagram] filtro sin modelo (${e.message}): ${ok ? 'pasa' : 'no pasa'}`);
    return ok ? { ok: true, via: 'respaldo' } : { ok: false, via: 'respaldo', motivo: 'Instagram: no pide información clara' };
  }
}
