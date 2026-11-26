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
  assert.deepEqual(buscarSocioPorTelefono(repo, '+34611111111', { rutas: {} }), { esSocio: true, exSocio: false, sede: 'getafe', nombre: 'A', tarifa: 'Tarifa L' });
  const ex = buscarSocioPorTelefono(repo, '622222222', { rutas: {} });
  assert.equal(ex.esSocio, false);
  assert.equal(ex.exSocio, true);
});

test('exsocio con la última tarifa hace menos de 3 meses cuenta como socio; más antiguo, como lead', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const Database = (await import('better-sqlite3')).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'socios-'));
  const crear = (nombre, filas) => {
    const f = path.join(dir, nombre);
    const db = new Database(f);
    db.exec('CREATE TABLE members (id TEXT, phone TEXT, active_until TEXT)');
    for (const [id, phone, hasta] of filas) db.prepare('INSERT INTO members VALUES (?, ?, ?)').run(id, phone, hasta);
    db.close();
    return f;
  };
  const rutas = {
    parla: crear('parla.sqlite', [['a', '622222222', '2026-11-07'], ['b', '633333333', '2026-07-31'], ['f', '666666666', '2027-01-07']]),
    getafe: crear('getafe.sqlite', [['d', '+34 644 444 444', '2026-09-01'], ['e', '633333333', '2026-08-01']]),
    las_rosas: path.join(dir, 'no-existe.sqlite'),
  };
  const repo = crearRepo(openDb(':memory:'));
  await sincronizarSocios(repo, { parla: { clientes: async () => [
    { id: 1, name: 'Baja médica', mobile_number: '622222222', current_memberships: [] },
    { id: 2, name: 'Antiguo', mobile_number: '633333333', current_memberships: [] },
  ] } });
  const ahora = new Date('2026-11-26T16:00:00Z');
  const reciente = buscarSocioPorTelefono(repo, '+34 622 222 222', { rutas, ahora });
  assert.equal(reciente.esSocio, true);
  assert.equal(reciente.exSocioReciente, true);
  assert.equal(reciente.tarifaHasta, '2026-11-07');
  assert.equal(reciente.sede, 'parla');
  // Última tarifa (la más reciente de todas las sedes) el 1 de agosto: más de 3 meses → lead
  const antiguo = buscarSocioPorTelefono(repo, '633333333', { rutas, ahora });
  assert.equal(antiguo.esSocio, false);
  assert.equal(antiguo.exSocio, true);
  assert.equal(antiguo.exSocioReciente, undefined);
  // Sin ficha en el índice de AimHarder pero con pago reciente en el registro de socios
  const soloRegistro = buscarSocioPorTelefono(repo, '644444444', { rutas, ahora });
  assert.equal(soloRegistro.esSocio, true);
  assert.equal(soloRegistro.sede, 'getafe');
  // Teléfono desconocido → lead
  assert.deepEqual(buscarSocioPorTelefono(repo, '655555555', { rutas, ahora }), { esSocio: false, exSocio: false, sede: null, nombre: null, tarifa: null });
  // Alta nueva: tarifa que empieza el mes que viene, ya pagada → socio, no exsocio
  const nueva = buscarSocioPorTelefono(repo, '666666666', { rutas, ahora });
  assert.equal(nueva.esSocio, true);
  assert.equal(nueva.exSocio, false);
  assert.equal(nueva.pagoVigente, true);
  assert.equal(nueva.exSocioReciente, undefined);
  assert.equal(nueva.tarifaHasta, '2027-01-07');
  // Con meses = 0 la regla queda desactivada (el pago vigente sigue contando)
  assert.equal(buscarSocioPorTelefono(repo, '666666666', { rutas, ahora, meses: 0 }).esSocio, true);
  assert.equal(buscarSocioPorTelefono(repo, '622222222', { rutas, ahora, meses: 0 }).esSocio, false);
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

test('al arrancar solo se sincronizan las sedes con socios de más de 4 h', async () => {
  const { sedesPorSincronizar, sincronizarSiHaceFalta } = await import('../src/aimharder/index.js');
  const repo = crearRepo(openDb(':memory:'));
  const ahora = Date.parse('2026-11-20T12:00:00Z');
  const fila = { telefono: '611111111', aimharder_id: 1, nombre: 'A', activo: 1, tarifa: 'L' };
  repo.reemplazarSocios('parla', [{ ...fila, sede: 'parla' }]);
  repo.reemplazarSocios('getafe', [{ ...fila, sede: 'getafe' }]);
  repo.db.prepare("UPDATE socios SET actualizado = '2026-11-20 10:00:00' WHERE sede = 'parla'").run();
  repo.db.prepare("UPDATE socios SET actualizado = '2026-11-20 06:00:00' WHERE sede = 'getafe'").run();
  assert.deepEqual(sedesPorSincronizar(repo, { ahora }), ['getafe', 'las_rosas']);

  const pedidas = [];
  const fake = (sede) => ({ clientes: async () => { pedidas.push(sede); return []; } });
  const apis = { parla: fake('parla'), getafe: fake('getafe'), las_rosas: fake('las_rosas') };
  await sincronizarSiHaceFalta(repo, { apis, ahora });
  assert.deepEqual(pedidas, ['getafe', 'las_rosas']);

  repo.db.prepare("UPDATE socios SET actualizado = '2026-11-20 11:00:00'").run();
  repo.reemplazarSocios('las_rosas', [{ ...fila, sede: 'las_rosas' }]);
  repo.reemplazarSocios('getafe', [{ ...fila, sede: 'getafe' }]);
  repo.db.prepare("UPDATE socios SET actualizado = '2026-11-20 11:00:00'").run();
  assert.equal(await sincronizarSiHaceFalta(repo, { apis, ahora }), null);
});
