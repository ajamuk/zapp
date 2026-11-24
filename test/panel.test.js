import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { openDb, repo as crearRepo } from '../src/db.js';
import { crearApp } from '../src/server.js';
import { leerAjustes, guardarAjustes } from '../src/ajustes.js';

config.adminToken = 'clave-test';

async function servidor(complete) {
  const repo = crearRepo(openDb(':memory:'));
  repo.upsertConv({ id: 'c1', contact_id: 'k1', channel: 'whatsapp', nombre: 'Ana', telefono: '+34611111111' });
  repo.updateConv('c1', { sede: 'parla', fase: 'f5 cierre', alta_estado: 'pendiente' });
  repo.addMessage({ conversation_id: 'c1', autor: 'lead', texto: 'cuánto cuesta en parla' });
  repo.addMessage({ conversation_id: 'c1', autor: 'ia', texto: 'academy 2 días son 85 €', enviado: 0 });
  repo.addAlta('c1', { nombre_completo: 'Ana López', email: 'a@b.es', sede: 'parla', tarifa: 'academy_2', fecha_inicio: '2026-11-23' }, 'simulada', 'sin guardar');
  repo.schedule('c1', 'comercial-5h', new Date(Date.now() + 3600e3).toISOString());
  repo.upsertConv({ id: 'prueba-x', contact_id: 'prueba-x', channel: 'whatsapp' });
  const srv = crearApp({ setter: {}, repo, complete }).listen(0);
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

test('MetroTools exige sesión administrativa del proxy y petición del panel', async () => {
  const { srv, base } = await servidor();
  const page = base + '/metrotools/';
  const route = page + 'api/panel/estado';
  const admin = { authorization: 'Bearer clave-test', 'x-cfmpo-admin': '1' };
  const browser = { 'x-metrotools-client': 'zapp' };
  try {
    assert.equal((await fetch(page)).status, 403);
    assert.equal((await fetch(page, { headers: { ...admin, 'x-cfmpo-admin': '0' } })).status, 403);
    assert.equal((await fetch(page, { headers: { 'x-cfmpo-admin': '1' } })).status, 403);
    const ok = await fetch(page, { headers: admin });
    assert.equal(ok.status, 200);
    const html = await ok.text();
    assert.match(html, /metro-os\/v4.4.0\/metro-platform.js/);
    const csp = ok.headers.get('content-security-policy');
    const scriptSrc = csp.split('; ').find((directive) => directive.startsWith('script-src '));
    assert.match(scriptSrc, /^script-src 'sha256-[\w+/=]+' https:\/\/apps\.crossfitmpo\.com\/metro-os\/v4\.4\.0\/metro-model\.js https:\/\/apps\.crossfitmpo\.com\/metro-os\/v4\.4\.0\/metro-platform\.js$/);
    assert.equal((await fetch(route, { headers: admin })).status, 403);
    const data = await fetch(route, { headers: { ...admin, ...browser } });
    assert.equal(data.status, 200);
    assert.equal(data.headers.get('cache-control'), 'private, no-store');
  } finally { srv.close(); }
});

test('el simulador mantiene el historial ficticio fuera de la base operativa', async () => {
  const complete = async ({ messages }) => ({
    content: [{ type: 'tool_use', name: 'responder', input: {
      mensajes: [messages.length === 1 ? 'hola' : 'seguimos'], fase: 'f1 apertura', sede: 'parla',
    } }],
  });
  const { srv, api, repo } = await servidor(complete);
  const post = (ruta, datos) => api(ruta, { method: 'POST', body: JSON.stringify({ sesion: 'aislada', ...datos }) });
  try {
    for (const resultado of ['hola', 'seguimos']) {
      const response = await post('/admin/probar', { texto: 'quiero entrenar en parla' });
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).mensajes, [resultado]);
    }
    assert.equal(repo.getConv('prueba-aislada'), undefined);
    assert.equal(repo.db.prepare('SELECT count(*) n FROM ai_runs').get().n, 0);
    assert.equal((await post('/admin/probar/reiniciar')).status, 200);
    assert.deepEqual((await (await post('/admin/probar', { texto: 'hola' })).json()).mensajes, ['hola']);
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

test('panel: embudo por sede pide la clave y valida el mes', async () => {
  const repo = crearRepo(openDb(':memory:'));
  repo.upsertConv({ id: 'e1', contact_id: 'ke1', channel: 'whatsapp', nombre: 'E', telefono: '+34600123123' });
  repo.updateConv('e1', { sede: 'parla' });
  repo.db.prepare("UPDATE conversations SET created_at = '2026-09-10 10:00:00' WHERE id = 'e1'").run();
  const srv = crearApp({ setter: {}, repo, embudoOpciones: { dir: '/no-existe', socios: {} } }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}/admin/panel/embudo`;
  const h = { headers: { authorization: 'Bearer clave-test' } };
  try {
    assert.equal((await fetch(base + '?mes=2026-09')).status, 401);
    assert.equal((await fetch(base + '?mes=x', h)).status, 400);
    const r = await (await fetch(base + '?mes=2026-09', h)).json();
    assert.equal(r.sedes.find((s) => s.sede === 'parla').leads, 1);
    const p = await (await fetch(`http://127.0.0.1:${srv.address().port}/panel`)).text();
    assert.match(p, /Embudo por sede/);
  } finally { srv.close(); }
});

test('panel: preguntas sin respuesta — listar, responder (con las iguales de otros chats), contestar al lead y descartar', async () => {
  const repo = crearRepo(openDb(':memory:'));
  repo.upsertConv({ id: 'c1', contact_id: 'k1', channel: 'whatsapp', nombre: 'Ana' });
  repo.upsertConv({ id: 'c2', contact_id: 'k2', channel: 'whatsapp', nombre: 'Luis' });
  const { apuntar } = await import('../src/preguntas.js');
  const a = apuntar(repo.db, { conversation_id: 'c1', sede: 'parla', pregunta: '¿Hay fisio?' }).id;
  apuntar(repo.db, { conversation_id: 'c2', pregunta: 'hay fisio' });
  const otra = apuntar(repo.db, { conversation_id: 'c2', pregunta: '¿Se puede ir con carrito?' }).id;
  const contestadas = [];
  const setter = { contestarPregunta: async (p) => { contestadas.push(p.conversation_id); return 'enviada al lead'; } };
  const srv = crearApp({ setter, repo, complete: async () => ({}) }).listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const api = (ruta, o = {}) => fetch(base + '/admin' + ruta, { ...o, headers: { authorization: 'Bearer clave-test', 'content-type': 'application/json' } });
  try {
    const l = await (await api('/panel/preguntas')).json();
    assert.equal(l.preguntas.length, 3);
    assert.equal(l.preguntas.find((p) => p.id === a).chat.nombre, 'Ana');
    assert.equal((await api(`/panel/preguntas/${a}/responder`, { method: 'POST', body: '{}' })).status, 400);
    const r = await (await api(`/panel/preguntas/${a}/responder`, { method: 'POST', body: JSON.stringify({ respuesta: 'Sí, los martes' }) })).json();
    assert.deepEqual([r.respondidas, r.contestando], [2, true]);
    await new Promise((x) => setTimeout(x, 50));
    assert.deepEqual(contestadas.sort(), ['c1', 'c2']);
    const filas = repo.db.prepare("SELECT conversation_id, usar, enviada FROM preguntas WHERE estado = 'respondida' ORDER BY id").all();
    assert.deepEqual(filas, [{ conversation_id: 'c1', usar: 1, enviada: 'enviada al lead' }, { conversation_id: 'c2', usar: 0, enviada: 'enviada al lead' }]);
    await api(`/panel/preguntas/${otra}/descartar`, { method: 'POST', body: '{}' });
    assert.equal((await (await api('/panel/preguntas?estado=pendiente')).json()).preguntas.length, 0);
  } finally { srv.close(); }
});

test('ajustes: los teléfonos de prueba se añaden y quitan desde el panel y el setter los ve sin reiniciar', async () => {
  const { srv, api } = await servidor();
  const { esTelefonoPrueba } = await import('../src/setter.js');
  const guardar = (lista) => api('/admin/panel/ajustes', { method: 'PUT', body: JSON.stringify({ telefonosPrueba: lista }) });
  try {
    const r = await (await guardar(['600 111 222', '+34 600-111-222', '0034611222333'])).json();
    assert.deepEqual(r.telefonosPrueba, ['+34600111222', '+34611222333']); // limpios y sin repetidos
    assert.ok(esTelefonoPrueba('+34600111222', config.telefonosPrueba));
    assert.equal((await guardar(['hola'])).status, 400);
    assert.equal((await guardar(['12345'])).status, 400);
    const q = await (await guardar(['611222333'])).json();
    assert.deepEqual(q.telefonosPrueba, ['+34611222333']);
    assert.ok(!esTelefonoPrueba('+34600111222', config.telefonosPrueba));
    // Guardar otros ajustes no toca la lista
    await api('/admin/panel/ajustes', { method: 'PUT', body: JSON.stringify({ minDelay: 1, maxDelay: 2 }) });
    assert.deepEqual((await (await api('/admin/panel/ajustes')).json()).telefonosPrueba, ['+34611222333']);
  } finally { await guardar([]); srv.close(); }
});
