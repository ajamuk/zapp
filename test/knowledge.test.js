import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consultarHorarios, consultarTarifas, calcularPrimerRecibo, normalizarSede, tarifaRecomendada, tramoCanaveral, cierresAnticipados, pagoCanaveral } from '../src/knowledge.js';

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
  // Viernes de Academy en Getafe: el horario de Zapp tenía una clase de 19:00 que ya no existe
  assert.deepEqual(t.dias.viernes, ['17:00', '18:00']);
  // Getafe no tiene Open Box
  assert.deepEqual(consultarHorarios({ sede: 'getafe', modalidad: 'open box' }).dias, {});
  assert.equal(consultarHorarios({ sede: 'parla' }).ok, false);
});

test('tarifas: recomienda una y no mezcla sedes', () => {
  const r = consultarTarifas({ sede: 'getafe', familia: 'crossfit_hyrox', dias_por_semana: 4 });
  assert.equal(r.recomendada.clave, 'XL');
  assert.equal(r.recomendada.euros_mes, 119);
  assert.equal(r.opciones.length, 4);
  const a = consultarTarifas({ sede: 'las_rosas', familia: 'academy', dias_por_semana: 3 });
  assert.equal(a.recomendada.euros_mes, 105);
  // El Cañaveral: cuota habitual y precio de apertura por tramo; sin alta ni primer recibo todavía
  const c = consultarTarifas({ sede: 'el cañaveral', familia: 'academy', dias_por_semana: 2 });
  assert.equal(c.recomendada.euros_mes_habitual_desde_mayo, 95);
  assert.equal(c.recomendada.euros_mes_apertura_feb_a_abr['-50% (plazas 1 a 10)'], 47.5);
  assert.equal(c.opciones.length, 3);
  assert.equal(consultarTarifas({ sede: 'el_canaveral', familia: 'crossfit' }).opciones.at(-1).euros_mes_apertura_feb_a_abr['-10% (plazas 111 a 200)'], 108);
  // Los regalos de apertura salen siempre con las tarifas de El Cañaveral
  const reg = consultarTarifas({ sede: 'el_canaveral', familia: 'academy' }).regalos;
  assert.ok(reg.en_cualquier_tramo); assert.match(reg.comba, /comba profesional/i); assert.match(reg.seminario, /seminario exclusivo/i);
  // Alta en El Cañaveral: empieza el 1 de febrero aunque se pida antes, con el descuento del tramo que toca
  const o = calcularPrimerRecibo({ sede: 'el_canaveral', tarifa: 'academy_2', fecha_inicio: '2026-12-01' });
  assert.deepEqual([o.fecha_inicio, o.descuento_pct, o.cuota_con_descuento, o.primer_recibo, o.cuota_mensual], ['2027-02-01', 50, 47.5, 47.5, 95]);
  assert.equal(calcularPrimerRecibo({ sede: 'el_canaveral', tarifa: 'XL', fecha_inicio: '2027-02-01', plazas_ocupadas: 10 }).primer_recibo, 84); // plaza 11: 30 %
  assert.equal(calcularPrimerRecibo({ sede: 'el_canaveral', tarifa: 'XL', fecha_inicio: '2027-02-01', plazas_ocupadas: 200 }).descuento_pct, 0);
  assert.equal(calcularPrimerRecibo({ sede: 'el_canaveral', tarifa: 'M', fecha_inicio: '2027-05-10', plazas_ocupadas: 0 }).descuento_pct, 0); // el descuento acaba en abril
  assert.deepEqual([0, 9, 10, 34, 35, 109, 110, 199, 200].map((n) => tramoCanaveral(n).descuento), [50, 50, 30, 30, 20, 20, 10, 10, 0]);
  assert.equal(consultarTarifas({ sede: 'el_canaveral', familia: 'academy', plazas_ocupadas: 40 }).tramo_actual.descuento_pct, 20);
  assert.equal(tarifaRecomendada('crossfit', 1), 'S');
  assert.equal(tarifaRecomendada('crossfit', 2), 'M');
});

test('primer recibo prorrateado: caso real de Zapp (Las Rosas, Academy 3 días, 23 nov → 28 €)', () => {
  const r = calcularPrimerRecibo({ sede: 'las_rosas', tarifa: 'academy_3', fecha_inicio: '2026-11-23' });
  assert.equal(r.primer_recibo, 28);
  assert.equal(calcularPrimerRecibo({ sede: 'parla', tarifa: 'academy_3', fecha_inicio: '2026-12-01' }).primer_recibo, 95);
  assert.equal(calcularPrimerRecibo({ sede: 'parla', tarifa: 'X', fecha_inicio: '2026-12-01' }).ok, false);
});

test('festivos por sede: comunes + locales del municipio', async () => {
  const { esFestivo, knowledge } = await import('../src/knowledge.js');
  assert.equal(esFestivo('getafe', '2027-05-17'), true);
  assert.equal(esFestivo('parla', '2027-05-17'), false);
  assert.equal(esFestivo('las rosas', '2027-11-09'), true);
  assert.equal(esFestivo('parla', '2026-12-08'), true);
  assert.match(knowledge.negocio, /### Getafe[\s\S]*lunes, 17 de mayo de 2027/);
  assert.match(knowledge.negocio, /Pendiente: Festivos locales de 2027/);
});

test('prorrateo Parla Academy 2 días desde el 23 nov coincide con AimHarder (22,67 €)', async () => {
  const { calcularPrimerRecibo } = await import('../src/knowledge.js');
  const r = calcularPrimerRecibo({ sede: 'parla', tarifa: 'academy_2', fecha_inicio: '2026-11-23' });
  assert.equal(r.primer_recibo, 22.67);
});

test('Parla cierra a las 13:30 en Nochebuena y Nochevieja: solo las clases que terminan antes', () => {
  const c = cierresAnticipados('parla', 'crossfit', { hoy: '2026-11-21' });
  assert.deepEqual(c.map((x) => [x.fecha, x.horas]), [['2026-12-24', ['09:30']], ['2026-12-31', ['09:30']]]); // jueves: 09:30 sí, 16:30 en adelante no
  assert.match(c[0].nota, /Nochebuena.*cierra a las 13:30/);
  assert.deepEqual(cierresAnticipados('parla', 'hyrox', { hoy: '2026-12-25' }).map((x) => x.horas), [['07:00', '10:30']]);
  assert.match(cierresAnticipados('parla', 'academy', { hoy: '2026-12-25' })[0].nota, /no hay academy/);
  assert.deepEqual(cierresAnticipados('getafe', 'crossfit', { hoy: '2026-11-21' }), []);
  // Un cierre a las 13:30 deja entrar la clase de las 12:30 (lunes) y fuera la de las 13:00
  assert.deepEqual(cierresAnticipados('parla', 'crossfit', { hoy: '2026-11-21', cierres: { parla: { '2026-11-23': { cierra: '13:30' } } } })[0].horas, ['07:00', '09:30', '10:30', '12:30']);
});

test('los días especiales de consultar_horarios se cuentan desde el «hoy» que se le pasa (reloj del setter, zona del negocio)', () => {
  const fechas = (hoy) => (consultarHorarios({ sede: 'parla', modalidad: 'crossfit' }, { hoy }).dias_con_horario_especial || []).map((x) => x.fecha);
  assert.ok(fechas('2026-12-24').includes('2026-12-24'), 'el mismo día todavía cuenta');
  assert.ok(!fechas('2026-12-25').includes('2026-12-24'), 'al día siguiente ya no');
});

test('El Cañaveral: mientras el pago no esté habilitado, no se le dice al lead que pague ya', () => {
  assert.match(pagoCanaveral(), /TODAVÍA NO ESTÁ HABILITADO/);
  assert.equal(calcularPrimerRecibo({ sede: 'el_canaveral', tarifa: 'M', fecha_inicio: '2027-02-01' }).pago_habilitado, false);
});

test('horarios: cada hora con los días exactos en que hay clase (sin «de lunes a viernes» de más)', async () => {
  const { horasPorDias, textoDias } = await import('../src/knowledge.js');
  const dias = {
    lunes: ['07:00', '09:30', '10:30', '18:30'], martes: ['09:30', '18:30'], miercoles: ['07:00', '09:30', '18:30'],
    jueves: ['09:30', '18:30'], viernes: ['07:00', '09:30', '10:30', '18:30'], sabado: ['10:00'],
  };
  assert.deepEqual(horasPorDias(dias), [
    'de lunes a viernes: 09:30, 18:30',
    'lunes, miércoles y viernes: 07:00',
    'lunes y viernes: 10:30',
    'sábado: 10:00',
  ]);
  assert.equal(textoDias(['martes', 'miercoles', 'jueves']), 'de martes a jueves');
  assert.equal(textoDias(['viernes', 'lunes']), 'lunes y viernes');
  assert.deepEqual(horasPorDias({}), []);
});
