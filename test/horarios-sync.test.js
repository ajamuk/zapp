import test from 'node:test';
import assert from 'node:assert/strict';
import { leerHorarios, diferencias } from '../src/horarios-sync.js';

const h = (weekday, time, start_date = '2025-09-01', end_date = null) => ({ weekday, time, start_date, end_date });
const api = (clases) => ({ clases: async () => Object.keys(clases).map((name, id) => ({ id, name })), horariosDeClase: async (id) => Object.values(clases)[id] });

test('lee el horario vigente, separa los días especiales y no borra una sede que falla', async () => {
  const anterior = { _plazas: 'x', parla: { crossfit: { lunes: ['07:00'] } }, getafe: { crossfit: { lunes: ['09:30'] } } };
  const r = await leerHorarios({
    getafe: api({ CrossFit: [h(0, '07:00'), h(0, '09:30'), h(1, '20:00', '2024-01-01', '2025-01-01'), h(3, '11:30', '2026-12-24', '2026-12-25')], 'CrossFit Academy': [h(3, '10:30', '2026-12-24', '2026-02-24')], 'MARATÓN DE REMO': [h(3, '07:00', '2026-11-22', '2026-11-27')] }),
    parla: { clases: async () => { throw new Error('429'); } },
  }, { hoy: '2026-11-21', anterior });
  assert.deepEqual(r.horarios.getafe, { crossfit: { lunes: ['07:00', '09:30'] } });
  assert.deepEqual(r.especiales.getafe, { '2026-12-24': { crossfit: ['11:30'], academy: ['10:30'] } });
  assert.deepEqual(r.horarios.parla, anterior.parla);
  assert.match(r.fallos[0], /parla: 429/);
  assert.deepEqual(diferencias(anterior, r.horarios), ['getafe · crossfit · lunes: añade 07:00']);
});

test('una sede sin clases de CrossFit se toma como fallo y conserva lo anterior', async () => {
  const anterior = { getafe: { crossfit: { lunes: ['09:30'] } } };
  const r = await leerHorarios({ getafe: api({ CrossFit: [] }) }, { hoy: '2026-11-21', anterior });
  assert.deepEqual(r.horarios.getafe, anterior.getafe);
  assert.equal(r.fallos.length, 1);
});
