// Altas que el equipo termina a mano. Cuando el alta automática no se completa (fallida, ficha existente sin localizar,
// sin configurar…), Sofía la pasa al equipo y el chat queda con `alta_estado = 'pendiente'`. Antes nada se enteraba
// de que el equipo la terminaba: el chat seguía «pendiente», el intento «fallida» y en GHL la tarea «alta fallida».
// Aquí se mira el registro de socios (clientes-analytics): si hay un pago desde el día del alta, está hecha y pagada.
import { config } from './config.js';
import { buscadorDePagos } from './panel.js';
import { knowledge } from './knowledge.js';
import { chatPermitido, estadoAislamiento } from './aislamiento.js';

const TAREAS_ALTA = [knowledge.etiquetas.tareas.alta_fallida];

/**
 * Cierra las altas pasadas al equipo que ya están pagadas: nuevo intento «preparada» (el anterior queda como
 * superado en el panel), el chat pasa a `alta_estado = 'preparada'` (Sofía y los seguimientos lo tratan ya como
 * cliente) y se quita en GHL la tarea «alta fallida». Solo mira las de los últimos `dias`.
 * Devuelve las conversaciones cerradas.
 */
export async function cerrarAltasDelEquipo({ repo, ghl = null, socios = config.embudo.sociosDb, dias = 30, aislamiento = estadoAislamiento() } = {}) {
  const db = repo.db;
  const candidatas = db.prepare(`SELECT c.id, c.contact_id, c.telefono, c.aislado_num, c.aislado_bloqueo, a.datos, a.created_at
      FROM conversations c JOIN altas a ON a.id = (SELECT max(id) FROM altas WHERE conversation_id = c.id)
      WHERE c.alta_estado = 'pendiente' AND c.id NOT LIKE 'prueba-%' AND a.estado != 'rechazada'
        AND datetime(a.created_at) >= datetime('now', ?)`).all(`-${dias} days`);
  if (!candidatas.length) return [];
  const buscar = buscadorDePagos(socios);
  const cerradas = [];
  try {
    for (const c of candidatas) {
      const datos = JSON.parse(c.datos);
      const m = buscar(datos.sede, datos.email, datos.telefono || c.telefono);
      const dia = String(c.created_at).slice(0, 10);
      if (!m?.ultimo || m.ultimo < dia) continue; // sin pago desde el alta: sigue en manos del equipo
      repo.addAlta(c.id, datos, 'preparada', `Alta terminada por el equipo y pagada el ${m.ultimo} (registro de socios).`);
      repo.updateConv(c.id, { alta_estado: 'preparada' });
      // En GHL solo se toca un contacto de un chat propio (aislamiento)
      if (ghl?.removeTags && c.contact_id && chatPermitido(aislamiento, c)) {
        try { await ghl.removeTags(c.contact_id, TAREAS_ALTA); } catch (e) { console.error(`[altas] ${c.id}: no se pudo quitar la tarea en GHL:`, e.message); }
      }
      console.log(`[altas] ${c.id}: alta terminada por el equipo y pagada el ${m.ultimo}; queda como preparada`);
      cerradas.push(c.id);
    }
  } finally { buscar.cerrar(); }
  return cerradas;
}
