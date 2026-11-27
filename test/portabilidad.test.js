// Lo que hace falta para llevar Sofía a otro servidor o a un contenedor por negocio (docs/vps-propio.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, rutaConfig } from '../src/config.js';

test('configuración del negocio: la de CONFIG_DIR y, lo que falte, la de ejemplo del repositorio', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sofia-config-'));
  try {
    fs.writeFileSync(path.join(dir, 'tarifas.json'), '{}');
    const c = { ...config, configDir: dir };
    assert.equal(rutaConfig('tarifas.json', c), path.join(dir, 'tarifas.json'));
    assert.equal(rutaConfig('horarios.json', c), path.join(config.root, 'config', 'horarios.json'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('sin CONFIG_DIR se usa la carpeta config del repositorio y el servicio escucha solo en 127.0.0.1', (t) => {
  if (process.env.CONFIG_DIR || process.env.HOST) return t.skip('CONFIG_DIR o HOST puestos (p. ej. dentro de la imagen)');
  assert.equal(config.configDir, path.join(config.root, 'config'));
  assert.equal(rutaConfig('prompt-sofia.md'), path.join(config.root, 'config', 'prompt-sofia.md'));
  assert.equal(config.host, '127.0.0.1');
});

test('perfil del negocio: completa lo opcional y rechaza un perfil mal escrito', async () => {
  const { validarNegocio } = await import('../src/config.js');
  const n = validarNegocio({ nombre: 'Box Norte', sedes: [{ id: 'centro', nombre: 'Centro', alias: ['Centro', 'Plaza Mayor'] }, { id: 'sur', equipo: 'centro' }] });
  assert.equal(n.asistente, 'Sofía');
  assert.deepEqual(n.sedes[0].alias, ['centro', 'plaza mayor']);
  assert.deepEqual(n.sedes[1], { id: 'sur', nombre: 'sur', alias: ['sur'], aimharder: false, equipo: 'centro' });
  assert.throws(() => validarNegocio({ nombre: 'X', sedes: [] }), /sedes/);
  assert.throws(() => validarNegocio({ nombre: 'X', sedes: [{ id: 'Mal Id' }] }), /id/);
  assert.throws(() => validarNegocio({ nombre: 'X', sedes: [{ id: 'a' }, { id: 'a' }] }), /repetida/);
  assert.throws(() => validarNegocio({ nombre: 'X', sedes: [{ id: 'a', equipo: 'b' }] }), /equipo/);
});

test('el perfil de MetroPolitano da las mismas sedes, usuarios de GHL y chats que antes', async () => {
  const { normalizarSede } = await import('../src/knowledge.js');
  assert.deepEqual(config.negocio.sedes.map((s) => s.id), ['parla', 'getafe', 'las_rosas', 'el_canaveral']);
  assert.deepEqual(config.aimharder.sedes, ['parla', 'getafe', 'las_rosas']);
  assert.deepEqual(Object.keys(config.ghl.users), ['parla', 'getafe', 'las_rosas', 'el_canaveral']);
  assert.equal(config.ghl.users.el_canaveral, config.ghl.users.las_rosas); // la atiende el equipo de Las Rosas
  for (const [texto, sede] of [['Parla', 'parla'], ['el de El Bercial', 'getafe'], ['San Blas', 'las_rosas'], ['las rozas', 'las_rosas'], ['Vicálvaro', 'el_canaveral'], ['El Cañaveral', 'el_canaveral'], ['las_rosas', 'las_rosas'], ['Madrid', null]]) {
    assert.equal(normalizarSede(texto), sede, texto);
  }
});
