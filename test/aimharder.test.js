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

test('token compartido: se relee en cada petición y nunca se renueva', async () => {
  const { AimHarderApi } = await import('../src/aimharder/api.js');
  let token = 'uno';
  const llamadas = [];
  const fetchImpl = async (url, opts) => {
    llamadas.push([url, opts.headers.Authorization]);
    if (url.includes('/auth/tokens/refresh')) throw new Error('no debe renovar');
    const st = opts.headers.Authorization === 'Bearer caducado' ? 410 : 200;
    return { status: st, ok: st === 200, text: async () => '{"data":[]}' };
  };
  const api = new AimHarderApi({ refresh: 'r', leerToken: () => token, fetchImpl });
  await api.req('GET', '/x');
  token = 'dos';
  await api.req('GET', '/x');
  assert.deepEqual(llamadas.map((l) => l[1]), ['Bearer uno', 'Bearer dos']);
  token = 'caducado';
  await assert.rejects(api.req('GET', '/x'), /410/);
  assert.ok(!llamadas.some((l) => l[0].includes('refresh')));
});

test('lee el almacén compartido de aimharder-mcp', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { leerTokenCompartido } = await import('../src/aimharder/index.js');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ah-')), 't.json');
  fs.writeFileSync(f, JSON.stringify({ centers: { las_rosas: { accessToken: 'tok', refreshToken: 'r' } } }));
  assert.equal(leerTokenCompartido(f, 'las_rosas'), 'tok');
  assert.throws(() => leerTokenCompartido(f, 'parla'), /no hay token de parla/);
});
