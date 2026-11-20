import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partirNombre, prepararFormulario, validarDatos } from '../src/aimharder/alta-navegador.js';

test('parte el nombre completo en nombre y apellidos', () => {
  assert.deepEqual(partirNombre('Ana López García'), { nombre: 'Ana', apellido1: 'López', apellido2: 'García' });
  assert.deepEqual(partirNombre('Ana María López García'), { nombre: 'Ana María', apellido1: 'López', apellido2: 'García' });
  assert.deepEqual(partirNombre('Ana López'), { nombre: 'Ana', apellido1: 'López', apellido2: '' });
});

test('prepara el formulario con la tarifa y el subdominio de la sede', () => {
  const f = prepararFormulario({ nombre_completo: 'Ana López García', email: ' Ana@Example.com ', fecha_nacimiento: '1990-05-01', sede: 'las_rosas', tarifa: 'academy_3', fecha_inicio: '2026-11-23', telefono: '+34 611 111 111', canal: 'instagram' });
  assert.equal(f.url, 'https://crossfitmetropolitano.aimharder.com/clients?new');
  assert.equal(f.tarifaId, 38399);
  assert.equal(f.email, 'ana@example.com');
  assert.equal(f.movil, '611111111');
  assert.equal(f.nacimiento, '01/05/1990');
  assert.equal(f.inicio, '23/11/2026');
  assert.equal(f.origen, 'Instagram');
  assert.throws(() => prepararFormulario({ sede: 'getafe', tarifa: 'X' }));
});

test('valida los datos antes de abrir el navegador', () => {
  assert.match(validarDatos({ nombre_completo: 'A' }), /Faltan datos/);
  assert.match(validarDatos({ nombre_completo: 'A B', email: 'mal', fecha_nacimiento: '1990-01-01', sede: 'parla', tarifa: 'M', fecha_inicio: '2026-12-01' }), /Email/);
  assert.match(validarDatos({ nombre_completo: 'A B', email: 'a@b.es', fecha_nacimiento: '2015-01-01', sede: 'parla', tarifa: 'M', fecha_inicio: '2026-12-01' }), /Menor/);
});
