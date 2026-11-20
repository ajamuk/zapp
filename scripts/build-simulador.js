// Genera simulador/simulador.html con el prompt, la base de conocimiento, horarios y tarifas actuales.
// Uso: npm run build-simulador  → luego se publica la página (Claude lo hace con su herramienta de artefactos).
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { knowledge } from '../src/knowledge.js';

const c = (f) => fs.readFileSync(path.join(config.root, 'config', f), 'utf8');
const datos = {
  prompt: c('prompt-sofia.md'),
  negocio: knowledge.negocio,
  horarios: JSON.parse(c('horarios.json')),
  tarifas: JSON.parse(c('tarifas.json')),
};
const plantilla = fs.readFileSync(path.join(config.root, 'simulador', 'plantilla.html'), 'utf8');
const json = JSON.stringify(datos).replace(/</g, '\\u003c');
const out = plantilla.replace('/*__DATOS__*/null', json);
fs.writeFileSync(path.join(config.root, 'simulador', 'simulador.html'), out);
console.log(`simulador/simulador.html (${Math.round(out.length / 1024)} KB)`);
