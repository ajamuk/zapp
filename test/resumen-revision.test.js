import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import * as panel from '../src/panel.js';

test('resumen: socios que escriben, solo enviados, seguimientos por fecha de envío y «ahora» sin socios ni pruebas pasadas', () => {
  const db = openDb(':memory:'); const repo = crearRepo(db);
  const ahora = new Date('2026-11-24T12:00:00Z');
  const sql = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  const hoy = sql(new Date(ahora.getTime() - 3600e3)); const ayer = sql(new Date(ahora.getTime() - 26 * 3600e3));
  const crear = (id, extra = {}, creado = hoy) => {
    repo.upsertConv({ id, contact_id: id, channel: 'whatsapp', nombre: id, telefono: '6' + String(id.length).padStart(8, '1') });
    repo.updateConv(id, { tipo: 'captacion', ...extra });
    db.prepare('UPDATE conversations SET created_at = ? WHERE id = ?').run(creado, id);
  };
  const msg = (id, autor, cuando, enviado = 1) => db.prepare('UPDATE messages SET created_at = ? WHERE id = ?')
    .run(cuando, repo.addMessage({ conversation_id: id, autor, texto: 'x', enviado }).lastInsertRowid);

  // Socio con chat antiguo que escribe hoy: cuenta en «Socios que escribieron» y no en pausa
  crear('socio-viejo', { tipo: 'socio', ai_paused: 1, pause_reason: 'socio' }, '2026-10-01 10:00:00'); msg('socio-viejo', 'lead', hoy);
  // Socio con chat de hoy que no ha escrito hoy (solo ayer): no cuenta
  crear('socio-callado', { tipo: 'socio', ai_paused: 1 }, hoy); msg('socio-callado', 'lead', ayer);
  // Lead con solo un borrador: no es un chat atendido ni un mensaje de Sofía en la gráfica
  crear('borrador'); msg('borrador', 'lead', hoy); msg('borrador', 'ia', hoy, 0);
  // Lead atendido, en pausa, con la prueba ya pasada
  crear('atendido', { ai_paused: 1, prueba_reservada: 1, prueba_fecha: '2026-11-20T18:00:00.000Z' }); msg('atendido', 'lead', hoy); msg('atendido', 'ia', hoy);
  // Lead con la prueba por venir
  crear('con-prueba', { prueba_reservada: 1, prueba_fecha: '2026-11-26T18:00:00.000Z' });
  // Seguimiento creado ayer que sale hoy (cuenta hoy) y otro creado hoy para mañana (no cuenta todavía)
  const s1 = repo.schedule('atendido', 'comercial-5h', new Date(ahora.getTime() - 1800e3).toISOString());
  repo.schedule('con-prueba', 'comercial-5h', new Date(ahora.getTime() + 24 * 3600e3).toISOString());
  db.prepare("UPDATE scheduled SET created_at = ?, estado = 'enviado' WHERE conversation_id = 'atendido'").run(ayer); void s1;

  const r = panel.resumen(db, 1, ahora);
  assert.equal(r.conversaciones.socios, 1);
  assert.equal(r.conversaciones.leads, 3);
  assert.equal(r.atendidas, 1);
  assert.deepEqual([r.mensajes.ia, r.mensajes.borradores], [1, 1]);
  assert.equal(r.serie.reduce((a, d) => a + (d.ia || 0), 0), 1);
  assert.equal(r.seguimientos.enviado, 1);
  assert.equal(r.seguimientos.pendiente, undefined);
  assert.deepEqual([r.ahora.pausadas, r.ahora.pruebas], [1, 1]);
});
