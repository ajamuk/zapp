import path from 'node:path';
import { config, clavesDebiles } from './config.js';
import { openDb, repo as crearRepo, copiaSeguridad } from './db.js';
import { Ghl } from './ghl.js';
import { buscarSocioPorTelefono, fichaEnSede, prepararAltaNavegador, sincronizarSocios, sincronizarSiHaceFalta, clientesApi } from './aimharder/index.js';
import { reservarEnAimHarder, resultadoAimHarder } from './clase-prueba.js';
import { sincronizarHorarios } from './horarios-sync.js';
import { subirCopias } from './copia-drive.js';
import { avisarEquipo } from './notify.js';
import { Setter } from './setter.js';
import { aplicarAjustes } from './ajustes.js';
import { procesarSeguimientos, programarPorEtiqueta, cancelarPorEtiqueta } from './followups.js';
import { crearApp } from './server.js';
import { Etiquetador } from './etiquetas.js';
import { vigilar, registrar as registrarAlerta, resolver as resolverAlerta } from './alertas.js';
import { recuperar, bucle, buclesParados, apagadoOrdenado } from './arranque.js';
import { rutaPruebas } from './probar.js';
import * as captacion from './captacion.js';

// Un fallo suelto nunca debe dejar el servicio a medias: las promesas sin capturar se registran y se sigue;
// un error no capturado de verdad cierra el proceso y systemd lo vuelve a levantar en 5 s.
process.on('unhandledRejection', (e) => console.error('[promesa sin capturar]', e?.stack || e));
process.on('uncaughtException', (e) => { console.error('[error no capturado]', e?.stack || e); process.exit(1); });

const arrancado = Date.now();
const repo = crearRepo(openDb(config.dbPath));
const recuperado = recuperar(repo.db);
if (recuperado.chats || recuperado.seguimientos || recuperado.reportes) console.log('Recuperado tras el reinicio:', JSON.stringify(recuperado));
aplicarAjustes(repo); // horario y retrasos guardados desde el panel
let apisAimHarder;
const apiSede = (sede) => (apisAimHarder ??= clientesApi())[sede];
const aimharder = { buscarSocioPorTelefono: async (tel) => buscarSocioPorTelefono(repo, tel), prepararAlta: prepararAltaNavegador,
  fichaEnSede: async (tel, sede) => fichaEnSede(repo, tel, sede),
  // Clase de prueba de Parla: reserva como invitado, anulación al cambiarla y resultado después de la clase
  reservarPrueba: (datos, opciones) => reservarEnAimHarder(apiSede(datos.sede), datos, opciones),
  cancelarPrueba: async (p) => { await apiSede(p.sede).cancelarReserva({ booking_id: Number(p.booking_id), booking_date: p.fecha_hora.slice(0, 10), reason: 'El lead la cambió a otra hora' }); return true; },
  resultadoPrueba: (p) => resultadoAimHarder(apiSede(p.sede), p.booking_id) };

/**
 * Aviso al equipo. Si no llega por Telegram (sin configurar, bot fuera del chat…), no se pierde: queda como alerta
 * en el panel con los últimos avisos sin entregar.
 */
const avisar = async (texto, opciones = {}) => {
  const ok = await avisarEquipo(texto, opciones);
  if (!ok) {
    try {
      const clave = 'avisos-sin-entregar';
      const antes = repo.db.prepare('SELECT detalle FROM alertas WHERE clave = ? AND resuelta_at IS NULL').get(clave)?.detalle || '';
      const hora = new Date().toLocaleString('es-ES', { timeZone: config.tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      registrarAlerta(repo.db, { clave, tipo: 'servidor', titulo: 'Hay avisos al equipo que no han llegado por Telegram', detalle: `${hora} · ${String(texto).slice(0, 300)}\n${antes}`, nivel: 'aviso' });
    } catch (e) { console.error('Aviso sin entregar:', e.message); }
  }
  return ok;
};

const ghl = new Ghl();
const etiquetas = new Etiquetador({
  repo, ghl, avisar,
  // Seguimientos que dispara una etiqueta: se programan al ponerla y se cancelan al quitarla
  alPoner: (convId, etiquetaId) => programarPorEtiqueta(repo, repo.db, convId, etiquetaId),
  alQuitar: (convId, etiquetaId) => cancelarPorEtiqueta(repo, repo.db, convId, etiquetaId),
});
const setter = new Setter({ repo, ghl, aimharder, avisar, etiquetas });

// ---------- Bucles (ninguno se solapa consigo mismo; los errores se registran y no paran el servicio) ----------
const registro = {};
const bucles = [];
const cada = (nombre, ms, fn, alArrancarMs = null) => bucles.push(bucle(nombre, ms, fn, { alArrancarMs, registro }));

/** Estado para /health: bucles parados y trabajo en curso. */
const salud = () => {
  const parados = buclesParados(registro, Date.now(), Date.now() - arrancado);
  // La vuelta de «respuestas» no espera a los chats, así que su bucle siempre parece vivo: se mira la cola de verdad.
  // Una respuesta que tocaba hace más de 5 minutos y que nadie está atendiendo es que algo se ha atascado.
  const atrasadas = repo.db.prepare('SELECT id FROM conversations WHERE respond_at IS NOT NULL AND respond_at < ? AND ai_paused = 0 AND derivado = 0')
    .all(new Date(Date.now() - 5 * 60000).toISOString()).filter((c) => !setter.enCurso?.has(c.id)).length;
  return { ok: parados.length === 0 && atrasadas === 0, bucles_parados: parados, respuestas_atrasadas: atrasadas, respondiendo: setter.enCurso?.size || 0, arrancado: new Date(arrancado).toISOString() };
};

const app = crearApp({ setter, repo, etiquetas, ghl, salud });
const servidor = app.listen(config.port, '127.0.0.1', () => {
  console.log(`Setter en http://127.0.0.1:${config.port} · modo ${config.mode} · modelo ${config.ai.model}`);
  if (config.mode !== 'live') console.log('Modo prueba: la IA NO envía mensajes; deja borradores como notas en GHL.');
});
// Claves que faltan o son cortas: se avisa en el registro y en las alertas del panel (sin enseñar la clave)
const debiles = clavesDebiles();
if (debiles.length) { debiles.forEach((a) => console.warn('[seguridad]', a)); registrarAlerta(repo.db, { clave: 'claves-debiles', tipo: 'servidor', titulo: 'Hay claves del servicio que faltan o son demasiado cortas', detalle: debiles.join('\n'), nivel: 'aviso' }); } else resolverAlerta(repo.db, 'claves-debiles');
servidor.on('error', (e) => { console.error('No se puede abrir el puerto:', e.message); process.exit(1); });

// Índice de socios desde AimHarder: cada 4 horas. Al arrancar solo se descargan las sedes con datos de más
// de 4 horas, para que los reinicios no gasten el límite de peticiones (compartido con otras apps).
const avisoSync = (e) => registrarAlerta(repo.db, { clave: 'aimharder-socios', tipo: 'aimharder', titulo: 'No se pueden sincronizar los socios de AimHarder', detalle: e.message, nivel: /429/.test(e.message) ? 'aviso' : 'error' }, { avisar: avisarEquipo });
sincronizarSiHaceFalta(repo)
  .then((r) => { if (r) resolverAlerta(repo.db, 'aimharder-socios'); console.log(r ? `Socios sincronizados: ${JSON.stringify(r)}` : 'Socios al día (menos de 4 h): no se descargan al arrancar.'); })
  .catch(avisoSync);
cada('socios', 4 * 3600 * 1000, () => sincronizarSocios(repo).then((r) => { resolverAlerta(repo.db, 'aimharder-socios'); console.log('Socios sincronizados:', JSON.stringify(r)); }).catch(avisoSync));

if (config.ghlWebhookEnabled) {
  // Respuestas pendientes cada 2 s (hasta 4 chats a la vez) y seguimientos cada minuto. La vuelta no espera a que
  // los chats terminen (cada respuesta tarda lo que tarda «escribir» sus burbujas): si esperase, un chat que toca
  // mientras Sofía escribe en otro no empezaría hasta que acabase ese. `tick` ya cuenta los que hay en marcha.
  cada('respuestas', 2000, () => { setter.tick().catch((e) => console.error('[respuestas]', e.message)); }, 1000);
  cada('seguimientos', 60000, () => procesarSeguimientos(setter));
  // Etiquetas puestas o quitadas en GHL (también reintenta las que no llegaron a subir)
  cada('etiquetas-ghl', 15 * 60000, async () => { const r = await etiquetas.sincronizarDesdeGhl(); if (r.puestas + r.quitadas + r.subidas) console.log('Etiquetas GHL:', JSON.stringify(r)); }, 60000);
  // Etiquetas con regla de inactividad («si no responde en X h»)
  cada('etiquetas-inactividad', 5 * 60000, () => etiquetas.revisarInactividad());
}

// Captación por nivel de conciencia (apagada salvo CAPTACION_ENABLED=true): diagnostica los chats fríos y prepara
// borradores que solo se ven en el panel. No envía nada ni escribe en GHL, esté el servicio en prueba o en real.
if (config.captacion.activa) {
  cada('captacion', 30 * 60000, async () => {
    const r = await captacion.ciclo({
      repo, ia: config.captacion.ia && Boolean(config.ai.apiKey),
      redactar: config.captacion.redactarIA && config.ai.apiKey ? (convId, contexto) => setter.redactar(convId, contexto, { modelo: config.ai.modeloSeguimientos }) : null,
    });
    if (r.diagnosticados + r.borradores + r.paradas + r.respuestas) console.log('Captación (modo prueba):', JSON.stringify(r));
  }, 2 * 60000);
}

// Horarios de clases desde AimHarder: una vez al día (la primera a los 3 minutos de arrancar). Si cambian, Sofía
// usa los nuevos al momento y queda apuntado; si AimHarder falla, se queda con los que tenía y sale una alerta.
cada('horarios', 24 * 3600 * 1000, async () => {
  const r = await sincronizarHorarios(clientesApi());
  if (r.cambios.length) { console.log('Horarios actualizados desde AimHarder:\n' + r.cambios.join('\n')); registrarAlerta(repo.db, { clave: 'horarios-cambio', tipo: 'aimharder', titulo: `El horario de clases ha cambiado en AimHarder (${r.cambios.length} cambios); Sofía ya usa el nuevo`, detalle: r.cambios.slice(0, 30).join('\n'), nivel: 'info' }); }
  if (r.fallos.length) registrarAlerta(repo.db, { clave: 'horarios-sync', tipo: 'aimharder', titulo: 'No se pueden comprobar los horarios en AimHarder', detalle: r.fallos.join('\n'), nivel: 'aviso' });
  else resolverAlerta(repo.db, 'horarios-sync');
}, 3 * 60000);

// Alertas del sistema: comprobaciones cada 10 minutos (la primera al minuto de arrancar)
cada('alertas', 10 * 60000, async () => {
  await vigilar(repo.db, { ghl, avisar: avisarEquipo });
  const parados = buclesParados(registro, Date.now(), Date.now() - arrancado).filter((n) => n !== 'alertas');
  if (parados.length) registrarAlerta(repo.db, { clave: 'bucle-parado', tipo: 'servidor', titulo: 'Una tarea interna de Sofía se ha parado', detalle: `Tareas sin terminar una vuelta: ${parados.join(', ')}. Si sigue así, reiniciar el servicio.` }, { avisar: avisarEquipo });
  else resolverAlerta(repo.db, 'bucle-parado');
}, 60000);

let copiaDriveDia = null;
// Mantenimiento: copia de seguridad diaria (se guardan 14 días) y volcado del registro de escritura a disco
cada('mantenimiento', 3600 * 1000, async () => {
  repo.db.pragma('wal_checkpoint(PASSIVE)');
  const copia = await copiaSeguridad(repo.db, config.dbPath);
  if (copia) console.log('Copia de seguridad:', copia);
  // La base de Probar IA, si existe (abierta aparte, solo para copiarla)
  const rp = rutaPruebas();
  if (rp !== ':memory:' && (await import('node:fs')).existsSync(rp)) {
    const { default: Database } = await import('better-sqlite3');
    const p = new Database(rp, { fileMustExist: true });
    try { p.pragma('busy_timeout = 5000'); await copiaSeguridad(p, rp, { dias: 7 }); } finally { p.close(); }
  }
  // Copia fuera del servidor (Google Drive, cifrada): una vez al día; si falla, se reintenta en la vuelta siguiente
  const hoy = new Date().toISOString().slice(0, 10);
  if (copiaDriveDia !== hoy) {
    try {
      const r = await subirCopias(path.join(path.dirname(config.dbPath), 'backups'));
      if (r) { copiaDriveDia = hoy; console.log(`Copia en Drive al día: ${r.ficheros} ficheros, última ${r.ultima}`); resolverAlerta(repo.db, 'copia-drive'); }
    } catch (e) {
      console.error('Copia en Drive:', e.message);
      registrarAlerta(repo.db, { clave: 'copia-drive', tipo: 'servidor', titulo: 'La copia de seguridad no se ha podido subir a Google Drive', detalle: `${e.message}\nLa copia local del servidor sí se ha hecho. Se reintenta cada hora.`, nivel: 'aviso' });
    }
  }
}, 5 * 60000);

apagadoOrdenado({ bucles, servidor, setter, dbs: [repo.db] });
