import { config } from './config.js';
import { openDb, repo as crearRepo } from './db.js';
import { Ghl } from './ghl.js';
import { buscarSocioPorTelefono, fichaEnSede, prepararAltaNavegador, sincronizarSocios, sincronizarSiHaceFalta } from './aimharder/index.js';
import { avisarEquipo } from './notify.js';
import { Setter } from './setter.js';
import { aplicarAjustes } from './ajustes.js';
import { procesarSeguimientos } from './followups.js';
import { crearApp } from './server.js';
import { Etiquetador } from './etiquetas.js';

const repo = crearRepo(openDb(config.dbPath));
aplicarAjustes(repo); // horario y retrasos guardados desde el panel
const aimharder = { buscarSocioPorTelefono: async (tel) => buscarSocioPorTelefono(repo, tel), prepararAlta: prepararAltaNavegador,
  fichaEnSede: async (tel, sede) => fichaEnSede(repo, tel, sede) };

// Índice de socios desde AimHarder: cada 4 horas. Al arrancar solo se descargan las sedes con datos de más
// de 4 horas, para que los reinicios no gasten el límite de peticiones (compartido con otras apps).
const avisoSync = (e) => avisarEquipo(`No se pudo sincronizar socios de AimHarder: ${e.message}`);
sincronizarSiHaceFalta(repo)
  .then((r) => console.log(r ? `Socios sincronizados: ${JSON.stringify(r)}` : 'Socios al día (menos de 4 h): no se descargan al arrancar.'))
  .catch(avisoSync);
setInterval(() => sincronizarSocios(repo).then((r) => console.log('Socios sincronizados:', JSON.stringify(r))).catch(avisoSync), 4 * 3600 * 1000);
const ghl = new Ghl();
const etiquetas = new Etiquetador({ repo, ghl, avisar: avisarEquipo });
const setter = new Setter({ repo, ghl, aimharder, avisar: avisarEquipo, etiquetas });

const app = crearApp({ setter, repo, etiquetas });
app.listen(config.port, '127.0.0.1', () => {
  console.log(`Setter en http://127.0.0.1:${config.port} · modo ${config.mode} · modelo ${config.ai.model}`);
  if (config.mode !== 'live') console.log('Modo prueba: la IA NO envía mensajes; deja borradores como notas en GHL.');
});

// Bucle: respuestas pendientes cada 5 s, seguimientos cada minuto.
if (config.ghlWebhookEnabled) {
  let ocupado = false;
  setInterval(async () => {
    if (ocupado) return;
    ocupado = true;
    try { await setter.tick(); } finally { ocupado = false; }
  }, 5000);
  setInterval(() => procesarSeguimientos(setter).catch((e) => console.error('Seguimientos:', e)), 60000);
  // Etiquetas con regla de inactividad («si no responde en X h»)
  setInterval(() => etiquetas.revisarInactividad().catch((e) => console.error('Etiquetas (inactividad):', e)), 5 * 60000);
}
