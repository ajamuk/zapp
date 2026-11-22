// Alertas del sistema (como las «alertas operativas» de Zapp): algo no funciona y hay que mirarlo. Se guardan en la
// tabla `alertas`, una por problema (clave), se avisa por Telegram la primera vez y se resuelven solas cuando la
// comprobación vuelve a ir bien. El panel las enseña en Resumen.
import fs from 'node:fs';
import { config } from './config.js';

export function registrar(db, { clave, tipo, titulo, detalle = '', nivel = 'error' }, { avisar } = {}) {
  const abierta = db.prepare('SELECT * FROM alertas WHERE clave = ? AND resuelta_at IS NULL').get(clave);
  if (abierta) {
    db.prepare("UPDATE alertas SET veces = veces + 1, ultima = datetime('now'), detalle = ? WHERE id = ?").run(String(detalle).slice(0, 1000), abierta.id);
    return { nueva: false, id: abierta.id };
  }
  const r = db.prepare('INSERT INTO alertas (clave, tipo, nivel, titulo, detalle) VALUES (?, ?, ?, ?, ?)').run(clave, tipo, nivel, titulo, String(detalle).slice(0, 1000));
  Promise.resolve(avisar?.(`⚠️ ZAPP · ${titulo}${detalle ? `\n${String(detalle).slice(0, 300)}` : ''}`)).catch(() => {});
  return { nueva: true, id: Number(r.lastInsertRowid) };
}

/** La comprobación vuelve a ir bien: se cierra sola. */
export function resolver(db, clave, motivo = 'resuelta sola') {
  return db.prepare("UPDATE alertas SET resuelta_at = datetime('now'), resolucion = ? WHERE clave = ? AND resuelta_at IS NULL").run(motivo, clave).changes > 0;
}

export const abiertas = (db) => db.prepare('SELECT * FROM alertas WHERE resuelta_at IS NULL ORDER BY nivel = \'error\' DESC, ultima DESC').all();
export const recientes = (db, dias = 7) => db.prepare("SELECT * FROM alertas WHERE resuelta_at IS NOT NULL AND datetime(resuelta_at) >= datetime('now', ?) ORDER BY resuelta_at DESC LIMIT 50").all(`-${dias} days`);
export const cerrarAMano = (db, id) => db.prepare("UPDATE alertas SET resuelta_at = datetime('now'), resolucion = 'marcada como resuelta en el panel' WHERE id = ? AND resuelta_at IS NULL").run(id).changes > 0;

const jwtExp = (t) => { try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString()).exp * 1000; } catch { return null; } };

/**
 * Comprobaciones periódicas. Cada una registra o resuelve su alerta. `ghl` es el cliente real.
 * Devuelve la lista de comprobaciones con su resultado (para el panel y los tests).
 */
export async function vigilar(db, { ghl, avisar, ahora = new Date(), tokenStore = config.aimharder.tokenStore, entradaGhl = config.ghlWebhookEnabled, disco = config.dbPath } = {}) {
  const res = [];
  const comprobar = async (clave, tipo, titulo, fn, nivel = 'error') => {
    let problema = null;
    try { problema = await fn(); } catch (e) { problema = e.message; }
    if (problema) registrar(db, { clave, tipo, titulo, detalle: problema, nivel }, { avisar }); else resolver(db, clave);
    res.push({ clave, ok: !problema, problema });
  };
  const n = (sql, ...p) => db.prepare(sql).get(...p)?.n ?? 0;

  await comprobar('ghl-token', 'ghl', 'GoHighLevel no responde o el token no vale', async () => {
    if (!ghl?.req) return null;
    await ghl.req('GET', `/locations/${config.ghl.locationId}/tags`);
    return null;
  });

  await comprobar('aimharder-tokens', 'aimharder', 'Los tokens de AimHarder están caducados o a punto', async () => {
    if (!tokenStore) return null;
    const d = JSON.parse(fs.readFileSync(tokenStore, 'utf8'));
    const mal = Object.entries(d.centers || {}).filter(([, c]) => { const e = jwtExp(c.accessToken); return !e || e - ahora.getTime() < 2 * 3600e3; }).map(([k]) => k);
    return mal.length ? `Sedes afectadas: ${mal.join(', ')}. Los renueva un cron cada hora (aimharder-refresh-tokens.py): revisar que funciona.` : null;
  });

  await comprobar('ia-errores', 'ia', 'La IA está fallando', async () => {
    const e = n("SELECT count(*) n FROM ai_runs WHERE error IS NOT NULL AND datetime(created_at) >= datetime('now', '-30 minutes')");
    const ultimo = db.prepare('SELECT error FROM ai_runs WHERE error IS NOT NULL ORDER BY id DESC LIMIT 1').get()?.error;
    return e >= 2 ? `${e} errores en los últimos 30 minutos. Último: ${ultimo}` : null;
  });

  await comprobar('cola-atascada', 'cola', 'Hay respuestas de Sofía atascadas', async () => {
    const c = n(`SELECT count(*) n FROM conversations WHERE respond_at IS NOT NULL AND respond_at < ? AND ai_paused = 0 AND derivado = 0`, new Date(ahora.getTime() - 15 * 60000).toISOString());
    return c ? `${c} chats llevan más de 15 minutos esperando respuesta.` : null;
  });

  await comprobar('seguimientos-error', 'seguimientos', 'Hay seguimientos que fallan al enviarse', async () => {
    const e = n("SELECT count(*) n FROM scheduled WHERE estado = 'error' AND datetime(due_at) >= datetime('now', '-6 hours')");
    const d = db.prepare("SELECT detalle FROM scheduled WHERE estado = 'error' ORDER BY id DESC LIMIT 1").get()?.detalle;
    return e ? `${e} en las últimas 6 horas. Último: ${d}` : null;
  }, 'aviso');

  await comprobar('transcripcion', 'medios', 'No se pueden escuchar las notas de voz', async () => {
    const e = n("SELECT count(*) n FROM messages WHERE adjunto = 'audio' AND media_error IS NOT NULL AND datetime(created_at) >= datetime('now', '-6 hours')");
    return e >= 2 ? `${e} audios sin transcribir en las últimas 6 horas.` : null;
  }, 'aviso');

  await comprobar('sin-mensajes', 'ghl', 'No llegan mensajes de GHL', async () => {
    if (!entradaGhl) return null;
    const h = Number(new Intl.DateTimeFormat('es-ES', { hour: 'numeric', hourCycle: 'h23', timeZone: config.tz }).format(ahora));
    if (h < 11 || h > 21) return null; // solo de día, cuando siempre escribe alguien
    const ultimo = db.prepare("SELECT max(created_at) t FROM messages WHERE autor = 'lead'").get()?.t;
    return !ultimo || ahora - new Date(ultimo) > 6 * 3600e3 ? `El último mensaje de un lead llegó ${ultimo ? `el ${new Date(ultimo).toLocaleString('es-ES', { timeZone: config.tz })}` : 'nunca'}. Revisar el webhook o el workflow de GHL.` : null;
  });

  await comprobar('disco', 'servidor', 'Queda poco espacio en el disco', async () => {
    if (!disco || disco === ':memory:' || !fs.statfsSync) return null;
    const s = fs.statfsSync(disco.replace(/[^/]+$/, '') || '.');
    const libre = (s.bavail * s.bsize) / 1e9;
    return libre < 3 ? `Quedan ${libre.toFixed(1)} GB libres.` : null;
  }, 'aviso');

  return res;
}
