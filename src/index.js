import { config } from './config.js';
import { openDb, repo as crearRepo, copiaSeguridad } from './db.js';
import { Ghl } from './ghl.js';
import { buscarSocioPorTelefono, fichaEnSede, prepararAltaNavegador, sincronizarSocios, sincronizarSiHaceFalta } from './aimharder/index.js';
import { avisarEquipo } from './notify.js';
import { Setter } from './setter.js';
import { aplicarAjustes } from './ajustes.js';
import { procesarSeguimientos, programarPorEtiqueta, cancelarPorEtiqueta } from './followups.js';
import { crearApp } from './server.js';
import { Etiquetador } from './etiquetas.js';
import { vigilar, registrar as registrarAlerta, resolver as resolverAlerta } from './alertas.js';
import { recuperar, bucle, buclesParados, apagadoOrdenado } from './arranque.js';
import { rutaPruebas } from './probar.js';

// Un fallo suelto nunca debe dejar el servicio a medias: las promesas sin capturar se registran y se sigue;
// un error no capturado de verdad cierra el proceso y systemd lo vuelve a levantar en 5 s.
process.on('unhandledRejection', (e) => console.error('[promesa sin capturar]', e?.stack || e));
process.on('uncaughtException', (e) => { console.error('[error no capturado]', e?.stack || e); process.exit(1); });

const arrancado = Date.now();
const repo = crearRepo(openDb(config.dbPath));
const recuperado = recuperar(repo.db);
if (recuperado.chats || recuperado.seguimientos || recuperado.reportes) console.log('Recuperado tras el reinicio:', JSON.stringify(recuperado));
aplicarAjustes(repo); // horario y retrasos guardados desde el panel
const aimharder = { buscarSocioPorTelefono: async (tel) => buscarSocioPorTelefono(repo, tel), prepararAlta: prepararAltaNavegador,
  fichaEnSede: async (tel, sede) => fichaEnSede(repo, tel, sede) };

const ghl = new Ghl();
const etiquetas = new Etiquetador({
  repo, ghl, avisar: avisarEquipo,
  // Seguimientos que dispara una etiqueta: se programan al ponerla y se cancelan al quitarla
  alPoner: (convId, etiquetaId) => programarPorEtiqueta(repo, repo.db, convId, etiquetaId),
  alQuitar: (convId, etiquetaId) => cancelarPorEtiqueta(repo, repo.db, convId, etiquetaId),
});
const setter = new Setter({ repo, ghl, aimharder, avisar: avisarEquipo, etiquetas });

// ---------- Bucles (ninguno se solapa consigo mismo; los errores se registran y no paran el servicio) ----------
const registro = {};
const bucles = [];
const cada = (nombre, ms, fn, alArrancarMs = null) => bucles.push(bucle(nombre, ms, fn, { alArrancarMs, registro }));

/** Estado para /health: bucles parados y trabajo en curso. */
const salud = () => {
  const parados = buclesParados(registro, Date.now(), Date.now() - arrancado);
  return { ok: parados.length === 0, bucles_parados: parados, respondiendo: setter.enCurso?.size || 0, arrancado: new Date(arrancado).toISOString() };
};

const app = crearApp({ setter, repo, etiquetas, ghl, salud });
const servidor = app.listen(config.port, '127.0.0.1', () => {
  console.log(`Setter en http://127.0.0.1:${config.port} · modo ${config.mode} · modelo ${config.ai.model}`);
  if (config.mode !== 'live') console.log('Modo prueba: la IA NO envía mensajes; deja borradores como notas en GHL.');
});
servidor.on('error', (e) => { console.error('No se puede abrir el puerto:', e.message); process.exit(1); });

// Índice de socios desde AimHarder: cada 4 horas. Al arrancar solo se descargan las sedes con datos de más
// de 4 horas, para que los reinicios no gasten el límite de peticiones (compartido con otras apps).
const avisoSync = (e) => registrarAlerta(repo.db, { clave: 'aimharder-socios', tipo: 'aimharder', titulo: 'No se pueden sincronizar los socios de AimHarder', detalle: e.message, nivel: /429/.test(e.message) ? 'aviso' : 'error' }, { avisar: avisarEquipo });
sincronizarSiHaceFalta(repo)
  .then((r) => { if (r) resolverAlerta(repo.db, 'aimharder-socios'); console.log(r ? `Socios sincronizados: ${JSON.stringify(r)}` : 'Socios al día (menos de 4 h): no se descargan al arrancar.'); })
  .catch(avisoSync);
cada('socios', 4 * 3600 * 1000, () => sincronizarSocios(repo).then((r) => { resolverAlerta(repo.db, 'aimharder-socios'); console.log('Socios sincronizados:', JSON.stringify(r)); }).catch(avisoSync));

if (config.ghlWebhookEnabled) {
  // Respuestas pendientes cada 5 s (hasta 4 chats a la vez) y seguimientos cada minuto
  cada('respuestas', 5000, () => setter.tick(), 1000);
  cada('seguimientos', 60000, () => procesarSeguimientos(setter));
  // Etiquetas puestas o quitadas en GHL (también reintenta las que no llegaron a subir)
  cada('etiquetas-ghl', 15 * 60000, async () => { const r = await etiquetas.sincronizarDesdeGhl(); if (r.puestas + r.quitadas + r.subidas) console.log('Etiquetas GHL:', JSON.stringify(r)); }, 60000);
  // Etiquetas con regla de inactividad («si no responde en X h»)
  cada('etiquetas-inactividad', 5 * 60000, () => etiquetas.revisarInactividad());
}

// Alertas del sistema: comprobaciones cada 10 minutos (la primera al minuto de arrancar)
cada('alertas', 10 * 60000, async () => {
  await vigilar(repo.db, { ghl, avisar: avisarEquipo });
  const parados = buclesParados(registro, Date.now(), Date.now() - arrancado).filter((n) => n !== 'alertas');
  if (parados.length) registrarAlerta(repo.db, { clave: 'bucle-parado', tipo: 'servidor', titulo: 'Una tarea interna de Sofía se ha parado', detalle: `Tareas sin terminar una vuelta: ${parados.join(', ')}. Si sigue así, reiniciar el servicio.` }, { avisar: avisarEquipo });
  else resolverAlerta(repo.db, 'bucle-parado');
}, 60000);

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
}, 5 * 60000);

apagadoOrdenado({ bucles, servidor, setter, dbs: [repo.db] });
