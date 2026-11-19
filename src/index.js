import { config } from './config.js';
import { openDb, repo as crearRepo } from './db.js';
import { Ghl } from './ghl.js';
import { buscarSocioPorTelefono, prepararAltaNavegador, sincronizarSocios } from './aimharder/index.js';
import { avisarEquipo } from './notify.js';
import { Setter } from './setter.js';
import { procesarSeguimientos } from './followups.js';
import { crearApp } from './server.js';

const repo = crearRepo(openDb(config.dbPath));
const aimharder = { buscarSocioPorTelefono: async (tel) => buscarSocioPorTelefono(repo, tel), prepararAlta: prepararAltaNavegador };

// Índice de socios desde AimHarder: al arrancar y cada 4 horas.
const sincronizar = () => sincronizarSocios(repo)
  .then((r) => console.log('Socios sincronizados:', JSON.stringify(r)))
  .catch((e) => avisarEquipo(`No se pudo sincronizar socios de AimHarder: ${e.message}`));
sincronizar();
setInterval(sincronizar, 4 * 3600 * 1000);
const setter = new Setter({ repo, ghl: new Ghl(), aimharder, avisar: avisarEquipo });

const app = crearApp({ setter, repo, aimharder, avisar: avisarEquipo });
app.listen(config.port, '127.0.0.1', () => {
  console.log(`Setter en http://127.0.0.1:${config.port} · modo ${config.mode} · modelo ${config.ai.model}`);
  if (config.mode !== 'live') console.log('Modo prueba: la IA NO envía mensajes; deja borradores como notas en GHL.');
});

// Bucle: respuestas pendientes cada 5 s, seguimientos cada minuto.
let ocupado = false;
setInterval(async () => {
  if (ocupado) return;
  ocupado = true;
  try { await setter.tick(); } finally { ocupado = false; }
}, 5000);
setInterval(() => procesarSeguimientos(setter).catch((e) => console.error('Seguimientos:', e)), 60000);
