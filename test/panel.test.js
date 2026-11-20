import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { openDb, repo as crearRepo } from '../src/db.js';
import { crearApp } from '../src/server.js';
import { leerAjustes, guardarAjustes } from '../src/ajustes.js';

config.adminToken = 'clave-test';

async function servidor() {
  const repo = crearRepo(openDb(':memory:'));
  repo.upsertConv({ id: 'c1', contact_id: 'k1', channel: 'whatsapp', nombre: 'Ana', telefono: '+34611111111' });
  repo.updateConv('c1', { sede: 'parla', fase: 'f5 cierre', alta_estado: 'pendiente' });
  repo.addMessage({ conversation_id: 'c1', autor: 'lead', texto: 'cuánto cuesta en parla' });
  repo.addMessage({ conversation_id: 'c1', autor: 'ia', texto: 'academy 2 días son 85 €', enviado: 0 });
  repo.addAlta('c1', { nombre_completo: 'Ana López', email: 'a@b.es', sede: 'parla', tarifa: 'academy_2', fecha_inicio: '2026-11-23' }, 'simulada', 'sin guardar');
  repo.schedule('c1', 'comercial-5h', new Date(Date.now() + 3600e3).toISOString());
  repo.upsertConv({ id: 'prueba-x', contact_id: 'prueba-x', channel: 'whatsapp' });
  const srv = crearApp({ setter: {}, repo }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const api = (ruta, o = {}) => fetch(base + ruta, { ...o, headers: { authorization: 'Bearer clave-test', 'content-type': 'application/json' } });
  return { repo, srv, base, api };
}

test('panel: la página se sirve y los datos piden la clave', async () => {
  const { srv, base } = await servidor();
  try {
    const p = await fetch(base + '/panel');
    assert.equal(p.status, 200);
    assert.match(await p.text(), /Panel de Sofía/);
    assert.equal((await fetch(base + '/admin/panel/estado')).status, 401);
  } finally { srv.close(); }
});

test('panel: resumen, chats, detalle, altas y follow-ups (sin chats de prueba)', async () => {
  const { srv, api } = await servidor();
  try {
    const e = await (await api('/admin/panel/estado')).json();
    assert.equal(e.modo, 'shadow');
    assert.equal(e.contadores.todos, 1);
    assert.equal(e.contadores.alta, 1);
    const r = await (await api('/admin/panel/resumen?dias=7')).json();
    assert.equal(r.mensajes.borradores, 1);
    assert.equal(r.altas.simulada, 1);
    const l = await (await api('/admin/panel/conversaciones?filtro=seguimiento')).json();
    assert.equal(l.length, 1);
    assert.equal(l[0].ultimo_texto, 'academy 2 días son 85 €');
    const q = await (await api('/admin/panel/conversaciones?q=cuesta')).json();
    assert.equal(q.length, 1);
    const d = await (await api('/admin/panel/conversaciones/c1')).json();
    assert.equal(d.mensajes.length, 2);
    assert.equal(d.altas[0].datos.tarifa, 'academy_2');
    const a = await (await api('/admin/panel/altas')).json();
    assert.equal(a[0].nombre, 'Ana');
    const s = await (await api('/admin/panel/seguimientos')).json();
    assert.equal(s.proximos.length, 1);
    assert.equal(s.reglas.find((x) => x.id === 'comercial-5h').pendiente, 1);
  } finally { srv.close(); }
});

test('panel: pausar y reactivar un chat cancela sus follow-ups', async () => {
  const { srv, api, repo } = await servidor();
  try {
    await api('/admin/panel/conversaciones/c1/pausar', { method: 'POST' });
    assert.equal(repo.getConv('c1').ai_paused, 1);
    assert.equal(repo.db.prepare("SELECT count(*) n FROM scheduled WHERE estado='pendiente'").get().n, 0);
    await api('/admin/panel/conversaciones/c1/reanudar', { method: 'POST' });
    assert.equal(repo.getConv('c1').ai_paused, 0);
  } finally { srv.close(); }
});

test('ajustes: se validan, se guardan y cambian el horario en memoria', async () => {
  const { srv, api, repo } = await servidor();
  try {
    const mal = await api('/admin/panel/ajustes', { method: 'PUT', body: JSON.stringify({ horaInicio: 30 }) });
    assert.equal(mal.status, 400);
    const ok = await (await api('/admin/panel/ajustes', { method: 'PUT', body: JSON.stringify({ ia_activa: false, horaInicio: 9, seguimientos: { 'cierre-4-dias': false } }) })).json();
    assert.equal(ok.ia_activa, false);
    assert.equal(config.ai.horaInicio, 9);
    assert.equal(leerAjustes(repo).seguimientos['cierre-4-dias'], false);
    assert.equal(leerAjustes(repo).seguimientos['comercial-5h'], true);
    guardarAjustes(repo, { ia_activa: true, horaInicio: 8 });
  } finally { srv.close(); }
});
