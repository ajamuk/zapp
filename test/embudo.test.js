import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { sedeDeEtiquetas, sedeDeContacto, rangoMes, pruebasPorSede, leadsPorSede, altasPorSede, embudo, limpiarCacheEmbudo } from '../src/embudo.js';

test('sede según etiquetas de GHL', () => {
  assert.equal(sedeDeEtiquetas(['no contesta', 'Parla']), 'parla');
  assert.equal(sedeDeEtiquetas(['mpo getafe']), 'getafe');
  assert.equal(sedeDeEtiquetas(['las rosas']), 'las_rosas');
  assert.equal(sedeDeEtiquetas(['el cañaveral']), 'el_canaveral');
  assert.equal(sedeDeEtiquetas(['mpo-el-canaveral-interesado']), 'el_canaveral');
  assert.equal(sedeDeEtiquetas(['el cañaveral', 'getafe']), 'getafe');
  assert.equal(sedeDeEtiquetas(['no contesta']), null);
  assert.equal(sedeDeContacto({ tags: [], source: 'Web nueva · Getafe' }), 'getafe');
  assert.equal(sedeDeContacto({ tags: [], source: 'El Cañaveral · aviso de apertura' }), 'el_canaveral');
  assert.equal(sedeDeContacto({ tags: ['parla'], source: 'Web nueva · Getafe' }), 'parla');
  assert.equal(sedeDeContacto({ tags: [], source: 'Zapp whatsapp' }), null);
});

test('rango del mes en hora de Madrid, con horario de verano', () => {
  assert.deepEqual(Object.values(rangoMes('2026-11')).map((d) => d.toISOString()), ['2026-10-31T23:00:00.000Z', '2026-11-30T23:00:00.000Z']);
  assert.equal(rangoMes('2026-07').desde.toISOString(), '2026-06-30T22:00:00.000Z');
  assert.equal(rangoMes('2026-12').hasta.toISOString(), '2026-12-31T23:00:00.000Z');
  assert.throws(() => rangoMes('2026-13'));
});

const dirPruebas = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emb-'));
  fs.writeFileSync(path.join(dir, 'aimharder-2026-11.json'), JSON.stringify({ trials: [
    { boxId: 'parla', attended: true, enrolled: true, cancelled: false },
    { boxId: 'parla', attended: true, enrolled: false, cancelled: false },
    { boxId: 'parla', attended: false, enrolled: false, cancelled: false },
    { boxId: 'parla', attended: false, enrolled: false, cancelled: true },
    { boxId: 'getafe', attended: false, enrolled: false, cancelled: false },
  ] }));
  return dir;
};

test('pruebas de AimHarder por sede: sin contar canceladas', () => {
  const r = pruebasPorSede('2026-11', dirPruebas());
  assert.deepEqual(r.porSede.parla, { reservan: 3, asisten: 2, pagan: 1 });
  assert.deepEqual(r.porSede.getafe, { reservan: 1, asisten: 0, pagan: 0 });
  assert.equal(pruebasPorSede('2026-01', dirPruebas()), null);
});

const ghlFalso = (paginas) => {
  const llamadas = [];
  return { llamadas, req: async (_m, _p, body) => { llamadas.push(body); return { contacts: paginas[llamadas.length - 1] || [] }; } };
};

test('leads de GHL: pagina, reparte por sede y descarta socios', async () => {
  const pag1 = Array.from({ length: 100 }, (_, i) => ({ tags: [i % 2 ? 'parla' : 'getafe'], searchAfter: [i] }));
  const pag2 = [{ tags: ['las rosas'] }, { tags: ['activo parla', 'parla'] }, { tags: [] }, { tags: ['el cañaveral'] }];
  const ghl = ghlFalso([pag1, pag2]);
  const r = await leadsPorSede(ghl, '2026-11');
  assert.deepEqual(r, { parla: 50, getafe: 50, las_rosas: 1, el_canaveral: 1, sin_sede: 1 });
  assert.equal(ghl.llamadas.length, 2);
  assert.deepEqual(ghl.llamadas[1].searchAfter, [99]);
});

// Registro de socios de una sede con esos primeros pagos (null = aún no ha pagado nunca)
const registro = (pagos) => {
  const ruta = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'soc-')), 'clientes.sqlite');
  const db = new Database(ruta);
  db.exec('CREATE TABLE members (id TEXT, first_payment TEXT)');
  pagos.forEach((f, i) => db.prepare('INSERT INTO members VALUES (?, ?)').run(i === 0 ? '__undefined_client__' : `s${i}`, f));
  db.close();
  return ruta;
};
const socios = () => ({
  parla: registro(['2026-11-02', '2026-11-03', '2026-11-30', '2026-10-31', '2019-11-05', null]), // el primero es el cliente genérico: no cuenta
  getafe: registro(['2026-11-02', '2026-11-24', '2026-12-01']),
  las_rosas: '/no-existe/clientes.sqlite',
});

test('altas del mes: primer pago histórico por sede', () => {
  const r = altasPorSede('2026-11', socios());
  assert.deepEqual(r.porSede, { parla: 2, getafe: 1, las_rosas: null });
  assert.ok(r.actualizado);
  assert.deepEqual(altasPorSede('2026-11', {}).porSede, { parla: null, getafe: null, las_rosas: null });
});

test('embudo por sede: Parla con clase de prueba, Getafe y Las Rosas de lead a primer pago', async () => {
  limpiarCacheEmbudo();
  const ghl = ghlFalso([[{ tags: ['parla'] }, { tags: ['parla'] }, { tags: ['getafe'] }]]);
  const r = await embudo('2026-11', { ghl, dir: dirPruebas(), socios: socios() });
  // El primer pago es el del registro de socios (2), no el de las pruebas con alta (1)
  assert.deepEqual(r.sedes[0], { sede: 'parla', pasos: ['leads', 'reservan', 'asisten', 'pagan'], leads: 2, reservan: 3, asisten: 2, pagan: 2 });
  assert.deepEqual(r.sedes[1], { sede: 'getafe', pasos: ['leads', 'pagan'], leads: 1, pagan: 1 });
  assert.deepEqual(r.sedes[2], { sede: 'las_rosas', pasos: ['leads', 'pagan'], leads: 0, pagan: null });
  assert.equal(r.avisos.length, 1);
  assert.match(r.avisos[0], /socios de Las Rosas/);
  // Los leads se guardan 15 min, pero un alta nueva se ve al momento
  const s2 = socios(); s2.getafe = registro(['x', '2026-11-24', '2026-11-24', '2026-11-24']);
  const otra = await embudo('2026-11', { ghl, dir: dirPruebas(), socios: s2 });
  assert.equal(otra.sedes[1].pagan, 3);
  assert.equal(ghl.llamadas.length, 1);
  const sin = await embudo('2026-01', { ghl: ghlFalso([[]]), dir: dirPruebas(), socios: socios() });
  assert.equal(sin.sedes[0].reservan, null);
  assert.match(sin.avisos[0], /informe de pruebas/);
});

test('embudo de El Cañaveral: interesados del mes, plazas anotadas y pagadas del registro', async () => {
  const { openDb, repo: crearRepo } = await import('../src/db.js');
  const repo = crearRepo(openDb(':memory:'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-'));
  const ruta = path.join(dir, 'ledger.json');
  const fila = (id, tel, estado) => ({ tab: 'Bloque 50%', row: [id, 'x', tel, 'CrossFit', 120, 0.5, 60, 0, 0, estado, 60, 0, 60, '', 0, ''] });
  fs.writeFileSync(ruta, JSON.stringify({ a: fila('1', '600000001', 'Pendiente'), b: fila('2', '600000002', 'Pagado') }));
  limpiarCacheEmbudo();
  const ghl = ghlFalso([[{ tags: ['parla'] }, { tags: ['mpo-el-canaveral-interesado'] }, { tags: [], source: 'El Cañaveral · aviso de apertura' }]]);
  const r = await embudo('2026-11', { ghl, dir: dirPruebas(), socios: {}, repo, rutaCanaveral: ruta });
  assert.deepEqual([r.canaveral.interesados, r.canaveral.plazas, r.canaveral.pagadas, r.canaveral.de], [2, 2, 1, 200]);
  // Sin registro: plazas del número de Ajustes y pagos desconocidos
  const sin = await embudo('2026-11', { ghl, dir: dirPruebas(), socios: {}, repo, rutaCanaveral: path.join(dir, 'no-existe.json') });
  assert.deepEqual([sin.canaveral.plazas, sin.canaveral.pagadas, sin.canaveral.origen], [0, null, 'manual']);
});
