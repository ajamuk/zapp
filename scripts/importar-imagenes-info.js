// Sube (o sustituye) las imágenes de tarifas y horarios de cada sede como recursos. Sofía no las elige: salen
// solas junto al texto cuando da precios u horarios. Los archivos deben llamarse «<sede>-<familia>-<tipo>.png»,
// p. ej. «las-rosas-crossfit-hyrox-tarifas.png» (carpeta de Drive «imágenes de tarifas y horarios»).
// Uso: node scripts/importar-imagenes-info.js <carpeta> [ruta de la base]
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { config } from '../src/config.js';
import * as recursos from '../src/recursos.js';

const [carpeta, dbPath = config.dbPath] = process.argv.slice(2);
if (!carpeta) { console.error('Uso: node scripts/importar-imagenes-info.js <carpeta> [base]'); process.exit(1); }
const db = openDb(dbPath);
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const SEDE = { parla: 'Parla', getafe: 'Getafe', 'las-rosas': 'Las Rosas', 'el-canaveral': 'El Cañaveral' };
let n = 0;
for (const f of fs.readdirSync(carpeta).sort()) {
  const nombre = path.basename(f, path.extname(f));
  const mime = MIME[path.extname(f).toLowerCase()];
  if (!mime || !recursos.esImagenInfo(nombre)) { console.log('omitido', f); continue; }
  const [, sede, fam, tipo] = nombre.match(/^(.+)-(academy|crossfit-hyrox)-(tarifas|horarios)$/);
  const descripcion = `Imagen de ${tipo} de ${SEDE[sede]} (${fam === 'academy' ? 'Academy' : 'CrossFit + HYROX'}). Se envía sola cuando Sofía da ${tipo === 'tarifas' ? 'los precios' : 'los horarios'} de esa sede.`;
  const viejo = db.prepare('SELECT id, pie FROM recursos WHERE nombre = ? COLLATE NOCASE').get(nombre);
  if (viejo) recursos.borrar(db, viejo.id);
  recursos.crear(db, { nombre, descripcion, pie: viejo?.pie || '', datos: fs.readFileSync(path.join(carpeta, f)).toString('base64'), mime, archivo: f });
  console.log(viejo ? 'sustituido' : 'nuevo', nombre); n++;
}
console.log(`${n} imágenes`);
