// Webhooks de AimHarder (cifrado en sobre: AES-256-GCM + clave AES cifrada con RSA-OAEP SHA-1). Ver docs/aimharder-webhooks.md.
// Cada evento de cliente solo sirve de aviso: se vuelve a leer la ficha (GET /clients/:id) y se actualiza ese socio
// del índice, así el resultado es siempre el estado real y no depende del orden en que lleguen los eventos.
//
// Entrega: el evento se guarda en la cola (tabla aimharder_eventos) ANTES de contestar 200, y la lectura se hace
// después desde la cola con reintentos propios. AimHarder solo reintenta si no recibe 2xx, y con el 200 ya dado no
// volvería a enviar nada: por eso los reintentos de una lectura fallida (429, caída…) los hace Zapp.
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

/** Pausa entre reintentos de una lectura fallida (segundos): como la política de AimHarder, 7 intentos en unas 24 h. */
export const ESPERAS_S = [60, 300, 1800, 7200, 21600, 54000];
const MAX_EDAD_MS = 25 * 3600 * 1000; // pasado este tiempo, la sincronización de socios ya lo habrá cubierto
const ESPERA_429_S = { min: 60, max: 3600 };

/**
 * Guarda el evento en la cola. Devuelve false si ya estaba (duplicado: se contesta 200 sin hacer nada más).
 * Los eventos que no mueven el índice (prueba, acciones desconocidas) se guardan ya como hechos.
 */
export function registrarEvento(repo, sede, evento, ahora = Date.now()) {
  const clienteId = evento.data?.client?.id ?? null;
  const trabaja = EVENTOS_CLIENTE.has(evento.action) && clienteId;
  return repo.registrarEventoAimharder({ id: evento.id, sede, accion: evento.action, cliente_id: trabaja ? clienteId : null, estado: trabaja ? 'pendiente' : 'hecho', ahora });
}

/** Relee la ficha del cliente y actualiza solo ese socio del índice. Devuelve un texto con lo que se hizo. */
export async function actualizarCliente(repo, api, sede, clienteId) {
  const ficha = await api.cliente(clienteId);
  const fila = ficha && filaSocio(sede, ficha);
  if (!fila) return `cliente ${clienteId} sin teléfono: no se indexa`;
  repo.actualizarSocio(sede, fila);
  return `cliente ${clienteId} → ${fila.activo ? 'socio' : 'sin tarifa vigente'}`;
}

/**
 * Procesador de la cola: lee las fichas de los eventos pendientes. Nunca se solapa consigo mismo.
 *  - Un 429 pausa esa sede el tiempo que diga Retry-After (mínimo 1 min, máximo 1 h) y no gasta intentos.
 *  - Otro fallo reprograma el evento (ESPERAS_S); agotados los intentos, o pasadas 25 h, queda «fallido» y solo
 *    lo cubre la sincronización de 4 h.
 *  - Varios eventos del mismo cliente en una pasada cuestan una sola lectura.
 * Devuelve una función ejecutar({ ahora }) → resumen.
 */
export function crearProcesador({ repo, apis, log = console }) {
  let enCurso = false;
  const pausadaHasta = {}; // sede → ms
  return async function ejecutar({ ahora = Date.now() } = {}) {
    if (enCurso) return null;
    enCurso = true;
    const r = { hechos: 0, reintentos: 0, pausados: 0, fallidos: 0 };
    try {
      const leidos = new Set();
      for (const f of repo.eventosAimharderPendientes(ahora)) {
        if ((pausadaHasta[f.sede] || 0) > ahora) { r.pausados++; continue; }
        const clave = `${f.sede}:${f.cliente_id}`;
        if (leidos.has(clave)) { repo.actualizarEventoAimharder(f.id, { estado: 'hecho' }); r.hechos++; continue; }
        try {
          if (!apis[f.sede]) throw new Error(`sin acceso a la API de ${f.sede}`);
          const texto = await actualizarCliente(repo, apis[f.sede], f.sede, f.cliente_id);
          leidos.add(clave);
          repo.actualizarEventoAimharder(f.id, { estado: 'hecho' });
          r.hechos++;
          log.log?.(`[aimharder-webhook] ${f.sede} ${f.accion}: ${texto}`);
        } catch (e) {
          if (e.status === 404) { repo.actualizarEventoAimharder(f.id, { estado: 'hecho', error: 'ficha inexistente' }); r.hechos++; continue; }
          if (e.status === 429) {
            const espera = Math.min(Math.max(e.retryAfter || ESPERA_429_S.min, ESPERA_429_S.min), ESPERA_429_S.max) * 1000;
            pausadaHasta[f.sede] = ahora + espera;
            repo.actualizarEventoAimharder(f.id, { proximo_ms: ahora + espera, error: e.message });
            r.pausados++;
            log.warn?.(`[aimharder-webhook] ${f.sede}: límite de peticiones, se espera ${Math.round(espera / 1000)} s`);
            continue;
          }
          const intentos = f.intentos + 1;
          if (intentos > ESPERAS_S.length || ahora - f.creado_ms > MAX_EDAD_MS) {
            repo.actualizarEventoAimharder(f.id, { estado: 'fallido', intentos, error: e.message });
            r.fallidos++;
            log.error?.(`[aimharder-webhook] ${f.sede} ${f.accion} (cliente ${f.cliente_id}) sin leer tras ${intentos} intentos: ${e.message}`);
          } else {
            repo.actualizarEventoAimharder(f.id, { intentos, proximo_ms: ahora + ESPERAS_S[intentos - 1] * 1000, error: e.message });
            r.reintentos++;
          }
        }
      }
      repo.podarEventosAimharder?.(30);
    } finally { enCurso = false; }
    return r;
  };
}

/**
 * Manejador de POST /webhooks/aimharder/:sede. Valida, descifra y GUARDA el evento; solo entonces contesta 200
 * (AimHarder da 3 s). La lectura de la ficha la hace el procesador de la cola; `despertar` lo avisa para que
 * no espere a la siguiente vuelta.
 */
export function manejadorWebhook({ repo, claves, sedes, despertar = () => {}, log = console, reloj = Date.now }) {
  return async (sede, body) => {
    if (!sedes.includes(sede)) return { status: 404 };
    const clave = claves[sede];
    if (!clave) return { status: 503, error: `sin clave privada para ${sede}` };
    let evento;
    try { evento = descifrar(body, clave); } catch (e) { log.warn?.(`[aimharder-webhook] ${sede}: no se pudo descifrar (${e.message})`); return { status: 400 }; }
    if (!evento?.id || !evento?.action) return { status: 400 };
    let nuevo;
    try { nuevo = registrarEvento(repo, sede, evento, reloj()); } catch (e) { log.error?.(`[aimharder-webhook] ${sede}: no se pudo guardar el evento (${e.message})`); return { status: 500 }; }
    if (!nuevo) return { status: 200, duplicado: true };
    if (evento.action === 'WEBHOOK_TEST') log.log?.(`[aimharder-webhook] ${sede}: prueba recibida`);
    setImmediate(() => Promise.resolve(despertar()).catch(() => {}));
    return { status: 200 };
  };
}
