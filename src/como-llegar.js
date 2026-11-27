import fs from 'node:fs';
import { config, rutaConfig } from './config.js';
import { hoyLocal, horaLocal, diaSiguiente, instanteLocal } from './horario.js';

/**
 * Herramienta `como_llegar`: desde dónde vendría el lead (barrio, municipio, estación o calle) hasta los centros.
 * - Localiza el origen: con GOOGLE_MAPS_API_KEY, la API de Geocoding de Google; si no, Nominatim (OpenStreetMap).
 * - Ordena las sedes por distancia en línea recta y marca `lejos` si la más cercana pasa de `lejos_km`.
 * - Con la clave de Google, además, el tiempo y la ruta más rápida en transporte público y en coche (Routes API).
 * - Siempre devuelve el metro, tren, tranvía o bus de al lado de cada box (config/como-llegar.json) y un enlace de
 *   Google Maps con la ruta, que Google calcula al abrirlo.
 * Solo se envía fuera el texto del origen: nunca el nombre, el teléfono ni nada más del lead.
 */

const UMBRAL_LEJOS_KM = 15;
const ESPERA_MS = 6000;
// Comunidad de Madrid y alrededores (oeste, norte, este, sur): se prefieren resultados de aquí
const ZONA = { oeste: -4.6, norte: 41.2, este: -3.0, sur: 39.8 };

let datos;
/** Datos de config/como-llegar.json (null si el negocio no tiene ese archivo). */
export function datosComoLlegar() {
  if (datos !== undefined) return datos;
  try { datos = JSON.parse(fs.readFileSync(rutaConfig('como-llegar.json'), 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') console.error('config/como-llegar.json no se puede leer:', e.message);
    datos = null;
  }
  return datos;
}

/** Distancia en km en línea recta entre dos puntos { lat, lon }. */
export function distanciaKm(a, b) {
  const rad = (g) => (g * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const redondear = (km) => (km < 20 ? Math.round(km * 10) / 10 : Math.round(km));
const fechaLarga = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const normal = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/** Enlace de Google Maps con la ruta (Google la calcula al abrirlo). Sin origen, desde donde esté el lead. */
export function enlaceRuta(destino, origen = '', modo = 'transit') {
  const p = new URLSearchParams({ api: '1', ...(origen ? { origin: origen } : {}), destination: destino, travelmode: modo });
  return `https://www.google.com/maps/dir/?${p}`;
}

/**
 * Datos fijos de cómo llegar, para los jueces de la batería y de los reportes: el transporte junto a cada box y la
 * distancia a partir de la cual le pilla lejos. Así no toman por inventada una línea que viene de la herramienta.
 */
export function textoComoLlegar(d = datosComoLlegar()) {
  if (!d?.sedes) return '';
  const sedes = Object.fromEntries(Object.entries(d.sedes).map(([id, s]) => [id, { transporte: s.transporte || [], ...(s.coche ? { coche: s.coche } : {}), ...(s.abre ? { abre: s.abre } : {}) }]));
  return `\n\n<como_llegar>\nLo que devuelve la herramienta como_llegar además de la distancia, el enlace de la ruta y, si hay conexión con Google, los minutos en transporte público y en coche: ${JSON.stringify({ lejos_km: d.lejos_km, sedes })}\n</como_llegar>`;
}

// ---------- Localizar el origen ----------

const cache = new Map(); // texto normalizado → { lat, lon, nombre } | null
const MAX_CACHE = 500;
function guardar(clave, valor) {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(clave, valor);
}
/** Para las pruebas. */
export function vaciarCache() { cache.clear(); }

// Nominatim pide como mucho una petición por segundo: se hacen de una en una
let colaNominatim = Promise.resolve();
let ultimaNominatim = 0;
function enColaNominatim(fn, sleep) {
  const r = colaNominatim.then(async () => {
    const falta = ultimaNominatim + 1100 - Date.now();
    if (falta > 0) await sleep(falta);
    ultimaNominatim = Date.now();
    return fn();
  });
  colaNominatim = r.catch(() => {});
  return r;
}

async function pedirJson(fetchFn, url, opciones = {}) {
  const res = await fetchFn(url, { ...opciones, signal: AbortSignal.timeout(ESPERA_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function geocodificarGoogle(texto, { fetch: fetchFn, clave }) {
  const p = new URLSearchParams({ address: texto, region: 'es', language: 'es', components: 'country:ES', bounds: `${ZONA.sur},${ZONA.oeste}|${ZONA.norte},${ZONA.este}`, key: clave });
  const d = await pedirJson(fetchFn, `https://maps.googleapis.com/maps/api/geocode/json?${p}`);
  const r = d?.results?.[0];
  if (!r?.geometry?.location) return null;
  return { lat: r.geometry.location.lat, lon: r.geometry.location.lng, nombre: r.formatted_address?.replace(/, España$/, '') || texto };
}

function nombreNominatim(r, texto) {
  const a = r.address || {};
  // La calle solo si la ha dicho él: si pregunta por un barrio, Nominatim puede devolver una calle cualquiera de allí
  const calle = a.road && normal(texto).includes(normal(a.road).replace(/^(calle|avenida|paseo|plaza) (de (la |los |las )?|del )?/, '')) ? a.road : null;
  const partes = [calle, a.suburb || a.quarter || a.neighbourhood || a.city_district, a.city || a.town || a.village || a.municipality, a.state && !/madrid/i.test(a.state) ? a.state : null];
  const nombre = [...new Set(partes.filter(Boolean))].join(', ');
  return nombre || String(r.display_name || texto).split(',').slice(0, 3).join(',');
}

async function geocodificarNominatim(texto, { fetch: fetchFn, sleep }) {
  const buscar = (acotado) => {
    const p = new URLSearchParams({ q: texto, format: 'jsonv2', addressdetails: '1', limit: '1', countrycodes: 'es', 'accept-language': 'es', viewbox: `${ZONA.oeste},${ZONA.norte},${ZONA.este},${ZONA.sur}`, bounded: acotado ? '1' : '0' });
    return enColaNominatim(() => pedirJson(fetchFn, `https://nominatim.openstreetmap.org/search?${p}`, { headers: { 'User-Agent': config.mapas.userAgent, Accept: 'application/json' } }), sleep);
  };
  // Primero en Madrid y alrededores (hay muchos «San Blas» o «Las Rosas» en España); si no, en toda España
  let r = (await buscar(true))?.[0];
  if (!r) r = (await buscar(false))?.[0];
  if (!r) return null;
  return { lat: Number(r.lat), lon: Number(r.lon), nombre: nombreNominatim(r, texto) };
}

/**
 * { lat, lon, nombre } del texto (barrio, municipio, estación, calle…), o null si no se encuentra.
 * Lanza un error si el servicio no responde (para distinguir «no existe» de «no se ha podido mirar»).
 */
export async function geocodificar(texto, { fetch: fetchFn = globalThis.fetch, clave = config.mapas.claveGoogle, servicio = config.mapas.geocodificador, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const t = String(texto || '').trim();
  if (!t) return null;
  const clavecache = normal(t);
  if (cache.has(clavecache)) return cache.get(clavecache);
  const usar = servicio === 'auto' ? (clave ? 'google' : 'nominatim') : servicio;
  let r;
  if (usar === 'google' && clave) r = await geocodificarGoogle(t, { fetch: fetchFn, clave });
  else if (usar === 'nominatim') r = await geocodificarNominatim(t, { fetch: fetchFn, sleep });
  else throw new Error('localización desactivada');
  guardar(clavecache, r);
  return r;
}

// ---------- Rutas (solo con la clave de Google) ----------

const segundos = (d) => Number(String(d || '').replace(/s$/, '')) || 0;
const minutos = (s) => Math.max(1, Math.round(s / 60));

/** Salida para calcular el transporte público: ahora, o a las 18:00 si es de noche (a esas horas solo hay búhos). */
export function salidaTipica(now = new Date()) {
  const h = horaLocal(now);
  if (h >= 7 && h < 21) return null;
  const hoy = hoyLocal(now).iso;
  return instanteLocal(h < 7 ? hoy : diaSiguiente(hoy), '18:00');
}

function resumenTransporte(ruta) {
  const pasos = ruta?.legs?.flatMap((l) => l.steps || []) || [];
  let andando = 0;
  const tramos = [];
  for (const p of pasos) {
    const td = p.transitDetails;
    if (p.travelMode === 'TRANSIT' && td) {
      const linea = td.transitLine || {};
      const tipo = String(linea.vehicle?.name?.text || '').toLowerCase();
      const nombre = linea.nameShort || linea.name || '';
      const de = td.stopDetails?.departureStop?.name; const a = td.stopDetails?.arrivalStop?.name;
      const paradas = td.stopCount ? ` (${td.stopCount} ${td.stopCount === 1 ? 'parada' : 'paradas'})` : '';
      tramos.push(`${[tipo, nombre].filter(Boolean).join(' ')}${de && a ? ` de ${de} a ${a}` : ''}${paradas}`);
    } else andando += segundos(p.staticDuration);
  }
  if (!tramos.length) return 'andando';
  return `${tramos.join(', luego ')}${andando >= 60 ? `; en total unos ${minutos(andando)} min andando` : ''}`;
}

/** { transporte_publico: { minutos, ruta }, coche: { minutos } } entre dos puntos, con lo que se haya podido calcular. */
export async function rutasGoogle(origen, destino, { fetch: fetchFn = globalThis.fetch, clave = config.mapas.claveGoogle, now = new Date() } = {}) {
  if (!clave) return null;
  const punto = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lon } } });
  const pedir = (cuerpo, campos) => pedirJson(fetchFn, 'https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': clave, 'X-Goog-FieldMask': campos },
    body: JSON.stringify({ origin: punto(origen), destination: punto(destino), languageCode: 'es', regionCode: 'es', units: 'METRIC', ...cuerpo }),
  });
  const salida = salidaTipica(now);
  const pasos = 'routes.legs.steps.travelMode,routes.legs.steps.staticDuration,routes.legs.steps.transitDetails.stopDetails.departureStop.name,routes.legs.steps.transitDetails.stopDetails.arrivalStop.name,routes.legs.steps.transitDetails.transitLine.nameShort,routes.legs.steps.transitDetails.transitLine.name,routes.legs.steps.transitDetails.transitLine.vehicle.name,routes.legs.steps.transitDetails.stopCount';
  const [tp, coche] = await Promise.allSettled([
    pedir({ travelMode: 'TRANSIT', ...(salida ? { departureTime: salida.toISOString() } : {}) }, `routes.duration,${pasos}`),
    pedir({ travelMode: 'DRIVE' }, 'routes.duration'),
  ]);
  const out = {};
  const rtp = tp.status === 'fulfilled' ? tp.value?.routes?.[0] : null;
  if (rtp?.duration) out.transporte_publico = { minutos: minutos(segundos(rtp.duration)), ruta: resumenTransporte(rtp), ...(salida ? { calculado_para: 'las 18:00' } : {}) };
  const rc = coche.status === 'fulfilled' ? coche.value?.routes?.[0] : null;
  if (rc?.duration) out.en_coche = { minutos: minutos(segundos(rc.duration)) };
  for (const r of [tp, coche]) if (r.status === 'rejected') console.warn('como_llegar: Google Routes no ha respondido:', r.reason?.message);
  return Object.keys(out).length ? out : null;
}

// ---------- La herramienta ----------

const NOTA_RESPUESTA = 'Contesta con la forma más rápida o cómoda desde donde viene (la línea y la parada; el tiempo solo si viene aquí), en una o dos burbujas y sin soltarle la lista entera. Si ayuda, pásale el enlace de la ruta. No inventes líneas, paradas, distancias ni tiempos que no estén aquí.';

function fichaSede(id, d, { origenTexto = '', distancia = null } = {}) {
  const s = d.sedes[id];
  const nombre = config.negocio.sedes.find((x) => x.id === id)?.nombre || id;
  return {
    sede: id, nombre,
    ...(distancia != null ? { distancia_km: redondear(distancia) } : {}),
    ...(s.abre ? { abre: s.abre } : {}),
    transporte: s.transporte || [],
    ...(s.coche ? { coche: s.coche } : {}),
    ruta_google_maps: enlaceRuta(s.direccion || `${s.lat},${s.lon}`, origenTexto),
  };
}

/**
 * `como_llegar({ origen?, sede? })`. Con origen: sedes por cercanía, la más cercana con su transporte y, si se puede,
 * el tiempo real; con solo la sede: el transporte de al lado del box. `deps` permite simular fetch y la hora.
 */
export async function comoLlegar({ origen, sede } = {}, deps = {}) {
  const d = deps.datos || datosComoLlegar();
  if (!d?.sedes) return { ok: false, error: 'No hay datos de cómo llegar para este negocio.', nota: 'Dale la dirección y el enlace de mapa de la sede; si pregunta por transporte, apúntalo con pregunta_sin_respuesta.' };
  const ids = config.negocio.sedes.map((s) => s.id).filter((id) => d.sedes[id]?.lat != null);
  const pedida = sede && ids.includes(sede) ? sede : null;
  const texto = String(origen || '').trim();

  if (!texto) {
    if (!pedida) return { ok: false, error: 'Falta desde dónde vendría o qué centro le interesa.', nota: 'Pregúntale en una frase desde qué zona vendría (barrio, municipio o estación) y vuelve a llamar a como_llegar.' };
    return { ok: true, sedes: [fichaSede(pedida, d)], nota: `${NOTA_RESPUESTA} Si te dice desde dónde vendría, vuelve a llamarla con el origen para darle la ruta más rápida.` };
  }

  let punto;
  try { punto = await geocodificar(texto, deps); } catch (e) {
    console.warn('como_llegar: no se ha podido localizar el origen:', e.message);
    return { ok: false, error: 'Ahora mismo no se puede consultar el mapa.', ...(pedida ? { sedes: [fichaSede(pedida, d, { origenTexto: texto })] } : {}), nota: 'Dale lo que hay junto al box (si sabes la sede) y el enlace de la ruta, que se abre en Google Maps desde donde esté. No calcules tú distancias ni tiempos.' };
  }
  if (!punto) {
    return { ok: false, error: `No encuentro «${texto}» en el mapa.`, ...(pedida ? { sedes: [fichaSede(pedida, d)] } : {}), nota: 'Pregúntale el barrio, el municipio o una estación de metro o tren cercana y vuelve a llamar a como_llegar. No adivines.' };
  }

  const orden = ids.map((id) => ({ id, km: distanciaKm(punto, d.sedes[id]) })).sort((a, b) => a.km - b.km);
  const cercana = orden[0];
  const principal = pedida ? orden.find((x) => x.id === pedida) : cercana;
  const umbral = Number(d.lejos_km) || UMBRAL_LEJOS_KM;
  const lejos = cercana.km > umbral;

  const ficha = fichaSede(principal.id, d, { origenTexto: texto, distancia: principal.km });
  const rutas = lejos ? null : await rutasGoogle(punto, d.sedes[principal.id], { ...deps, now: deps.now || new Date() }).catch((e) => { console.warn('como_llegar: rutas:', e.message); return null; });
  if (rutas) Object.assign(ficha, rutas);
  const otras = orden.filter((x) => x.id !== principal.id).slice(0, 2).map((x) => ({ sede: x.id, nombre: fichaSede(x.id, d).nombre, distancia_km: redondear(x.km), ...(d.sedes[x.id].abre ? { abre: d.sedes[x.id].abre } : {}) }));

  const notas = [];
  if (lejos) {
    notas.push(`Le pilla lejos: el centro más cercano (${fichaSede(cercana.id, d).nombre}) está a unos ${redondear(cercana.km)} km en línea recta. Díselo con cariño y sin venderle ni insistir: que ahora mismo no tenemos ningún centro cerca de su casa y que esperamos poder abrir alguno cerca pronto. No le prometas fechas ni sitios. Si aun así le encaja venir (por ejemplo, le pilla cerca del trabajo), sigue con normalidad.`);
  } else {
    notas.push(NOTA_RESPUESTA);
    if (pedida && cercana.id !== pedida && principal.km - cercana.km > 3) notas.push(`Le pilla bastante más cerca ${fichaSede(cercana.id, d).nombre} (${redondear(cercana.km)} km) que ${ficha.nombre} (${ficha.distancia_km} km): coméntaselo por si le encaja mejor.`);
    if (ficha.abre) notas.push(`${ficha.nombre} todavía no está abierto: abre el ${fechaLarga(ficha.abre)}.`);
  }
  return { ok: true, origen: punto.nombre, lejos, sedes: [ficha, ...otras], nota: notas.join(' ') };
}
