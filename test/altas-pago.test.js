import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb, repo as crearRepo } from '../src/db.js';
import { config } from '../src/config.js';
import * as panel from '../src/panel.js';

test('altas: pago según el registro de socios, intentos superados y números de prueba', () => {
  const db = openDb(':memory:'); const repo = crearRepo(db);
  const ruta = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alt-')), 'clientes.sqlite');
  const soc = new Database(ruta);
  soc.exec('CREATE TABLE members (id TEXT, email TEXT, phone TEXT, first_payment TEXT, last_payment TEXT)');
  const socio = soc.prepare('INSERT INTO members VALUES (?, ?, ?, ?, ?)');
  socio.run('1', 'Nueva@Correo.es', '600111222', '2026-11-24', '2026-11-24'); // alta nueva pagada
  socio.run('2', 'ex@correo.es', '600333444', '2023-02-01', '2026-11-24');     // exsocio que vuelve y paga
  socio.run('3', 'sinpago@correo.es', '600555666', null, null);                // ficha creada, sin pagar
  socio.run('4', 'otro@correo.es', '611222333', '2026-11-24', '2026-11-24');   // el número de prueba
  soc.close();
  const alta = (id, datos, estado, cuando = '2026-11-24 10:00:00', tel = '+34600000000') => {
    repo.upsertConv({ id, contact_id: id, channel: 'whatsapp', nombre: id, telefono: tel });
    const r = repo.addAlta(id, { sede: 'getafe', tarifa: 'open', fecha_inicio: '2026-12-01', nombre_completo: id, ...datos }, estado, 'x');
    db.prepare('UPDATE altas SET created_at = ? WHERE id = ?').run(cuando, r.lastInsertRowid);
  };
  alta('nueva', { email: 'nueva@correo.es' }, 'rechazada', '2026-11-24 09:00:00');
  alta('nueva', { email: 'nueva@correo.es' }, 'preparada');
  alta('ex', { email: 'distinto@correo.es', telefono: '+34 600 333 444' }, 'preparada'); // casa por teléfono
  alta('sinpago', { email: 'sinpago@correo.es' }, 'preparada');
  alta('desconocido', { email: 'nadie@correo.es' }, 'pendiente');
  alta('fallo', { email: 'nueva@correo.es' }, 'fallida');
  alta('canaveral', { email: 'nueva@correo.es', sede: 'el_canaveral' }, 'pendiente');
  alta('test', { email: 'otro@correo.es' }, 'preparada', '2026-11-24 10:00:00', '+34611222333');
  const antes = [...config.telefonosPrueba]; config.telefonosPrueba.splice(0, antes.length, '+34611222333');
  try {
    const f = Object.fromEntries(panel.altas(db, 100, { socios: { getafe: ruta } }).filter((a) => !a.superada).map((a) => [a.conversation_id, a]));
    assert.deepEqual([f.nueva.pago, f.nueva.pago_fecha, f.nueva.primer_pago], ['pagada', '2026-11-24', true]);
    assert.deepEqual([f.ex.pago, f.ex.primer_pago], ['pagada', false]);
    assert.equal(f.sinpago.pago, 'pendiente');
    assert.equal(f.desconocido.pago, 'pendiente'); // aún sin ficha en el registro
    assert.equal(f.fallo.pago, null);              // un intento fallido no creó nada
    assert.equal(f.canaveral.pago, null);          // sede sin registro
    assert.deepEqual([f.test.de_prueba, f.test.pago], [true, null]);
    const todas = panel.altas(db, 100, { socios: { getafe: ruta } });
    assert.equal(todas.find((a) => a.estado === 'rechazada').superada, true);
    // Sin registros de socios no falla: simplemente no se sabe el pago
    assert.equal(panel.altas(db, 100, { socios: {} }).every((a) => a.pago === null), true);
  } finally { config.telefonosPrueba.splice(0, config.telefonosPrueba.length, ...antes); }
});
