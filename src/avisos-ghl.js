// Avisos de GHL (POST /webhooks/ghl) guardados en la base (tabla ghl_avisos) ANTES de contestar 200.
//
// Antes se contestaba 200 primero y los reintentos («GHL aún no devuelve la conversación del contacto nuevo», «GHL
// aún no lista el mensaje») eran temporizadores en memoria: un reinicio del servicio, que llega con cada despliegue,
// perdía el aviso y con él el mensaje del lead. Ahora:
//  - el aviso se guarda y solo entonces se contesta 200 (si no se puede guardar, 500: no se da por recibido);
//  - se procesa enseguida y, si hay que esperar a GHL, queda pendiente con la hora del siguiente intento;
//  - un bucle (index.js) procesa los que tocan, y al arrancar lo que estaba «procesando» vuelve a la cola (arranque.js).
// Volver a procesar un aviso no duplica sus mensajes: se registran por su id de GHL (Setter.sincronizar). Solo uno sin
// id que GHL aún no listaba (entra «tal como vino») podría quedar dos veces si el corte llega justo tras registrarlo.
import { enSegundoPlano } from './arranque.js';

/**
 * Esperas entre reintentos (ms), según lo que devuelve Setter.handleWebhook en `reintento`:
 *  - conversacion: contacto recién creado; el aviso del workflow llega antes de que GHL devuelva su conversación.
 *    Sin esto el primer mensaje del lead se perdía (no entraba en el panel ni contestaba nadie).
 *  - aislamiento: GHL aún no lista el mensaje del aviso, y sin él no hay prueba de a qué número se escribió.
 *  - repaso: el texto coincidía con un mensaje que ya estaba; por si era otro igual que GHL aún no listaba.
 */
export const ESPERAS = { conversacion: [5000, 15000, 45000, 120000], aislamiento: [8000, 32000], repaso: [8000] }; // aislamiento: a los 8 y a los 40 s
const MAX_EDAD_MS = 24 * 3600e3; // un aviso pendiente más antiguo ya no se procesa (fuera de la ventana de 24 h de WhatsApp)
const PODA_MS = 3 * 24 * 3600e3; // los terminados se borran a los 3 días (llevan el texto del mensaje)

/**
 * Cola de avisos de GHL. `reloj` da la hora de los reintentos (ms); la hora del negocio sigue siendo `setter.now()`.
 * Devuelve { guardar(evt) → id, procesar(id) → resultado de handleWebhook, pendientes() → { lanzados, terminado } }.
 */
export function crearAvisos({ repo, setter, esperas = ESPERAS, reloj = () => Date.now(), log = console }) {
  let ultimaPoda = 0;

  /** Procesa un aviso ya tomado (estado «procesando») y deja anotado en qué queda. */
  async function ejecutar(f) {
    let evt;
    try { evt = JSON.parse(f.evento); } catch { repo.cerrarAvisoGhl(f.id, 'error', 'aviso ilegible'); return { r: null }; }
    if (reloj() - f.creado_ms > MAX_EDAD_MS) {
      repo.cerrarAvisoGhl(f.id, 'descartado', 'caducado: más de 24 h sin procesar');
      log.warn?.(`[avisos-ghl] aviso ${f.id} caducado sin procesar`);
      return { r: null };
    }
    let r;
    try {
      r = f.motivo === 'repaso'
        ? await setter.enSerie(evt.conversationId, () => setter.sincronizar(evt.conversationId))
        : await setter.handleWebhook(evt);
    } catch (e) { repo.cerrarAvisoGhl(f.id, 'error', String(e.message).slice(0, 300)); throw e; }
    if (f.motivo === 'conversacion' && evt.conversationId) log.log?.(`[webhook] ${evt.contactId}: conversación ${evt.conversationId} encontrada al repasar; se procesa el aviso`);
    const motivo = f.motivo === 'repaso' ? null : (r?.reintento || null);
    if (!motivo) { repo.cerrarAvisoGhl(f.id, 'hecho', r?.ignorado || null); return { r }; }
    const lista = esperas[motivo] || [];
    const n = motivo === f.motivo ? f.intentos : 0;
    if (n >= lista.length) {
      repo.cerrarAvisoGhl(f.id, 'descartado', r?.ignorado || motivo);
      if (motivo === 'conversacion') log.warn?.(`[webhook] ${evt.contactId}: GHL sigue sin devolver la conversación del contacto; aviso sin procesar`);
      return { r };
    }
    let programado = { motivo, intentos: n + 1, proximo_ms: reloj() + lista[n] };
    // Varios avisos seguidos de un contacto nuevo: comparten los reintentos (una sola búsqueda en GHL cada vez)
    const otro = motivo === 'conversacion' && evt.contactId ? repo.avisoGhlEsperandoConversacion(evt.contactId, f.id) : null;
    if (otro) programado = { motivo, intentos: otro.intentos, proximo_ms: otro.proximo_ms };
    // `handleWebhook` completa el aviso (conversación encontrada, hora de llegada): se guarda tal cual para el reintento
    repo.reprogramarAvisoGhl(f.id, { ...programado, evento: JSON.stringify(evt) });
    return { r, programado };
  }

  return {
    /** Guarda el aviso (antes de contestar 200). Lanza si la base no responde. */
    guardar(evt) {
      evt.recibido ??= setter.now().toISOString(); // cuándo llegó, aunque se procese más tarde
      return repo.guardarAvisoGhl({ evento: JSON.stringify(evt), contact_id: evt.contactId || null, ahora: reloj() });
    },

    /** Procesa ya un aviso recién guardado. Devuelve lo que devolvió `handleWebhook` (null si ya lo tenía otro). */
    procesar(id) {
      const f = repo.tomarAvisoGhl(id); // sin esperas antes: el bucle no puede cogerlo a la vez
      if (!f) return Promise.resolve(null);
      return enSegundoPlano(ejecutar(f)).then((x) => x.r);
    },

    /**
     * Lanza los avisos cuyo reintento toca (y los recuperados tras un reinicio) sin esperar a que terminen: un chat
     * ocupado (un audio que se transcribe) no retrasa a los demás. Los del mismo contacto van en orden, uno detrás de
     * otro; si GHL aún no devuelve su conversación, se pregunta una vez y los demás esperan con el primero.
     */
    pendientes() {
      const ahora = reloj();
      if (ahora - ultimaPoda > 3600e3) { ultimaPoda = ahora; repo.podarAvisosGhl(ahora - PODA_MS); }
      const filas = repo.avisosGhlPendientes(ahora).map((f) => repo.tomarAvisoGhl(f.id)).filter(Boolean);
      const grupos = new Map();
      for (const f of filas) { const k = f.contact_id || `#${f.id}`; if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(f); }
      const tareas = [...grupos.values()].map((lista) => enSegundoPlano((async () => {
        let espera = null;
        for (const f of lista) {
          if (espera && f.motivo === 'conversacion') { repo.reprogramarAvisoGhl(f.id, espera); continue; }
          const x = await ejecutar(f).catch((e) => { log.error?.('[avisos-ghl]', e); return null; });
          if (x?.programado?.motivo === 'conversacion') espera = x.programado;
        }
      })()));
      return { lanzados: filas.length, terminado: Promise.all(tareas) };
    },
  };
}
