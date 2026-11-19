import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consultarHorarios, consultarTarifas, calcularPrimerRecibo, normalizarSede, tarifaRecomendada } from '../src/knowledge.js';

test('normaliza sedes', () => {
  assert.equal(normalizarSede('Las Rozas'), 'las_rosas');
  assert.equal(normalizarSede('vivo en Getafe'), 'getafe');
  assert.equal(normalizarSede('Cañaveral'), 'el_canaveral');
  assert.equal(normalizarSede('Móstoles'), null);
});

test('horarios filtrados por sede, modalidad y franja', () => {
  const r = consultarHorarios({ sede: 'parla', modalidad: 'academy', franja: 'manana' });
  assert.deepEqual(r.dias, { lunes: ['11:30'], miercoles: ['11:30'], viernes: ['11:30'] });
  const t = consultarHorarios({ sede: 'getafe', modalidad: 'academy', franja: 'tarde' });
  assert.deepEqual(t.dias.lunes, ['17:00', '18:00', '19:00']);
  // Parla CrossFit el lunes no tiene 16:30 (eso es HYROX): el error que cometía Zapp
  const cf = consultarHorarios({ sede: 'parla', modalidad: 'crossfit', franja: 'tarde' });
  assert.ok(!cf.dias.lunes.includes('16:30'));
  assert.equal(consultarHorarios({ sede: 'parla' }).ok, false);
});

test('tarifas: recomienda una y no mezcla sedes', () => {
  const r = consultarTarifas({ sede: 'getafe', familia: 'crossfit_hyrox', dias_por_semana: 4 });
  assert.equal(r.recomendada.clave, 'XL');
  assert.equal(r.recomendada.euros_mes, 119);
  assert.equal(r.opciones.length, 4);
  const a = consultarTarifas({ sede: 'las_rosas', familia: 'academy', dias_por_semana: 3 });
  assert.equal(a.recomendada.euros_mes, 105);
  assert.equal(consultarTarifas({ sede: 'el_canaveral', familia: 'academy' }).ok, false);
  assert.equal(tarifaRecomendada('crossfit', 1), 'S');
  assert.equal(tarifaRecomendada('crossfit', 2), 'M');
});

test('primer recibo prorrateado: caso real de Zapp (Las Rosas, Academy 3 días, 23 nov → 28 €)', () => {
  const r = calcularPrimerRecibo({ sede: 'las_rosas', tarifa: 'academy_3', fecha_inicio: '2026-11-23' });
  assert.equal(r.primer_recibo, 28);
  assert.equal(calcularPrimerRecibo({ sede: 'parla', tarifa: 'academy_3', fecha_inicio: '2026-12-01' }).primer_recibo, 95);
  assert.equal(calcularPrimerRecibo({ sede: 'parla', tarifa: 'X', fecha_inicio: '2026-12-01' }).ok, false);
});
