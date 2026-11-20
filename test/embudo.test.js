import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sedeDeEtiquetas, rangoMes, pruebasPorSede, leadsPorSede, embudo, limpiarCacheEmbudo } from '../src/embudo.js';

test('sede según etiquetas de GHL', () => {
  assert.equal(sedeDeEtiquetas(['no contesta', 'Parla']), 'parla');
  assert.equal(sedeDeEtiquetas(['mpo getafe']), 'getafe');
  assert.equal(sedeDeEtiquetas(['las rosas']), 'las_rosas');
  assert.equal(sedeDeEtiquetas(['el cañaveral']), null);
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
  const pag2 = [{ tags: ['las rosas'] }, { tags: ['activo parla', 'parla'] }, { tags: [] }];
  const ghl = ghlFalso([pag1, pag2]);
  const r = await leadsPorSede(ghl, '2026-11');
  assert.deepEqual(r, { parla: 50, getafe: 50, las_rosas: 1, sin_sede: 1 });
  assert.equal(ghl.llamadas.length, 2);
  assert.deepEqual(ghl.llamadas[1].searchAfter, [99]);
});

test('embudo completo y aviso si falta el informe de pruebas', async () => {
  limpiarCacheEmbudo();
  const ghl = ghlFalso([[{ tags: ['parla'] }, { tags: ['parla'] }, { tags: ['getafe'] }]]);
  const r = await embudo('2026-11', { ghl, dir: dirPruebas() });
  assert.deepEqual(r.sedes[0], { sede: 'parla', leads: 2, reservan: 3, asisten: 2, pagan: 1 });
  assert.equal(r.avisos.length, 0);
  const sin = await embudo('2026-01', { ghl: ghlFalso([[]]), dir: dirPruebas() });
  assert.equal(sin.sedes[0].reservan, null);
  assert.match(sin.avisos[0], /informe de pruebas/);
});
