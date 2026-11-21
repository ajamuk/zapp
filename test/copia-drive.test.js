import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { subirCopias } from '../src/copia-drive.js';

test('copia en Drive: sube las copias, limpia las viejas y comprueba que están todas', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cop-'));
  for (const f of ['setter-2026-11-20.db', 'setter-2026-11-21.db', 'pruebas-2026-11-21.db', 'setter-2026-11-21.db-wal']) fs.writeFileSync(path.join(dir, f), 'x');
  const llamadas = [];
  const ejecutar = (remotos) => async (a) => { llamadas.push(a); return a[0] === 'lsf' ? remotos.join('\n') + '\n' : ''; };
  assert.equal(await subirCopias(dir, { remoto: '', ejecutar: ejecutar([]) }), null); // sin destino configurado no hace nada
  const r = await subirCopias(dir, { remoto: 'cifrado:zapp', conf: '/x/rclone.conf', ejecutar: ejecutar(['pruebas-2026-11-21.db', 'setter-2026-11-20.db', 'setter-2026-11-21.db']) });
  assert.deepEqual(r, { subido: true, ficheros: 3, ultima: 'setter-2026-11-21.db' });
  assert.deepEqual(llamadas.map((a) => a[0]), ['copy', 'delete', 'lsf']);
  assert.deepEqual(llamadas[0].slice(0, 7), ['copy', dir, 'cifrado:zapp', '--config', '/x/rclone.conf', '--include', '*.db']);
  assert.ok(llamadas[1].includes('90d'));
  // Si en Drive falta alguna copia local, es un fallo (salta la alerta)
  await assert.rejects(subirCopias(dir, { remoto: 'cifrado:zapp', ejecutar: ejecutar(['setter-2026-11-20.db']) }), /faltan: .*setter-2026-11-21\.db/);
});
