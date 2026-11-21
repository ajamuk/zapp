// Robustez del servicio: recuperación al arrancar, bucles que no se solapan ni se caen, y apagado ordenado.

/**
 * Al arrancar, deja en un estado coherente lo que un reinicio pudo cortar a medias:
 *  - chats que Sofía estaba contestando → vuelven a la cola (contesta en cuanto arranque);
 *  - seguimientos que se estaban enviando → error (mejor perder uno que mandarlo dos veces; sale en las alertas);
 *  - reportes a medio analizar → error, con botón «Volver a analizar» en el panel.
 */
export function recuperar(db, ahora = new Date()) {
  const chats = db.prepare(`UPDATE conversations SET respond_at = ?, respondiendo_desde = NULL
    WHERE respondiendo_desde IS NOT NULL AND ai_paused = 0 AND derivado = 0`).run(ahora.toISOString()).changes;
  db.prepare('UPDATE conversations SET respondiendo_desde = NULL WHERE respondiendo_desde IS NOT NULL').run();
  const seguimientos = db.prepare("UPDATE scheduled SET estado = 'error', detalle = 'interrumpido por un reinicio del servicio' WHERE estado = 'enviando'").run().changes;
  const reportes = db.prepare("UPDATE reportes SET estado = 'error', error = 'El análisis se interrumpió por un reinicio del servicio. Pulsa «Volver a analizar».' WHERE estado = 'analizando'").run().changes;
  return { chats, seguimientos, reportes };
}

/**
 * Bucle periódico que nunca se solapa consigo mismo ni tumba el proceso: si una vuelta sigue en marcha, la
 * siguiente se salta; los errores se registran. Guarda la hora de la última vuelta terminada (para /health).
 * Devuelve { parar(), estado() }.
 */
export function bucle(nombre, cadaMs, fn, { alArrancarMs = null, registro = {} } = {}) {
  let enMarcha = false; let parado = false;
  const info = (registro[nombre] = { cadaMs, ultima: null, ultimoError: null, fallosSeguidos: 0 });
  const vuelta = async () => {
    if (enMarcha || parado) return;
    enMarcha = true;
    try { await fn(); info.ultima = Date.now(); info.fallosSeguidos = 0; info.ultimoError = null; }
    catch (e) { info.fallosSeguidos++; info.ultimoError = e.message; console.error(`[${nombre}]`, e.message); }
    finally { enMarcha = false; }
  };
  const timers = [setInterval(vuelta, cadaMs)];
  if (alArrancarMs != null) timers.push(setTimeout(vuelta, alArrancarMs));
  return { parar() { parado = true; timers.forEach((t) => { clearInterval(t); clearTimeout(t); }); }, estado: () => ({ ...info, enMarcha }), vuelta };
}

/** Bucles que llevan parados más del triple de su intervalo (mínimo 2 minutos): algo va mal. */
export function buclesParados(registro, ahora = Date.now(), desdeArranque = Infinity) {
  return Object.entries(registro).filter(([, b]) => {
    const limite = Math.max(2 * 60000, b.cadaMs * 3);
    return b.ultima ? ahora - b.ultima > limite : desdeArranque > limite + b.cadaMs;
  }).map(([n]) => n);
}

/**
 * Apagado ordenado (SIGTERM de systemd al reiniciar o desplegar): deja de aceptar trabajo, espera hasta 25 s a
 * que terminen las respuestas en curso, vuelca la base a disco y sale. Lo que no termine se recupera al arrancar.
 */
export function apagadoOrdenado({ bucles, servidor, setter, dbs, esperaMs = 25000 }) {
  let saliendo = false;
  const salir = async (senal) => {
    if (saliendo) return; saliendo = true;
    console.log(`${senal}: cerrando con orden…`);
    bucles.forEach((b) => b.parar());
    servidor?.close?.();
    const fin = Date.now() + esperaMs;
    while (setter?.enCurso?.size && Date.now() < fin) await new Promise((ok) => setTimeout(ok, 250));
    for (const db of dbs) { try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); } catch (e) { console.error('Cierre de la base:', e.message); } }
    process.exit(0);
  };
  process.on('SIGTERM', () => salir('SIGTERM'));
  process.on('SIGINT', () => salir('SIGINT'));
}
