// Regenera config/horarios.json desde AimHarder y avisa si alguna tarifa ha cambiado de precio.
// Uso: npm run sync-aimharder   (necesita los tokens AIMHARDER_TOKEN_* en .env)
import fs from 'node:fs';
import path from 'node:path';
import { config, rutaConfig } from '../src/config.js';
import { clientesApi } from '../src/aimharder/index.js';
import { leerHorarios, diferencias } from '../src/horarios-sync.js';

// Nombre de la tarifa en AimHarder → clave interna
const TARIFA = [[/academy 2/i, 'academy_2'], [/academy 3/i, 'academy_3'], [/^tarifa s\b/i, 'S'], [/^tarifa m\b/i, 'M'], [/^tarifa l\b/i, 'L'], [/^tarifa xl\b/i, 'XL'], [/^bono 10 clases$/i, 'bono10']];

const apis = clientesApi();
const horariosPath = path.join(config.configDir, 'horarios.json');
const anterior = JSON.parse(fs.readFileSync(horariosPath, 'utf8'));
const tarifas = JSON.parse(fs.readFileSync(rutaConfig('tarifas.json'), 'utf8'));
const { horarios: nuevo, fallos } = await leerHorarios(apis, { anterior });
const cambios = diferencias(anterior, nuevo);
const avisos = [];
for (const [sede, api] of Object.entries(apis)) {
  for (const t of (await api.tarifas()).filter((x) => !x.deactivation_date)) {
    const clave = TARIFA.find(([re]) => re.test(t.name.trim()))?.[1];
    if (clave && tarifas[sede][clave] !== t.price) avisos.push(`${sede} ${clave}: config ${tarifas[sede][clave]} € · AimHarder ${t.price} € («${t.name}»)`);
  }
}

fs.writeFileSync(horariosPath, JSON.stringify(nuevo, null, 2) + '\n');
console.log(`Horarios actualizados para: ${Object.keys(apis).join(', ')}`);
console.log(avisos.length ? `Tarifas distintas (revisar config/tarifas.json):\n${avisos.join('\n')}` : 'Tarifas: coinciden con AimHarder.');
console.log(cambios.length ? `Cambios de horario:\n${cambios.join('\n')}` : 'Horarios: sin cambios.');
if (fallos.length) console.log(`Sedes que no se pudieron leer (se deja lo que había):\n${fallos.join('\n')}`);
