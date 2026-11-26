// Webhooks de AimHarder (cifrado en sobre: AES-256-GCM + clave AES cifrada con RSA-OAEP SHA-1). Ver docs/aimharder-webhooks.md.
// Cada evento de cliente solo sirve de aviso: se vuelve a leer la ficha (GET /clients/:id) y se actualiza ese socio
// del índice, así el resultado es siempre el estado real y no depende del orden en que lleguen los eventos.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { filaSocio } from './index.js';

const EVENTOS_CLIENTE = new Set(['CLIENT_CREATED', 'CLIENT_DEACTIVATED', 'CLIENT_REACTIVATED', 'MEMBERSHIP_ASSIGNED']);

export function descifrar(body, clavePrivada) {
  for (const k of ['encryptedKey', 'iv', 'tag', 'payload']) if (typeof body?.[k] !== 'string') throw new Error(`falta ${k}`);
  const aesKey = crypto.privateDecrypt(
    { key: clavePrivada, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    Buffer.from(body.encryptedKey, 'base64'),
  );
  const d = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(body.iv, 'base64'));
  d.setAuthTag(Buffer.from(body.tag, 'base64'));
  const json = Buffer.concat([d.update(Buffer.from(body.payload, 'base64')), d.final()]);
  return JSON.parse(json.toString('utf8'));
}

/** Clave privada de una sede: PEM en la variable (con \n escritos) o ruta a un fichero. null si no está configurada. */
export function claveDeSede(cfg) {
  if (cfg?.pem) return cfg.pem.replace(/\\n/g, '\n');
  if (cfg?.fichero) return fs.readFileSync(cfg.fichero, 'utf8');
  return null;
}

/**
 * Procesa un evento ya descifrado. Devuelve un texto con lo que se hizo.
 * apis: { sede: AimHarderApi } para releer la ficha.
 */
export async function procesarEvento(repo, apis, sede, evento) {
  if (evento.action === 'WEBHOOK_TEST') return 'prueba recibida';
  if (!EVENTOS_CLIENTE.has(evento.action)) return `ignorado (${evento.action})`;
  const id = evento.data?.client?.id;
  if (!id) return 'ignorado (sin id de cliente)';
  const api = apis[sede];
  if (!api) throw new Error(`sin acceso a la API de ${sede}`);
  const ficha = await api.cliente(id);
  const fila = ficha && filaSocio(sede, ficha);
  if (!fila) return `cliente ${id} sin teléfono: no se indexa`;
  repo.actualizarSocio(sede, fila);
  return `${evento.action}: cliente ${id} → ${fila.activo ? 'socio' : 'sin tarifa vigente'}`;
}

/**
 * Manejador de POST /webhooks/aimharder/:sede. Valida, descifra, descarta duplicados y responde; el trabajo
 * (releer la ficha) se hace después para contestar en menos de los 3 s que da AimHarder.
 */
export function manejadorWebhook({ repo, apis, claves, sedes, log = console }) {
  return async (sede, body) => {
    if (!sedes.includes(sede)) return { status: 404 };
    const clave = claves[sede];
    if (!clave) return { status: 503, error: `sin clave privada para ${sede}` };
    let evento;
    try { evento = descifrar(body, clave); } catch (e) { log.warn?.(`[aimharder-webhook] ${sede}: no se pudo descifrar (${e.message})`); return { status: 400 }; }
    if (!evento?.id || !evento?.action) return { status: 400 };
    if (!repo.eventoAimharderNuevo(evento.id, sede, evento.action)) return { status: 200, duplicado: true };
    const trabajo = procesarEvento(repo, apis, sede, evento)
      .then((r) => log.log?.(`[aimharder-webhook] ${sede}: ${r}`))
      .catch((e) => { repo.olvidarEventoAimharder(evento.id); log.error?.(`[aimharder-webhook] ${sede} ${evento.action}: ${e.message}`); });
    return { status: 200, trabajo };
  };
}
