import path from 'node:path';
import { config, clavesDebiles, isLive } from './config.js';
import { openDb, repo as crearRepo, copiaSeguridad, podar } from './db.js';
import { carpetaMedios } from './medios.js';
import { Ghl } from './ghl.js';
import { buscarSocioPorTelefono, fichaEnSede, prepararAltaNavegador, sincronizarSocios, sincronizarSiHaceFalta, clientesApi, SEDES } from './aimharder/index.js';
import { manejadorWebhook, claveDeSede, crearProcesador } from './aimharder/webhook.js';
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
import { recuperar, bucle, buclesParados, apagadoOrdenado, enSegundoPlano } from './arranque.js';
import { crearAvisos } from './avisos-ghl.js';
import { rutaPruebas } from './probar.js';
import { procesadorFormularios } from './formularios.js';
import { estadoAislamiento, chatPermitido, cuarentena, enmascarar } from './aislamiento.js';

// Un fallo suelto nunca debe dejar el servicio a medias: las promesas sin capturar se registran y se sigue;
// un error no capturado de verdad cierra el proceso y systemd lo vuelve a levantar en 5 s.
process.on('unhandledRejection', (e) => console.error('[promesa sin capturar]', e?.stack || e));
process.on('uncaughtException', (e) => { console.error('[error no capturado]', e?.stack || e); process.exit(1); });

const arrancado = Date.now();
// En modo real no se arranca con claves que faltan o se adivinan: el webhook y el panel quedarían expuestos
if (isLive() && clavesDebiles().length) {
  clavesDebiles().forEach((a) => console.error('[seguridad]', a));
  console.error('MODE=live necesita WEBHOOK_SECRET y ADMIN_TOKEN aleatorios de al menos 24 caracteres. No se arranca.');
  process.exit(1);
}
// Sin token o subcuenta de GHL no se le pregunta nada a GHL (un negocio recién creado): solo panel y Probar IA
const ghlConfigurado = Boolean(config.ghl.token && config.ghl.locationId);
const repo = crearRepo(openDb(config.dbPath));
const recuperado = recuperar(repo.db);
if (recuperado.chats || recuperado.seguimientos || recuperado.reportes || recuperado.avisos || recuperado.solicitudes) console.log('Recuperado tras el reinicio:', JSON.stringify(recuperado));
/** Alerta de un primer WhatsApp de solicitud web que no se sabe si salió (envío fallido o cortado por un reinicio). */
const alertaSolicitudIncierta = (id) => registrarAlerta(repo.db, { clave: `formulario-incierto-${id}`, tipo: 'servidor',
  titulo: 'El primer WhatsApp de una solicitud web requiere comprobación',
  detalle: `Solicitud ${id}. Verificar el mensaje en Nexor antes de reintentar.`, nivel: 'aviso' });
for (const id of recuperado.solicitudes || []) alertaSolicitudIncierta(id);
aplicarAjustes(repo); // horario y retrasos guardados desde el panel
// Aislamiento en un número de WhatsApp propio: si está configurado, lo que hubiera en cola de otros chats no sale
const aislamiento = estadoAislamiento();
if (aislamiento.modo !== 'apagado') {
  const q = cuarentena(repo.db, aislamiento);
  console.log(aislamiento.modo === 'activo'
    ? `Aislamiento activo: solo WhatsApp al número ${enmascarar(aislamiento.numero)}${aislamiento.instagram ? ` e Instagram de la página …${aislamiento.instagram.slice(-4)}` : ''} de la subcuenta ${aislamiento.locationId}. ${aislamiento.adoptar ? 'Los chats anteriores se adoptan si GHL confirma que son de este número. ' : ''}Plantillas: ${aislamiento.plantillas ? 'permitidas' : 'bloqueadas'}. En cuarentena: ${q.respuestas} respuestas y ${q.seguimientos} seguimientos de otros chats.`
    : `[aislamiento] MAL CONFIGURADO (${aislamiento.motivos.join('; ')}): no entra ni sale ningún mensaje hasta arreglarlo.`);
}
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

const ghl = new Ghl({ aislamiento });
const etiquetas = new Etiquetador({
  repo, ghl, avisar, permitido: (conv) => chatPermitido(aislamiento, conv),
  // Seguimientos que dispara una etiqueta: se programan al ponerla y se cancelan al quitarla
  alPoner: (convId, etiquetaId) => programarPorEtiqueta(repo, repo.db, convId, etiquetaId),
  alQuitar: (convId, etiquetaId) => cancelarPorEtiqueta(repo, repo.db, convId, etiquetaId),
});
const setter = new Setter({ repo, ghl, aimharder, avisar, etiquetas, aislamiento });
// Avisos de GHL: se guardan antes de contestar 200 y sus reintentos van en la base (sobreviven a un reinicio)
const avisosGhl = crearAvisos({ repo, setter });

// ---------- Bucles (ninguno se solapa consigo mismo; los errores se registran y no paran el servicio) ----------
const registro = {};
const bucles = [];
const cada = (nombre, ms, fn, alArrancarMs = null) => bucles.push(bucle(nombre, ms, fn, { alArrancarMs, registro }));

/** Estado para /health: bucles parados y trabajo en curso. */
const salud = () => {
  const parados = buclesParados(registro, Date.now(), Date.now() - arrancado);
  // La vuelta de «respuestas» no espera a los chats, así que su bucle siempre parece vivo: se mira la cola de verdad.
  // Una respuesta que tocaba hace más de 5 minutos y que nadie está atendiendo es que algo se ha atascado.
  // Solo cuenta si el bucle de respuestas está en marcha, y no en los 10 primeros minutos: tras un corte, la cola
  // pendiente se va atendiendo de 4 en 4 y un despliegue no debe darla por caída (ni volver atrás) mientras tanto.
  const mirarCola = config.ghlWebhookEnabled && Date.now() - arrancado > 10 * 60000;
  const atrasadas = !mirarCola ? 0 : repo.db.prepare('SELECT id FROM conversations WHERE respond_at IS NOT NULL AND respond_at < ? AND ai_paused = 0 AND derivado = 0')
    .all(new Date(Date.now() - 5 * 60000).toISOString()).filter((c) => !setter.enCurso?.has(c.id)).length;
  return { ok: parados.length === 0 && atrasadas === 0, bucles_parados: parados, respuestas_atrasadas: atrasadas, respondiendo: setter.enCurso?.size || 0, arrancado: new Date(arrancado).toISOString() };
};

// Webhooks de AimHarder: solo las sedes con clave privada configurada (docs/aimharder-webhooks.md)
const clavesWebhook = {};
for (const sede of SEDES) { try { const k = claveDeSede(config.aimharder.webhookClaves[sede]); if (k) clavesWebhook[sede] = k; } catch (e) { console.warn(`[aimharder-webhook] clave de ${sede}: ${e.message}`); } }
const procesarEventosAimharder = crearProcesador({ repo, apis: clientesApi() });
const aimharderWebhook = Object.keys(clavesWebhook).length && config.aimharder.webhookToken
  ? manejadorWebhook({ repo, claves: clavesWebhook, sedes: SEDES, despertar: () => procesarEventosAimharder() }) : null;
let formularios = null;
if (config.formularios.desde) {
  try {
    formularios = procesadorFormularios({
      setter, ajustes: config.formularios, locationId: config.ghl.locationId, avisar: alertaSolicitudIncierta,
    });
  } catch (e) {
    registrarAlerta(repo.db, { clave: 'formularios-config', tipo: 'servidor',
      titulo: 'La recepción de formularios web está desactivada', detalle: e.message, nivel: 'error' });
  }
}

const app = crearApp({ setter, repo, etiquetas, ghl, salud, aimharderWebhook, avisos: avisosGhl, formularios });
if (config.ghlWebhookEnabled && !ghlConfigurado) registrarAlerta(repo.db, { clave: 'ghl-sin-configurar', tipo: 'ghl', titulo: 'Falta conectar GoHighLevel (GHL_TOKEN y GHL_LOCATION_ID)', detalle: 'Sin ellos Sofía no recibe ni envía mensajes. El panel y Probar IA funcionan.', nivel: 'aviso' });
else resolverAlerta(repo.db, 'ghl-sin-configurar');
const servidor = app.listen(config.port, config.host, () => {
  console.log(`Setter en http://${config.host}:${config.port} · modo ${config.mode} · modelo ${config.ai.model}`);
  if (config.mode !== 'live') console.log('Modo prueba: la IA NO envía mensajes; deja borradores como notas en GHL.');
});
// Claves que faltan o son cortas: se avisa en el registro y en las alertas del panel (sin enseñar la clave)
const debiles = clavesDebiles();
if (debiles.length) { debiles.forEach((a) => console.warn('[seguridad]', a)); registrarAlerta(repo.db, { clave: 'claves-debiles', tipo: 'servidor', titulo: 'Hay claves del servicio que faltan o son demasiado cortas', detalle: debiles.join('\n'), nivel: 'aviso' }); } else resolverAlerta(repo.db, 'claves-debiles');
if (aislamiento.modo === 'invalido') registrarAlerta(repo.db, { clave: 'aislamiento', tipo: 'servidor', titulo: 'Sofía no recibe ni envía nada: falta o está mal el aislamiento de WhatsApp', detalle: aislamiento.motivos.join('\n'), nivel: 'error' }); else resolverAlerta(repo.db, 'aislamiento');
servidor.on('error', (e) => { console.error('No se puede abrir el puerto:', e.message); process.exit(1); });

// Índice de socios desde AimHarder: cada 4 horas. Al arrancar solo se descargan las sedes con datos de más
// de 4 horas, para que los reinicios no gasten el límite de peticiones (compartido con otras apps).
const avisoSync = (e) => registrarAlerta(repo.db, { clave: 'aimharder-socios', tipo: 'aimharder', titulo: 'No se pueden sincronizar los socios de AimHarder', detalle: e.message, nivel: /429/.test(e.message) ? 'aviso' : 'error' }, { avisar: avisarEquipo });
sincronizarSiHaceFalta(repo)
  .then((r) => { if (r) resolverAlerta(repo.db, 'aimharder-socios'); console.log(r ? `Socios sincronizados: ${JSON.stringify(r)}` : 'Socios al día (menos de 4 h): no se descargan al arrancar.'); })
  .catch(avisoSync);
// Cola de webhooks de AimHarder: reintenta las lecturas pendientes (también las que quedaron a medias al reiniciar)
cada('eventos-aimharder', 30 * 1000, () => procesarEventosAimharder());
cada('socios', 4 * 3600 * 1000, () => sincronizarSocios(repo).then((r) => { resolverAlerta(repo.db, 'aimharder-socios'); console.log('Socios sincronizados:', JSON.stringify(r)); }).catch(avisoSync));

if (config.ghlWebhookEnabled) {
  // Respuestas pendientes cada 2 s (hasta 4 chats a la vez) y seguimientos cada minuto. La vuelta no espera a que
  // los chats terminen (cada respuesta tarda lo que tarda «escribir» sus burbujas): si esperase, un chat que toca
  // mientras Sofía escribe en otro no empezaría hasta que acabase ese. `tick` ya cuenta los que hay en marcha.
  cada('respuestas', 2000, () => { setter.tick().catch((e) => console.error('[respuestas]', e.message)); }, 1000);
  // Avisos de GHL pendientes: reintentos (GHL aún no devuelve la conversación o el mensaje) y los que un reinicio
  // dejó a medias. No espera a que terminen (`pendientes` los lanza), así que la vuelta es inmediata.
  cada('avisos-ghl', 2000, () => { avisosGhl.pendientes(); }, 1000);
  cada('seguimientos', 60000, () => procesarSeguimientos(setter));
  // Etiquetas con regla de inactividad («si no responde en X h»)
  cada('etiquetas-inactividad', 5 * 60000, () => etiquetas.revisarInactividad());
}
if (config.ghlWebhookEnabled && ghlConfigurado) {
  // Etiquetas puestas o quitadas en GHL (también reintenta las que no llegaron a subir y las quitadas pendientes).
  // Cada 15 minutos, los contactos con actividad en el último día; los de 30 días, una vez por noche (hacia las 4).
  // Antes eran los de 30 días cada 15 minutos: una lectura por contacto, que con mucho volumen agota el cupo de GHL.
  let revisionCompleta = null;
  cada('etiquetas-ghl', 15 * 60000, async () => {
    const ahora = new Date();
    const dia = ahora.toLocaleDateString('sv-SE', { timeZone: config.tz });
    const completa = revisionCompleta !== dia && Number(ahora.toLocaleString('en-GB', { timeZone: config.tz, hour: '2-digit', hour12: false })) === 4;
    const r = await etiquetas.sincronizarDesdeGhl({ dias: completa ? 30 : 1 });
    if (completa) revisionCompleta = dia;
    if (r.puestas + r.quitadas + r.subidas) console.log(`Etiquetas GHL${completa ? ' (revisión de 30 días)' : ''}:`, JSON.stringify(r));
  }, 60000);
  // Chats nuevos de los que no llegó el aviso de GHL: cada 3 minutos se repasan las conversaciones recientes
  cada('barrido-chats', 3 * 60000, () => setter.barrerConversacionesNuevas(), 2 * 60000);
}

// En segundo plano registrado: el apagado ordenado espera a que acabe un envío en curso antes de salir
if (formularios) cada('formularios-web', 30_000, () => enSegundoPlano(formularios()), 10_000);

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
  await vigilar(repo.db, { ghl: ghlConfigurado ? ghl : null, entradaGhl: config.ghlWebhookEnabled && ghlConfigurado, avisar: avisarEquipo });
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
  // Datos efímeros que ya no sirven (capturas de altas fallidas, notas de voz enviadas, alertas resueltas, pasadas
  // de la batería): PODA_*_DIAS en el .env, 0 = no borrar. Nunca borra mensajes ni archivos de los leads.
  const poda = podar({ db: repo.db, dataDir: path.dirname(config.dbPath), mediaDir: carpetaMedios() });
  if (Object.values(poda).some(Boolean)) console.log('Poda:', JSON.stringify(poda));
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
