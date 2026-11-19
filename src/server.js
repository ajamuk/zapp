import crypto from 'node:crypto';
import express from 'express';
import { config } from './config.js';
import { parseWebhook } from './ghl.js';
import { Setter } from './setter.js';

const igual = (a, b) => {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};

/** GHL de mentira para el chat de pruebas: guarda lo que se enviaría. */
class GhlCaptura {
  constructor() { this.salida = []; }
  async sendMessage({ texto }) { this.salida.push(texto); return { messageId: null }; }
  async sendTemplate({ variables }) { this.salida.push(`[plantilla] ${variables[0]}`); return {}; }
  async addTags(_, t) { this.salida.push(`[etiquetas] ${t.join(', ')}`); }
  async removeTags() {}
  async assign() {}
  async addNote() {}
  async getContact() { return { contact: {} }; }
}

export function crearApp({ setter, repo, aimharder, avisar, complete }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, modo: config.mode }));

  // Webhook de GHL (mensajes entrantes y salientes). Responde rápido; el trabajo se hace después.
  app.post('/webhooks/ghl', async (req, res) => {
    if (!igual(req.get('x-setter-secret'), config.webhookSecret)) return res.status(401).json({ error: 'secreto no válido' });
    const evt = parseWebhook(req.body);
    res.json({ recibido: true });
    try { await setter.handleWebhook(evt); } catch (e) { console.error('Webhook:', e); }
  });

  const admin = express.Router();
  admin.use((req, res, next) => (igual(req.get('authorization')?.replace(/^Bearer /, ''), config.adminToken) ? next() : res.status(401).json({ error: 'no autorizado' })));

  // Chat de pruebas: habla con Sofía sin tocar GHL ni a ningún lead. Body: { sesion, texto, canal?, nombre? }
  admin.post('/probar', async (req, res) => {
    const { sesion = 'demo', texto, canal = 'whatsapp', nombre = null } = req.body || {};
    if (!texto) return res.status(400).json({ error: 'falta texto' });
    const ghl = new GhlCaptura();
    const prueba = new Setter({
      repo, ghl, avisar: async (t) => ghl.salida.push(`[aviso equipo] ${t}`), complete, live: true, sleep: async () => {},
      aimharder: { buscarSocioPorTelefono: async () => ({ esSocio: false }), prepararAlta: async () => ({ estado: 'simulada', detalle: 'chat de pruebas' }) },
    });
    const id = `prueba-${sesion}`;
    await prueba.onInbound({ conversationId: id, contactId: id, canal, texto, nombre, messageId: `${id}-${Date.now()}` });
    repo.updateConv(id, { respond_at: null });
    const r = await prueba.responder(id);
    res.json({ mensajes: r?.mensajes || [], fase: r?.fase, sede: r?.sede, efectos: ghl.salida });
  });

  admin.post('/probar/reiniciar', (req, res) => {
    const id = `prueba-${req.body?.sesion || 'demo'}`;
    repo.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
    repo.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  admin.get('/costes', (req, res) => res.json(repo.costes(Number(req.query.dias) || 7)));

  admin.post('/conversaciones/:id/reanudar', (req, res) => {
    repo.updateConv(req.params.id, { ai_paused: 0, derivado: 0, pause_reason: null });
    res.json({ ok: true });
  });

  app.use('/admin', admin);
  return app;
}
