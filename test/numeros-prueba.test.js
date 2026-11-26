import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import { config } from '../src/config.js';
import * as panel from '../src/panel.js';

const conNumeros = (lista, fn) => { const antes = [...config.telefonosPrueba]; config.telefonosPrueba.splice(0, antes.length, ...lista); return Promise.resolve().then(fn).finally(() => config.telefonosPrueba.splice(0, config.telefonosPrueba.length, ...antes)); };

test('los chats de los números de prueba no cuentan en resumen, estadísticas ni rendimiento', () => {
  const db = openDb(':memory:'); const repo = crearRepo(db);
  const crear = (id, telefono) => {
    repo.upsertConv({ id, contact_id: id, channel: 'whatsapp', nombre: id, telefono });
    repo.updateConv(id, { prompt_v: 1, tipo: 'captacion', prueba_reservada: 1, derivado: 1 });
    repo.addMessage({ conversation_id: id, autor: 'lead', texto: 'hola' });
    repo.addMessage({ conversation_id: id, autor: 'ia', texto: 'hola', enviado: 1 });
    repo.schedule(id, 'comercial-5h', new Date(Date.now() - 60e3).toISOString());
  };
  crear('real', '+34600111222'); crear('test', '+34 611 222 333'); crear('test2', '0034611222333');
  return conNumeros(['+34611222333'], () => {
    const r = panel.resumen(db, 1);
    assert.equal(r.conversaciones.n, 1);
    assert.deepEqual([r.mensajes.lead, r.mensajes.ia, r.atendidas, r.ahora.derivadas, r.ahora.pruebas], [1, 1, 1, 1, 1]);
    assert.equal(r.seguimientos.pendiente, 1);
    assert.equal(r.serie.reduce((a, d) => a + d.lead, 0), 1);
    assert.equal(panel.estadisticas(db, { dias: 30 }).total, 1);
    assert.equal(panel.rendimiento(db)[0].chats, 1);
    // En Chats se siguen viendo
    assert.equal(panel.conversaciones(db, {}).length, 3);
  }).then(() => conNumeros([], () => {
    assert.equal(panel.resumen(db, 1).conversaciones.n, 3);
    assert.equal(panel.estadisticas(db, { dias: 30 }).total, 3);
  }));
});
