import { config } from './config.js';

/** Aviso al equipo por Telegram, al chat de la sede (o al general). Nunca rompe el flujo si falla. */
export async function avisarEquipo(texto, { sede, fetchImpl = fetch } = {}) {
  const { token, chats } = config.telegram;
  const chat = (sede && chats[sede]) || chats.general;
  if (!token || !chat) { console.log('[aviso sin Telegram]', texto); return false; }
  try {
    const r = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: texto, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000), // un aviso nunca debe frenar a Sofía
    });
    if (!r.ok) console.error(`Telegram no aceptó el aviso (${r.status}):`, texto);
    return r.ok;
  } catch (e) {
    console.error('Telegram falló:', e.message);
    return false;
  }
}
