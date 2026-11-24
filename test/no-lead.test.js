import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, repo as crearRepo } from '../src/db.js';
import * as etq from '../src/etiquetas.js';
import * as panel from '../src/panel.js';
import { destinatarios } from '../src/followups.js';

// Etiquetas con la acción «no es un lead»: Sofía no trabaja ese chat y no cuenta en ninguna cifra.

const montar = () => {
  const repo = crearRepo(openDb(':memory:'));
  const tags = [];
  const ghl = { addTags: async (_c, t) => { tags.push(...t); }, removeTags: async () => {} };
  const etiquetas = new etq.Etiquetador({ repo, ghl });
  const ahora = new Date().toISOString();
  for (const id of ['lead', 'proveedor']) {
    repo.upsertConv({ id, contact_id: `k-${id}`, channel: 'whatsapp', nombre: id });
    repo.updateConv(id, { last_inbound_at: ahora });
    repo.addMessage({ conversation_id: id, autor: 'lead', texto: 'hola', created_at: ahora });
    repo.addMessage({ conversation_id: id, autor: 'ia', texto: 'hola!', created_at: ahora });
  }
  const marca = etq.crear(repo.db, { nombre: 'No es lead', acciones: { no_lead: true, reanudar_ia: true, derivar: true } });
  return { repo, etiquetas, marca, tags };
};

test('la acción «no es un lead» siempre pausa y no se combina con reanudar ni derivar', () => {
  const { marca } = montar();
  assert.equal(marca.acciones.no_lead, true);
  assert.equal(marca.acciones.pausar_ia, true);
  assert.equal(marca.acciones.reanudar_ia, false);
  assert.equal(marca.acciones.derivar, false);
});

test('al marcar un chat, Sofía se pausa, se cancelan sus seguimientos y sale de las cifras', async () => {
  const { repo, etiquetas, marca, tags } = montar();
  repo.db.prepare("INSERT INTO scheduled (conversation_id, regla_id, due_at, tipo) VALUES ('proveedor', 'x', datetime('now', '+1 day'), 'silencio')").run();
  const antes = panel.resumen(repo.db, 1);
  assert.equal(antes.conversaciones.leads, 2);
  assert.equal(antes.conversaciones.no_leads, 0);

  assert.equal((await etiquetas.poner('proveedor', marca.id, 'manual')).puesta, true);
  const conv = repo.getConv('proveedor');
  assert.equal(conv.ai_paused, 1);
  assert.equal(conv.derivado, 0);
  assert.equal(repo.db.prepare("SELECT estado FROM scheduled WHERE conversation_id = 'proveedor'").get().estado, 'cancelado');
  assert.deepEqual(tags, ['no es lead']); // también queda como tag en GHL
  assert.equal(etq.esNoLead(repo.db, 'proveedor'), true);
  assert.equal(etq.esNoLead(repo.db, 'lead'), false);

  const r = panel.resumen(repo.db, 1);
  assert.equal(r.conversaciones.leads, 1);
  assert.equal(r.conversaciones.no_leads, 1);
  assert.equal(r.atendidas, 1);
  assert.equal(r.mensajes.lead, 1);
  assert.equal(r.ahora.pausadas, 0); // no engorda «con Sofía en pausa»
  assert.equal(panel.estadisticas(repo.db, { dias: 30 }).total, 1);
  // En Chats: fuera de «Leads» y dentro de «No son leads»
  assert.deepEqual(panel.conversaciones(repo.db, { criterios: { estado: ['leads'] } }).map((c) => c.id), ['lead']);
  assert.deepEqual(panel.conversaciones(repo.db, { criterios: { estado: ['no_leads'] } }).map((c) => c.id), ['proveedor']);
  // Tampoco recibe lanzamientos
  assert.deepEqual(destinatarios(repo.db, { dias_actividad: 30, canales: ['whatsapp'] }).map((c) => c.id), ['lead']);
});

test('al quitar la marca (se puso por error), el chat vuelve a contar y Sofía vuelve a atenderlo', async () => {
  const { repo, etiquetas, marca } = montar();
  await etiquetas.poner('proveedor', marca.id, 'manual');
  await etiquetas.quitar('proveedor', marca.id);
  assert.equal(repo.getConv('proveedor').ai_paused, 0);
  assert.equal(panel.resumen(repo.db, 1).conversaciones.leads, 2);

  // Si entre medias la pausa pasó a ser por otro motivo, quitar la marca no la levanta
  await etiquetas.poner('proveedor', marca.id, 'manual');
  repo.updateConv('proveedor', { pause_reason: 'humano escribió' });
  await etiquetas.quitar('proveedor', marca.id);
  assert.equal(repo.getConv('proveedor').ai_paused, 1);
});

test('poner el tag en GHL también marca el chat', async () => {
  const { repo, etiquetas } = montar();
  await etiquetas.sincronizarContacto('k-proveedor', ['No Es  Lead']);
  assert.equal(etq.esNoLead(repo.db, 'proveedor'), true);
  assert.equal(repo.getConv('proveedor').ai_paused, 1);
});

