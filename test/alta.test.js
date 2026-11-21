import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partirNombre, prepararFormulario, validarDatos, edad, elegirRecibo, hoyDdMmYyyy } from '../src/aimharder/alta-navegador.js';
import { mensajesAlta } from '../src/setter.js';

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
  const ok = { nombre_completo: 'Ana López', email: 'a@b.es', telefono: '611111111', fecha_nacimiento: '1990-01-01', sede: 'parla', tarifa: 'M', fecha_inicio: '2026-12-01' };
  const hoy = new Date('2026-11-20T10:00:00Z');
  assert.equal(validarDatos(ok, hoy), null);
  assert.match(validarDatos({ ...ok, telefono: '' }, hoy), /Faltan datos: telefono/);
  assert.match(validarDatos({ ...ok, nombre_completo: 'Ana' }, hoy), /apellido/);
  assert.match(validarDatos({ ...ok, email: 'mal' }, hoy), /Email/);
  assert.match(validarDatos({ ...ok, fecha_nacimiento: '2010-11-21' }, hoy), /16/);
  assert.equal(validarDatos({ ...ok, fecha_nacimiento: '2010-11-20' }, hoy), null); // cumple 16 hoy
  assert.equal(edad('2010-11-21', hoy), 15);
});

test('ficha de antiguo socio: abre la búsqueda, no una ficha nueva', () => {
  const f = prepararFormulario({ nombre_completo: 'Ana López', email: 'a@b.es', telefono: '+34611111111', fecha_nacimiento: '1990-01-01', sede: 'parla', tarifa: 'academy_2', fecha_inicio: '2026-11-23', aimharder_id: 123 });
  assert.equal(f.url, 'https://crossfitmetropolitanoparla.aimharder.com/clients');
  assert.equal(f.clienteId, 123);
  assert.equal(f.movil, '611111111');
});

test('fecha de emisión de hoy en Madrid y elección del recibo de la tarifa', () => {
  assert.equal(hoyDdMmYyyy(new Date('2026-11-20T23:30:00Z')), '21/11/2026');
  const r = elegirRecibo([{ id: 5, concept: 'Bono 10 11/2026' }, { id: 9, concept: 'CrossFit Academy 2 días 11/2026' }, { id: 7, concept: 'CrossFit Academy 2 días 10/2026' }], 'CrossFit Academy 2 días');
  assert.equal(r.id, 9);
  assert.equal(elegirRecibo([], 'x'), null);
});

test('aviso de alta al lead: sede, fecha, app, documentos e importe verificado', () => {
  const nuevo = mensajesAlta({ sede: 'parla', fecha_inicio: '2026-11-23', email: 'a@b.es', pendiente: 22.67, exSocio: false });
  assert.match(nuevo[0], /Parla.*lunes, 23 de noviembre/);
  assert.ok(nuevo.some((m) => /correo a a@b\.es/.test(m)));
  assert.ok(nuevo.some((m) => /app CrossFit MetroPolitano/.test(m)));
  assert.match(nuevo.at(-1), /firma los documentos.*22,67 €/);
  assert.equal(nuevo.length, 3); // con la burbuja de Sofía, 4 como mucho
  const ex = mensajesAlta({ sede: 'getafe', fecha_inicio: '2026-12-01', email: 'a@b.es', pendiente: 95, exSocio: true });
  assert.ok(ex.some((m) => /reenviado la invitación/.test(m)));
  assert.ok(ex.some((m) => /recuperarla/.test(m)));
  assert.match(ex.at(-1), /95 €/);
  assert.equal(ex.length, 3);
  for (const m of [...nuevo, ...ex]) { assert.ok(!/\.$/.test(m)); assert.ok(!/^[A-ZÁÉÍÓÚ]/.test(m)); }
});
