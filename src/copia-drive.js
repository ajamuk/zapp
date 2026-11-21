// Copia de seguridad fuera del servidor: sube las copias diarias de la base a Google Drive con rclone.
// El destino es un «remote» cifrado de rclone (tipo crypt): en Drive solo hay ficheros ilegibles sin la clave,
// que vive en la configuración de rclone del servidor. Se configura con COPIA_DRIVE_REMOTO (p. ej.
// «cfmpo_db_backups_crypt:zapp») y, si hace falta, COPIA_DRIVE_RCLONE_CONFIG (ruta del rclone.conf).
import { execFile } from 'node:child_process';
import fs from 'node:fs';

const correr = (args) => new Promise((ok, mal) => execFile('rclone', args, { timeout: 10 * 60000, maxBuffer: 4 << 20 }, (e, out, err) => (e ? mal(new Error(String(err || e.message).trim().split('\n').slice(-3).join(' · ').slice(0, 400))) : ok(out))));

export const destinoDrive = () => ({ remoto: process.env.COPIA_DRIVE_REMOTO || '', conf: process.env.COPIA_DRIVE_RCLONE_CONFIG || '' });

/**
 * Sube a Drive las copias `*.db` de `dir` que falten (las que ya están no se vuelven a subir) y borra de Drive las de
 * más de `dias` días. Devuelve { subido, ficheros } o null si no hay destino configurado. Lanza si rclone falla.
 */
export async function subirCopias(dir, { remoto = destinoDrive().remoto, conf = destinoDrive().conf, dias = 90, ejecutar = correr } = {}) {
  if (!remoto || !fs.existsSync(dir)) return null;
  const comun = [...(conf ? ['--config', conf] : []), '--include', '*.db'];
  await ejecutar(['copy', dir, remoto, ...comun, '--transfers', '1', '--tpslimit', '2', '--drive-stop-on-upload-limit']);
  await ejecutar(['delete', remoto, ...comun, '--min-age', `${dias}d`]).catch(() => {}); // limpiar las viejas no es crítico
  const lista = String(await ejecutar(['lsf', remoto, ...comun])).split('\n').filter(Boolean).sort();
  const locales = fs.readdirSync(dir).filter((f) => f.endsWith('.db'));
  const faltan = locales.filter((f) => !lista.includes(f));
  if (faltan.length) throw new Error(`Tras subir, en Drive faltan: ${faltan.join(', ')}`);
  return { subido: true, ficheros: lista.length, ultima: lista.filter((f) => f.startsWith('setter-')).at(-1) || null };
}
