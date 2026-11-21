import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usosDe, costeUso, costeRun } from '../src/precios.js';
import { openDb, repo as crearRepo } from '../src/db.js';
import { consumo } from '../src/panel.js';
import { facturaAnthropic } from '../src/conciliacion.js';
import { config } from '../src/config.js';

const cerca = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test('coste: precios por modelo, caché de 5 min y de 1 hora, Haiku con prompt largo', () => {
  cerca(costeUso({ modelo: 'claude-sonnet-5-5', tokens_in: 1e6, tokens_out: 1e6, tokens_cache_read: 1e6, tokens_cache_write: 1e6 }), 2 + 10 + 0.1 + 2.5);
  cerca(costeUso({ modelo: 'claude-opus-5-5', tokens_cache_write_1h: 1e6 }), 8); // 1 h = 2 × entrada
  cerca(costeUso({ modelo: 'claude-opus-5-5-20260101', tokens_in: 1e6 }), 4); // sufijo de fecha
  cerca(costeUso({ modelo: 'claude-haiku-5-5', tokens_in: 50000, tokens_out: 1e6 }), 0.005 + 0.5);
  cerca(costeUso({ modelo: 'claude-haiku-5-5', tokens_in: 200000, tokens_out: 1e6 }), 0.1 + 2.5); // > 100K: 0,50 / 2,50
  cerca(costeRun({ coste_usd: 0.123, modelo: 'claude-opus-5-5', tokens_in: 1e6 }), 0.123); // guardado manda
});

test('uso de una respuesta: modelo real, caché por duración y respaldo cobrado aparte', () => {
  const normal = usosDe({ model: 'claude-sonnet-5-5', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 3000, cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 1000 } } }, 'claude-sonnet-5-5');
  assert.equal(normal.length, 1);
  assert.deepEqual([normal[0].tokens_cache_write, normal[0].tokens_cache_write_1h], [2000, 1000]);
  cerca(normal[0].coste_usd, (1000 * 2 + 200 * 10 + 5000 * 0.1 + 2000 * 2.5 + 1000 * 4) / 1e6);
  // Sonnet se niega y responde el de respaldo: se cobran los dos intentos, cada uno a su precio
  const res = { model: 'claude-opus-4-8', usage: { input_tokens: 900, output_tokens: 300, iterations: [
    { type: 'message', model: null, input_tokens: 900, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 900, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  ] } };
  const f = usosDe(res, 'claude-sonnet-5-5');
  assert.deepEqual(f.map((x) => [x.modelo, x.respaldo]), [['claude-sonnet-5-5', 0], ['claude-opus-4-8', 1]]);
  cerca(f[1].coste_usd, (900 * 5 + 300 * 25) / 1e6);
  assert.deepEqual(usosDe({ usage: {} }, 'x'), []); // sin tokens no hay fila
});

test('bases de pruebas: su gasto se copia en la base real y Consumo lo desglosa por parte y modelo', () => {
  const real = openDb(':memory:');
  const repo = crearRepo(real);
  const pruebas = crearRepo(openDb(':memory:'), { espejo: { db: real, campos: {} } });
  const bat = crearRepo(openDb(':memory:'), { espejo: { db: real, campos: { conversation_id: 'bateria-1', motivo: 'bateria' } } });
  repo.logRun({ conversation_id: 'a', motivo: 'respuesta', modelo: 'claude-sonnet-5-5', tokens_in: 1e6, coste_usd: 2 });
  pruebas.logRun({ conversation_id: 'prueba-x', motivo: 'respuesta', modelo: 'claude-sonnet-5-5', tokens_in: 1e6, coste_usd: 2 });
  pruebas.logRun({ conversation_id: 'prueba-x', motivo: 'respuesta', error: 'API caída' }); // los fallos no se copian
  bat.logRun({ conversation_id: 'prueba-bateria', motivo: 'respuesta', modelo: 'claude-haiku-5-5', tokens_out: 1e6, coste_usd: 0.5 });
  assert.equal(real.prepare('SELECT count(*) n FROM ai_runs').get().n, 3);
  const c = consumo(real);
  cerca(c.meses[0].usd, 4.5);
  assert.deepEqual(c.meses[0].motivos.map((x) => [x.motivo, x.usd]), [['Respuestas a leads', 2], ['Probar IA', 2], ['Batería de pruebas', 0.5]]);
  assert.deepEqual(c.meses[0].modelos.map((x) => x.nombre), ['Sonnet 5.5', 'Haiku 5.5']);
  assert.equal(c.dias.length, 1);
  cerca(c.dias[0].usd, 4.5);
});

test('factura de Anthropic: busca la clave de zapp por su pista y suma por día y modelo', async () => {
  const antes = config.ai.apiKey; config.ai.apiKey = 'sk-ant-api03-abcdefXYZ';
  const pedido = [];
  const cliente = { beta: { organization: {
    apiKeys: { list: async function* () { yield { id: 'apikey_otra', partial_key_hint: 'sk-ant-api03-zzz...QQQ' }; yield { id: 'apikey_zapp', partial_key_hint: 'sk-ant-api03-ab...XYZ' }; } },
    analytics: { cost: { list: async function* (p) {
      pedido.push(p);
      yield { starting_at: '2026-11-20T00:00:00Z', group: { model: 'claude-sonnet-5-5' }, cost: { amount: '61', currency: 'USD' } };
      yield { starting_at: '2026-11-20T00:00:00Z', group: { model: 'claude-opus-5-5' }, cost: { amount: '13.4', currency: 'USD' } };
    } } },
  } } };
  try {
    const f = await facturaAnthropic({ cliente, dias: 7, ahora: new Date('2026-11-21T10:00:00Z') });
    assert.equal(f.disponible, true);
    assert.deepEqual(pedido[0].api_key_ids, ['apikey_zapp']);
    assert.equal(pedido[0].starting_at, '2026-11-15T00:00:00.000Z');
    cerca(f.dias[0].usd, 0.744);
    cerca(f.dias[0].modelos['claude-opus-5-5'], 0.134);
  } finally { config.ai.apiKey = antes; }
});
