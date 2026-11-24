import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { registrar } from '../src/alertas.js';

test('alertas del sistema: por Telegram solo las de nivel error; las de nivel aviso se quedan en el panel', async () => {
  const db = openDb(':memory:');
  const avisos = [];
  const avisar = async (t) => { avisos.push(t); };
  assert.equal(registrar(db, { clave: 'a', tipo: 'aimharder', titulo: 'Leve', nivel: 'aviso' }, { avisar }).nueva, true);
  assert.equal(registrar(db, { clave: 'b', tipo: 'ia', titulo: 'Grave' }, { avisar }).nueva, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /Grave/);
  assert.equal(db.prepare('SELECT count(*) n FROM alertas WHERE resuelta_at IS NULL').get().n, 2);
});
