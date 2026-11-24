import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { rangoMes, pruebasPorSede, leadsDeSofia, altasPorSede, embudo } from '../src/embudo.js';
import { openDb, repo as crearRepo } from '../src/db.js';
import * as etq from '../src/etiquetas.js';
import { config } from '../src/config.js';

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

// Chats de Sofía: [sede, fecha de creación (UTC), extra]
const conChats = (chats) => {
  const repo = crearRepo(openDb(':memory:'));
  chats.forEach(([sede, creado, extra = {}], i) => {
    repo.upsertConv({ id: 'c' + i, contact_id: 'k' + i, channel: 'whatsapp', nombre: 'L' + i, telefono: extra.telefono || '+3460000' + String(1000 + i) });
    repo.updateConv('c' + i, { sede, ...(extra.tipo ? { tipo: extra.tipo } : {}) });
    repo.db.prepare('UPDATE conversations SET created_at = ? WHERE id = ?').run(creado, 'c' + i);
  });
  return repo;
};

test('leads nuevos: los chats de Sofía del mes por sede, sin socios, no leads ni números de prueba', () => {
  const repo = conChats([
    ['parla', '2026-11-05 10:00:00'], ['parla', '2026-11-30T22:30:00.000Z'], ['getafe', '2026-11-10 09:00:00'],
    ['las_rosas', '2026-11-01 00:30:00'], ['el_canaveral', '2026-11-12 12:00:00'], [null, '2026-11-12 12:00:00'],
    ['parla', '2026-10-31 22:30:00'], // 31 oct 23:30 en Madrid: octubre
    ['parla', '2026-10-31 23:30:00'], // 1 nov 00:30 en Madrid: noviembre
    ['parla', '2026-11-30 23:30:00'], // 1 dic 00:30 en Madrid: diciembre
    ['getafe', '2026-11-11 09:00:00', { tipo: 'socio' }],
    ['getafe', '2026-11-11 09:00:00', { telefono: '+34611222333' }],
    ['getafe', '2026-11-11 09:00:00'], // se marca como «no es un lead»
  ]);
  const no = etq.crear(repo.db, { nombre: 'Proveedor', color: '#805003', acciones: { no_lead: true } });
  repo.db.prepare("INSERT INTO conv_etiquetas (conversation_id, etiqueta_id, origen) VALUES (?, ?, 'manual')").run('c11', no.id);
  const antes = [...config.telefonosPrueba]; config.telefonosPrueba.splice(0, antes.length, '+34611222333');
  try {
    assert.deepEqual(leadsDeSofia(repo.db, '2026-11'), { parla: 3, getafe: 1, las_rosas: 1, el_canaveral: 1, sin_sede: 1, no_leads: 1 });
    assert.equal(leadsDeSofia(repo.db, '2026-10').parla, 1);
  } finally { config.telefonosPrueba.splice(0, config.telefonosPrueba.length, ...antes); }
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
  const repo = conChats([['parla', '2026-11-05 10:00:00'], ['parla', '2026-11-06 10:00:00'], ['getafe', '2026-11-07 10:00:00']]);
  const r = await embudo('2026-11', { repo, dir: dirPruebas(), socios: socios() });
  // El primer pago es el del registro de socios (2), no el de las pruebas con alta (1)
  assert.deepEqual(r.sedes[0], { sede: 'parla', pasos: ['leads', 'reservan', 'asisten', 'pagan'], leads: 2, reservan: 3, asisten: 2, pagan: 2 });
  assert.deepEqual(r.sedes[1], { sede: 'getafe', pasos: ['leads', 'pagan'], leads: 1, pagan: 1 });
  assert.deepEqual(r.sedes[2], { sede: 'las_rosas', pasos: ['leads', 'pagan'], leads: 0, pagan: null });
  assert.equal(r.avisos.length, 1);
  assert.match(r.avisos[0], /socios de Las Rosas/);
  // Un lead o un alta nuevos se ven al momento
  repo.upsertConv({ id: 'nuevo', contact_id: 'kn', channel: 'whatsapp', nombre: 'N', telefono: '+34600009999' });
  repo.updateConv('nuevo', { sede: 'getafe' });
  repo.db.prepare("UPDATE conversations SET created_at = '2026-11-24 10:00:00' WHERE id = 'nuevo'").run();
  const s2 = socios(); s2.getafe = registro(['x', '2026-11-24', '2026-11-24', '2026-11-24']);
  const otra = await embudo('2026-11', { repo, dir: dirPruebas(), socios: s2 });
  assert.deepEqual([otra.sedes[1].leads, otra.sedes[1].pagan], [2, 3]);
  const sin = await embudo('2026-01', { repo, dir: dirPruebas(), socios: socios() });
  assert.equal(sin.sedes[0].reservan, null);
  assert.match(sin.avisos[0], /informe de pruebas/);
});

test('embudo de El Cañaveral: interesados del mes, plazas anotadas y pagadas del registro', async () => {
  const hoy = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const repo = conChats([['parla', hoy], ['el_canaveral', hoy], ['el_canaveral', hoy]]);
  const mes = hoy.slice(0, 7);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'can-'));
  const ruta = path.join(dir, 'ledger.json');
  const fila = (id, tel, estado) => ({ tab: 'Bloque 50%', row: [id, 'x', tel, 'CrossFit', 120, 0.5, 60, 0, 0, estado, 60, 0, 60, '', 0, ''] });
  fs.writeFileSync(ruta, JSON.stringify({ a: fila('1', '600000001', 'Pendiente'), b: fila('2', '600000002', 'Pagado') }));
  const r = await embudo(mes, { dir: dirPruebas(), socios: {}, repo, rutaCanaveral: ruta });
  assert.deepEqual([r.canaveral.interesados, r.canaveral.plazas, r.canaveral.pagadas, r.canaveral.de], [2, 2, 1, 200]);
  // Sin registro: plazas del número de Ajustes y pagos desconocidos
  const sin = await embudo(mes, { dir: dirPruebas(), socios: {}, repo, rutaCanaveral: path.join(dir, 'no-existe.json') });
  assert.deepEqual([sin.canaveral.plazas, sin.canaveral.pagadas, sin.canaveral.origen], [0, null, 'manual']);
});
