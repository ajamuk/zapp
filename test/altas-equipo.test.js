// Altas que el equipo termina a mano: se dan por hechas cuando el registro de socios ya tiene el pago.
// Datos sintéticos: ningún correo, teléfono ni id es real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb, repo as crearRepo } from '../src/db.js';
import { estadoAislamiento } from '../src/aislamiento.js';
import { cerrarAltasDelEquipo } from '../src/altas-equipo.js';
import * as panel from '../src/panel.js';

const AISL = estadoAislamiento({ numero: '+34910000001', locationId: 'loc', locationCliente: 'loc' });
const hoy = new Date().toISOString().slice(0, 10);

function montar() {
  const db = openDb(':memory:'); const repo = crearRepo(db);
  const ruta = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alteq-')), 'clientes.sqlite');
  const soc = new Database(ruta);
  soc.exec('CREATE TABLE members (id TEXT, email TEXT, phone TEXT, first_payment TEXT, last_payment TEXT)');
  const socio = soc.prepare('INSERT INTO members VALUES (?, ?, ?, ?, ?)');
  socio.run('1', 'pagada@correo.es', '600111222', '2025-08-20', hoy);        // exsocia: el equipo la termina y paga hoy
  socio.run('2', 'sinpagar@correo.es', '600333444', '2025-01-10', '2025-06-01'); // ficha antigua, aún sin pagar
  socio.run('3', 'otra@correo.es', '600555666', null, hoy);                  // pagada, pero su chat es de otro número
  soc.close();
  const alta = (id, email, estado, { aislado = true, altaEstado = 'pendiente' } = {}) => {
    repo.upsertConv({ id, contact_id: `k-${id}`, channel: 'whatsapp', nombre: id, telefono: '+34699999999' });
    repo.updateConv(id, { alta_estado: altaEstado, ...(aislado ? { aislado_num: AISL.clave } : {}) });
    repo.addAlta(id, { sede: 'getafe', tarifa: 'L', fecha_inicio: '2026-12-01', nombre_completo: id, email }, estado, 'x');
  };
  const quitadas = [];
  const ghl = { removeTags: async (contacto, tags) => { quitadas.push([contacto, ...tags]); } };
  return { db, repo, alta, ghl, quitadas, socios: { getafe: ruta } };
}

test('alta fallida que el equipo termina y se paga: queda preparada, superada en el panel y sin la tarea en GHL', async () => {
  const { db, repo, alta, ghl, quitadas, socios } = montar();
  alta('lorena', 'pagada@correo.es', 'fallida');
  alta('pendiente', 'sinpagar@correo.es', 'fallida');
  const cerradas = await cerrarAltasDelEquipo({ repo, ghl, socios, aislamiento: AISL });
  assert.deepEqual(cerradas, ['lorena']);
  assert.equal(repo.getConv('lorena').alta_estado, 'preparada');
  assert.equal(repo.getConv('pendiente').alta_estado, 'pendiente', 'sin pago sigue en manos del equipo');
  assert.deepEqual(quitadas, [['k-lorena', 'alta fallida']]);
  const filas = panel.altas(db, 100, { socios }).filter((a) => a.conversation_id === 'lorena');
  assert.deepEqual(filas.map((a) => [a.estado, a.superada, a.pago]), [['preparada', false, 'pagada'], ['fallida', true, null]]);
  // Repetirlo no hace nada más
  assert.deepEqual(await cerrarAltasDelEquipo({ repo, ghl, socios, aislamiento: AISL }), []);
  assert.equal(quitadas.length, 1);
});

test('no toca las ya preparadas, las rechazadas, las de prueba ni GHL en chats de otro número', async () => {
  const { repo, alta, ghl, quitadas, socios } = montar();
  alta('hecha', 'pagada@correo.es', 'preparada', { altaEstado: 'preparada' });
  alta('rechazada', 'pagada@correo.es', 'rechazada');
  alta('prueba-1', 'pagada@correo.es', 'fallida');
  alta('ajeno', 'otra@correo.es', 'fallida', { aislado: false });
  const cerradas = await cerrarAltasDelEquipo({ repo, ghl, socios, aislamiento: AISL });
  assert.deepEqual(cerradas, ['ajeno'], 'el estado se corrige aquí…');
  assert.deepEqual(quitadas, [], '…pero en GHL no se toca un contacto de otro número');
  assert.equal(repo.getConv('rechazada').alta_estado, 'pendiente');
});

test('sin registro de socios de la sede no se da nada por hecho', async () => {
  const { repo, alta, ghl } = montar();
  alta('lorena', 'pagada@correo.es', 'fallida');
  assert.deepEqual(await cerrarAltasDelEquipo({ repo, ghl, socios: {}, aislamiento: AISL }), []);
  assert.equal(repo.getConv('lorena').alta_estado, 'pendiente');
});
