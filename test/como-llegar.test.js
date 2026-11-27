import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { comoLlegar, datosComoLlegar, distanciaKm, salidaTipica, vaciarCache, textoComoLlegar } from '../src/como-llegar.js';
import { TOOLS, ESPERAR_RESULTADO } from '../src/llm.js';
import { openDb, repo as crearRepo } from '../src/db.js';
import { Setter } from '../src/setter.js';

// Puntos aproximados de los orígenes de prueba
const SITIOS = {
  leganes: { lat: '40.3281', lon: '-3.7635', address: { city: 'Leganés', state: 'Comunidad de Madrid' } },
  toledo: { lat: '39.8628', lon: '-4.0273', address: { city: 'Toledo', state: 'Castilla-La Mancha' } },
  coslada: { lat: '40.4238', lon: '-3.5613', address: { city: 'Coslada', state: 'Comunidad de Madrid' } },
};

/** fetch simulado: Nominatim y Google responden con SITIOS; apunta cada llamada. */
function fetchFalso({ rutas = null, caido = false } = {}) {
  const llamadas = [];
  const fn = async (url, opciones = {}) => {
    llamadas.push({ url: String(url), opciones });
    if (caido) throw new Error('fetch failed');
    const u = new URL(url);
    const json = (d) => ({ ok: true, status: 200, json: async () => d });
    const sitio = (texto) => {
      const q = String(texto).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      return q.includes('zarzaquemada') ? SITIOS.leganes : Object.entries(SITIOS).find(([k]) => q.includes(k))?.[1];
    };
    if (u.hostname === 'nominatim.openstreetmap.org') {
      const s = sitio(u.searchParams.get('q'));
      return json(s ? [s] : []);
    }
    if (u.hostname === 'maps.googleapis.com') {
      const s = sitio(u.searchParams.get('address'));
      const nombre = s === SITIOS.leganes ? 'Zarzaquemada, Leganés, Madrid, España' : `${s?.address.city}, España`;
      return json({ results: s ? [{ formatted_address: nombre, geometry: { location: { lat: Number(s.lat), lng: Number(s.lon) } } }] : [] });
    }
    if (u.hostname === 'routes.googleapis.com') {
      const cuerpo = JSON.parse(opciones.body);
      return json(cuerpo.travelMode === 'TRANSIT' ? rutas.tp : rutas.coche);
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fn, llamadas };
}

const sinEsperas = { sleep: async () => {}, clave: '' };
beforeEach(() => vaciarCache());

test('como_llegar: centro más cercano, transporte de al lado y enlace de la ruta (OpenStreetMap, sin clave)', async () => {
  const f = fetchFalso();
  const r = await comoLlegar({ origen: 'Leganés' }, { ...sinEsperas, fetch: f.fn });
  assert.equal(r.ok, true);
  assert.equal(r.lejos, false);
  assert.equal(r.origen, 'Leganés');
  const [principal, ...otras] = r.sedes;
  assert.equal(principal.sede, 'getafe');
  assert.ok(principal.distancia_km > 2 && principal.distancia_km < 4, `distancia ${principal.distancia_km}`);
  assert.ok(principal.transporte.some((t) => /El Bercial/.test(t)));
  const ruta = new URL(principal.ruta_google_maps);
  assert.equal(ruta.searchParams.get('origin'), 'Leganés');
  assert.match(ruta.searchParams.get('destination'), /Avenida de la Paz 35/);
  assert.equal(ruta.searchParams.get('travelmode'), 'transit');
  assert.equal(otras.length, 2);
  assert.ok(otras.every((o) => o.distancia_km > principal.distancia_km && !o.transporte));
  assert.doesNotMatch(r.nota, /lejos/);
  // Solo se busca el sitio, en Madrid y alrededores primero, identificándose ante Nominatim; sin clave no hay rutas
  assert.equal(f.llamadas.length, 1);
  const u = new URL(f.llamadas[0].url);
  assert.equal(u.searchParams.get('q'), 'Leganés');
  assert.equal(u.searchParams.get('bounded'), '1');
  assert.equal(f.llamadas[0].opciones.headers['User-Agent'], config.mapas.userAgent);
});

test('como_llegar: si le pilla lejos lo dice y no calcula rutas', async () => {
  const f = fetchFalso({ rutas: { tp: {}, coche: {} } });
  const r = await comoLlegar({ origen: 'Toledo' }, { ...sinEsperas, clave: 'clave-falsa', fetch: f.fn });
  assert.equal(r.ok, true);
  assert.equal(r.lejos, true);
  assert.equal(r.sedes[0].sede, 'parla');
  assert.ok(r.sedes[0].distancia_km > 40);
  assert.match(r.nota, /esperamos poder abrir alguno cerca pronto/);
  assert.match(r.nota, /sin venderle ni insistir/);
  assert.ok(!f.llamadas.some((l) => l.url.includes('routes.googleapis.com')));
});

test('como_llegar: con clave de Google, tiempo y ruta más rápida en transporte público y en coche', async () => {
  const rutas = {
    tp: { routes: [{ duration: '1680s', legs: [{ steps: [
      { travelMode: 'WALK', staticDuration: '240s' },
      { travelMode: 'TRANSIT', staticDuration: '600s', transitDetails: { stopCount: 3, stopDetails: { departureStop: { name: 'Leganés Central' }, arrivalStop: { name: 'El Bercial' } }, transitLine: { nameShort: 'L12', vehicle: { name: { text: 'Metro' } } } } },
      { travelMode: 'WALK', staticDuration: '180s' },
    ] }] }] },
    coche: { routes: [{ duration: '700s' }] },
  };
  const f = fetchFalso({ rutas });
  const dia = new Date('2026-11-27T11:00:00Z'); // 12:00 en Madrid
  const r = await comoLlegar({ origen: 'Zarzaquemada', sede: 'getafe' }, { ...sinEsperas, clave: 'clave-falsa', fetch: f.fn, now: dia });
  assert.equal(r.origen, 'Zarzaquemada, Leganés, Madrid');
  const g = r.sedes[0];
  assert.deepEqual(g.transporte_publico, { minutos: 28, ruta: 'metro L12 de Leganés Central a El Bercial (3 paradas); en total unos 7 min andando' });
  assert.deepEqual(g.en_coche, { minutos: 12 });
  const geo = new URL(f.llamadas[0].url);
  assert.equal(geo.hostname, 'maps.googleapis.com');
  assert.equal(geo.searchParams.get('key'), 'clave-falsa');
  const tp = f.llamadas.find((l) => l.url.includes('routes') && JSON.parse(l.opciones.body).travelMode === 'TRANSIT');
  assert.equal(tp.opciones.headers['X-Goog-Api-Key'], 'clave-falsa');
  assert.match(tp.opciones.headers['X-Goog-FieldMask'], /transitLine\.nameShort/);
  assert.equal(JSON.parse(tp.opciones.body).departureTime, undefined, 'de día, la salida es ahora');
  // De noche se calcula para las 18:00 (a esas horas solo hay búhos)
  vaciarCache();
  const noche = await comoLlegar({ origen: 'Zarzaquemada' }, { ...sinEsperas, clave: 'clave-falsa', fetch: f.fn, now: new Date('2026-11-27T22:30:00Z') });
  assert.equal(noche.sedes[0].transporte_publico.calculado_para, 'las 18:00');
  const ultima = f.llamadas.filter((l) => l.url.includes('routes') && JSON.parse(l.opciones.body).travelMode === 'TRANSIT').pop();
  assert.equal(JSON.parse(ultima.opciones.body).departureTime, '2026-11-28T17:00:00.000Z');
});

test('como_llegar: si Google no da ruta, se queda con la distancia y el transporte del box', async () => {
  const f = fetchFalso({ rutas: { tp: { routes: [] }, coche: {} } });
  const r = await comoLlegar({ origen: 'Leganés' }, { ...sinEsperas, clave: 'clave-falsa', fetch: f.fn });
  assert.equal(r.ok, true);
  assert.equal(r.sedes[0].transporte_publico, undefined);
  assert.ok(r.sedes[0].transporte.length);
});

test('como_llegar: sin origen, el transporte de la sede; sin nada, pide desde dónde vendría', async () => {
  const f = fetchFalso();
  const r = await comoLlegar({ sede: 'las_rosas' }, { ...sinEsperas, fetch: f.fn });
  assert.equal(r.ok, true);
  assert.equal(r.sedes.length, 1);
  assert.ok(r.sedes[0].transporte.some((t) => /metro L2: estación Las Rosas/.test(t)));
  assert.equal(new URL(r.sedes[0].ruta_google_maps).searchParams.get('origin'), null, 'sin origen: desde donde esté');
  assert.equal(f.llamadas.length, 0);
  const nada = await comoLlegar({}, { ...sinEsperas, fetch: f.fn });
  assert.equal(nada.ok, false);
  assert.match(nada.nota, /desde qué zona vendría/);
});

test('como_llegar: sitio que no aparece (se busca también fuera de Madrid) o mapa caído', async () => {
  const f = fetchFalso();
  const r = await comoLlegar({ origen: 'Villaninguna' }, { ...sinEsperas, fetch: f.fn });
  assert.equal(r.ok, false);
  assert.match(r.nota, /barrio, el municipio o una estación/);
  assert.deepEqual(f.llamadas.map((l) => new URL(l.url).searchParams.get('bounded')), ['1', '0']);
  const caido = fetchFalso({ caido: true });
  const c = await comoLlegar({ origen: 'Leganés', sede: 'getafe' }, { ...sinEsperas, fetch: caido.fn });
  assert.equal(c.ok, false);
  assert.equal(c.sedes[0].sede, 'getafe', 'con la sede pedida, al menos el transporte del box');
  assert.match(c.nota, /No calcules tú distancias ni tiempos/);
});

test('como_llegar: avisa si otra sede le pilla bastante más cerca y si la cercana aún no ha abierto', async () => {
  const f = fetchFalso();
  const r = await comoLlegar({ origen: 'Leganés', sede: 'las_rosas' }, { ...sinEsperas, fetch: f.fn });
  assert.equal(r.sedes[0].sede, 'las_rosas');
  assert.match(r.nota, /Le pilla bastante más cerca Getafe/);
  const c = await comoLlegar({ origen: 'Coslada' }, { ...sinEsperas, fetch: f.fn });
  assert.equal(c.sedes[0].sede, 'el_canaveral');
  assert.equal(c.sedes[0].abre, '2027-02-01');
  assert.match(c.nota, /abre el 1 de febrero de 2027/);
});

test('como_llegar: el mismo sitio no se vuelve a buscar', async () => {
  const f = fetchFalso();
  await comoLlegar({ origen: 'Leganés' }, { ...sinEsperas, fetch: f.fn });
  await comoLlegar({ origen: '  leganes ' }, { ...sinEsperas, fetch: f.fn });
  assert.equal(f.llamadas.length, 1);
});

test('salida para el transporte público: ahora de día; de noche, a las 18:00 en Madrid', () => {
  assert.equal(salidaTipica(new Date('2026-11-27T11:00:00Z')), null);
  assert.equal(salidaTipica(new Date('2026-11-27T22:30:00Z')).toISOString(), '2026-11-28T17:00:00.000Z');
  assert.equal(salidaTipica(new Date('2026-11-27T04:00:00Z')).toISOString(), '2026-11-27T17:00:00.000Z');
});

test('datos de cómo llegar: cada sede tiene punto, transporte y la dirección de negocio.md', () => {
  const d = datosComoLlegar();
  const negocio = fs.readFileSync(path.join(config.root, 'config', 'negocio.md'), 'utf8');
  for (const s of config.negocio.sedes) {
    const x = d.sedes[s.id];
    assert.ok(x, `falta ${s.id} en como-llegar.json`);
    assert.ok(Math.abs(x.lat - 40.3) < 0.5 && Math.abs(x.lon + 3.7) < 0.5, `${s.id}: punto fuera de Madrid`);
    assert.ok(x.transporte.length >= 2, `${s.id}: transporte`);
    assert.ok(negocio.includes(`| ${s.nombre} | ${x.direccion} |`), `${s.id}: la dirección no coincide con la tabla de sedes`);
  }
  assert.ok(distanciaKm(d.sedes.parla, d.sedes.getafe) > 9 && distanciaKm(d.sedes.parla, d.sedes.getafe) < 12);
  assert.match(textoComoLlegar(d), /<como_llegar>[\s\S]*El Bercial[\s\S]*<\/como_llegar>/);
});

test('Sofía tiene como_llegar: se espera su resultado y el setter usa el servicio de mapas', async () => {
  const t = TOOLS.find((x) => x.name === 'como_llegar');
  assert.ok(t);
  assert.deepEqual(t.input_schema.properties.sede.enum, config.negocio.sedes.map((s) => s.id));
  assert.ok(ESPERAR_RESULTADO.includes('como_llegar'));
  const repo = crearRepo(openDb(':memory:'));
  repo.upsertConv({ id: 'c1', contact_id: 'k1', channel: 'whatsapp' });
  const ahora = new Date('2026-11-27T11:00:00Z');
  const pedidas = [];
  const setter = new Setter({ repo, now: () => ahora, mapas: { comoLlegar: async (i, deps) => { pedidas.push([i, deps.now]); return { ok: true, lejos: false, sedes: [] }; } } });
  const r = await setter.herramienta(repo.getConv('c1'), 'como_llegar', { origen: 'Leganés' }, { tags: new Set(), herramientas: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(pedidas, [[{ origen: 'Leganés' }, ahora]]);
});
