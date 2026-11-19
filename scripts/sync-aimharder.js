// Regenera config/horarios.json desde AimHarder y avisa si alguna tarifa ha cambiado de precio.
// Uso: npm run sync-aimharder   (necesita los tokens AIMHARDER_TOKEN_* en .env)
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { clientesApi } from '../src/aimharder/index.js';

const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
const MAPA = { crossfit: 'crossfit', 'crossfit academy': 'academy', hyrox: 'hyrox', 'open box': 'open_box', halterofilia: 'halterofilia', 'crossfit partner': 'crossfit_partner', fuerza: 'fuerza' };
const ORDEN = ['academy', 'crossfit', 'hyrox', 'open_box', 'halterofilia', 'crossfit_partner', 'fuerza'];
// Nombre de la tarifa en AimHarder → clave interna
const TARIFA = [[/academy 2/i, 'academy_2'], [/academy 3/i, 'academy_3'], [/^tarifa s\b/i, 'S'], [/^tarifa m\b/i, 'M'], [/^tarifa l\b/i, 'L'], [/^tarifa xl\b/i, 'XL'], [/^bono 10 clases$/i, 'bono10']];

const hoy = new Date().toISOString().slice(0, 10);
const apis = clientesApi();
const horariosPath = path.join(config.root, 'config', 'horarios.json');
const anterior = JSON.parse(fs.readFileSync(horariosPath, 'utf8'));
const tarifas = JSON.parse(fs.readFileSync(path.join(config.root, 'config', 'tarifas.json'), 'utf8'));
const nuevo = { _nota: `Horario habitual sacado de la API de AimHarder el ${hoy}. Se regenera con npm run sync-aimharder. No confirma plazas libres.`, _plazas: anterior._plazas };
const avisos = [];

for (const [sede, api] of Object.entries(apis)) {
  const clases = (await api.clases()).filter((c) => !c.deactivation_date);
  nuevo[sede] = {};
  for (const c of clases) {
    const k = MAPA[c.name.trim().toLowerCase()];
    if (!k) continue;
    const vigentes = (await api.horariosDeClase(c.id)).filter((h) => h.start_date <= hoy && (!h.end_date || h.end_date >= hoy));
    const tabla = {};
    for (const h of vigentes) (tabla[DIAS[h.weekday]] ??= new Set()).add(h.time);
    const dias = Object.fromEntries(DIAS.filter((d) => tabla[d]).map((d) => [d, [...tabla[d]].sort()]));
    if (Object.keys(dias).length) nuevo[sede][k] = dias;
  }
  nuevo[sede] = Object.fromEntries(ORDEN.filter((k) => nuevo[sede][k]).map((k) => [k, nuevo[sede][k]]));

  for (const t of (await api.tarifas()).filter((x) => !x.deactivation_date)) {
    const clave = TARIFA.find(([re]) => re.test(t.name.trim()))?.[1];
    if (clave && tarifas[sede][clave] !== t.price) avisos.push(`${sede} ${clave}: config ${tarifas[sede][clave]} € · AimHarder ${t.price} € («${t.name}»)`);
  }
}

fs.writeFileSync(horariosPath, JSON.stringify(nuevo, null, 2) + '\n');
console.log(`Horarios actualizados para: ${Object.keys(apis).join(', ')}`);
console.log(avisos.length ? `Tarifas distintas (revisar config/tarifas.json):\n${avisos.join('\n')}` : 'Tarifas: coinciden con AimHarder.');
