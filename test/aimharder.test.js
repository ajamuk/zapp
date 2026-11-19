import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import { normalizarTelefono, sincronizarSocios, buscarSocioPorTelefono } from '../src/aimharder/index.js';

test('normaliza teléfonos españoles', () => {
  assert.equal(normalizarTelefono('+34 604 91 47 86'), '604914786');
  assert.equal(normalizarTelefono('0034604914786'), '604914786');
  assert.equal(normalizarTelefono('604-914-786'), '604914786');
  assert.equal(normalizarTelefono('123'), null);
});

test('índice de socios: socio con tarifa vigente, exsocio sin ella', async () => {
  const repo = crearRepo(openDb(':memory:'));
  const fake = { clientes: async () => [
    { id: 1, name: 'A', mobile_number: '611111111', current_memberships: [{ membership_name: 'Tarifa L' }] },
    { id: 2, name: 'B', mobile_number: '+34 622 222 222', current_memberships: [] },
    { id: 3, name: 'C', mobile_number: null },
  ] };
  const r = await sincronizarSocios(repo, { getafe: fake });
  assert.deepEqual(r.getafe, { clientes: 3, socios: 1 });
  assert.deepEqual(buscarSocioPorTelefono(repo, '+34611111111'), { esSocio: true, exSocio: false, sede: 'getafe', nombre: 'A', tarifa: 'Tarifa L' });
  const ex = buscarSocioPorTelefono(repo, '622222222');
  assert.equal(ex.esSocio, false);
  assert.equal(ex.exSocio, true);
});
