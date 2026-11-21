import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Alta de socio en el panel de AimHarder con un navegador sin pantalla (Playwright).
 * La API pública crea la ficha, pero no la tarifa con fecha de inicio, el primer pago ni el descuento,
 * así que se usa el propio panel: se rellena la ficha, se añade la tarifa con las funciones del panel
 * (las mismas que llama el botón «Nueva tarifa») y se guarda.
 *
 * Mapeado sobre el formulario real el 20 nov 2026 (config/aimharder-alta.json).
 * Con dryRun (por defecto) se rellena todo y se comprueba, pero NO se pulsa Guardar.
 */
export function cargarConfig() {
  return JSON.parse(fs.readFileSync(path.join(config.root, 'config', 'aimharder-alta.json'), 'utf8'));
}

/** Edad en años cumplidos a una fecha dada (AAAA-MM-DD). */
export function edad(nacimiento, hoy = new Date()) {
  const [a, m, d] = nacimiento.split('-').map(Number);
  let e = hoy.getFullYear() - a;
  if (hoy.getMonth() + 1 < m || (hoy.getMonth() + 1 === m && hoy.getDate() < d)) e--;
  return e;
}

export const EDAD_MINIMA = 16;

export function validarDatos(d, hoy = new Date()) {
  const faltan = ['nombre_completo', 'email', 'fecha_nacimiento', 'telefono', 'sede', 'tarifa', 'fecha_inicio'].filter((k) => !d[k]);
  if (faltan.length) return `Faltan datos: ${faltan.join(', ')}`;
  if (String(d.nombre_completo).trim().split(/\s+/).length < 2) return 'Falta al menos un apellido';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email)) return 'Email no válido';
  if (String(d.telefono).replace(/\D/g, '').length < 9) return 'Teléfono no válido';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.fecha_nacimiento) || !/^\d{4}-\d{2}-\d{2}$/.test(d.fecha_inicio)) return 'Fechas en formato AAAA-MM-DD';
  if (edad(d.fecha_nacimiento, hoy) < EDAD_MINIMA) return `Menor de ${EDAD_MINIMA}: la edad mínima para entrenar es ${EDAD_MINIMA} años`;
  return null;
}

/** «Ana María López García» → nombre «Ana María», apellidos «López» y «García». */
export function partirNombre(completo) {
  const p = String(completo).trim().split(/\s+/);
  if (p.length <= 2) return { nombre: p[0] || '', apellido1: p[1] || '', apellido2: '' };
  if (p.length === 3) return { nombre: p[0], apellido1: p[1], apellido2: p[2] };
  return { nombre: p.slice(0, p.length - 2).join(' '), apellido1: p[p.length - 2], apellido2: p[p.length - 1] };
}

export const aDdMmYyyy = (iso) => iso.split('-').reverse().join('/');

/** Construye los datos que se meten en el formulario. Separado para poder probarlo sin navegador. */
export function prepararFormulario(d, cfg = cargarConfig()) {
  const tarifaId = cfg.tarifas[d.sede]?.[d.tarifa];
  if (!tarifaId) throw new Error(`Tarifa ${d.tarifa} no encontrada en ${d.sede}`);
  const sub = cfg.subdominios[d.sede];
  return {
    url: `https://${sub}.aimharder.com/clients${d.aimharder_id ? '' : '?new'}`,
    base: `https://${sub}.aimharder.com`,
    ...partirNombre(d.nombre_completo),
    email: d.email.trim().toLowerCase(),
    movil: String(d.telefono || '').replace(/\D/g, '').slice(-9),
    clienteId: d.aimharder_id || null,
    nacimiento: aDdMmYyyy(d.fecha_nacimiento),
    inicio: aDdMmYyyy(d.fecha_inicio),
    tarifaId,
    origen: cfg.origen[d.canal] || null,
    descuento: d.descuento || null,
    primerRecibo: d.primer_recibo ?? null,
    notas: `Alta preparada por Sofía (setter IA) desde ${d.canal || 'chat'}.`,
  };
}

async function login(page) {
  await page.goto('https://aimharder.com/login', { waitUntil: 'networkidle' });
  if (!/login/.test(page.url())) return; // sesión ya abierta
  await page.fill('input[type="email"], input[name*="mail" i]', config.aimharder.adminUser);
  await page.fill('input[type="password"]', config.aimharder.adminPassword);
  await Promise.all([page.waitForURL((u) => !/login/.test(String(u)), { timeout: 20000 }), page.keyboard.press('Enter')]);
}

/** Fecha de hoy en Madrid como dd/mm/aaaa (la fecha de emisión del primer recibo). */
export function hoyDdMmYyyy(ahora = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric' })
    .formatToParts(ahora).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year}`;
}

/** Elige el recibo pendiente que generó esta tarifa: el más reciente del cliente cuyo concepto lleva el nombre de la tarifa. */
export function elegirRecibo(pendientes, nombreTarifa) {
  const delCliente = [...pendientes].sort((a, b) => Number(b.id) - Number(a.id));
  return delCliente.find((p) => nombreTarifa && String(p.concept || '').toLowerCase().includes(nombreTarifa.toLowerCase())) || delCliente[0] || null;
}

/**
 * Procedimiento de alta (acordado con Carlos el 20 nov 2026):
 *  1. Ficha: nueva, o la del antiguo socio si ya existe (se reutiliza, se confirma el email).
 *  2. Forma de pago del cliente: «Pago automático con TPV RedSys» (clformapago = 4).
 *  3. Tarifa con su día de inicio; AimHarder calcula el prorrateo; primer recibo manual y pendiente.
 *  4. Guardar y comprobar que la forma de pago ha quedado guardada.
 *  5. Fecha de emisión del primer recibo = hoy (día en que se tramita), aunque empiece más tarde.
 *  6. Antiguo socio: reenviar la invitación desde AimHarder y comprobar el reenvío (el nuevo la recibe al guardar).
 * Con dryRun (por defecto) hace 1 y 3 sin guardar nada.
 */
export async function prepararAltaNavegador(datos, { dryRun = config.aimharder.altaDryRun, cfg = cargarConfig() } = {}) {
  const error = validarDatos(datos);
  if (error) return { estado: 'rechazada', detalle: error };
  if (!cfg.configurado || !config.aimharder.adminUser || !config.aimharder.adminPassword) {
    return { estado: 'no_configurado', detalle: 'Faltan AIMHARDER_ADMIN_USER / AIMHARDER_ADMIN_PASSWORD.' };
  }
  let f;
  try { f = prepararFormulario(datos, cfg); } catch (e) { return { estado: 'rechazada', detalle: e.message }; }

  let playwright;
  try { playwright = await import('playwright'); } catch {
    return { estado: 'no_configurado', detalle: 'Playwright no está instalado (npm i playwright && npx playwright install --with-deps chromium).' };
  }
  const sesion = path.join(path.dirname(config.dbPath), 'aimharder-sesion.json');
  const browser = await playwright.chromium.launch({ headless: true });
  let context; let page;
  try {
    // Si la sesión guardada está corrupta, se empieza sin ella (y nunca queda un navegador abierto)
    try { context = await browser.newContext(fs.existsSync(sesion) ? { storageState: sesion } : {}); }
    catch { context = await browser.newContext({}); }
    page = await context.newPage();
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
  } catch (e) { await browser.close().catch(() => {}); return { estado: 'fallida', detalle: `No se pudo abrir el navegador: ${e.message}` }; }
  const c = cfg.campos;
  const hoy = hoyDdMmYyyy();
  try {
    await login(page);
    await context.storageState({ path: sesion });
    await page.goto(f.url, { waitUntil: 'networkidle' });
    // Id del box de la sede: va escrito en las llamadas del propio panel
    const box = await page.evaluate(() => (String(window.invitarCliente).match(/box:\s*(\d+)/) || [])[1]);
    if (!box) throw new Error('No se encontró el id del box en el panel');

    // 1. Ficha
    let exSocio = false;
    if (f.clienteId) {
      exSocio = true;
      await page.evaluate((id) => window.editarCliente(id), f.clienteId);
      await page.waitForFunction((id) => String(window.clienteEditId) === String(id) && document.querySelector('#clnom')?.value, f.clienteId, { timeout: 20000 });
      const emailActual = (await page.inputValue(c.email)).trim().toLowerCase();
      if (emailActual !== f.email) await page.fill(c.email, f.email); // el lead ha confirmado este email
      const notas = await page.inputValue(c.notas);
      await page.fill(c.notas, `${notas ? notas + '\n' : ''}Reactivación preparada por Sofía (setter IA) el ${hoy}.`);
    } else {
      await page.waitForSelector(c.nombre, { timeout: 20000 });
      const existe = await page.evaluate(async ({ mail, box }) => JSON.parse(await window.jQuery.get('/api/checkmail', { mail, box })).exist == 1, { mail: f.email, box });
      if (existe) return { estado: 'existente', detalle: `Ya hay una ficha con ${f.email} en esta sede: es un antiguo socio y hay que reutilizar su ficha.` };
      await page.fill(c.nombre, f.nombre);
      await page.fill(c.apellido1, f.apellido1);
      await page.fill(c.apellido2, f.apellido2);
      await page.fill(c.movil, f.movil);
      await page.fill(c.email, f.email);
      await page.fill(c.notas, f.notas);
      await page.evaluate(({ c, f }) => {
        const $ = window.jQuery;
        $(c.nacimiento).datepicker('setDate', f.nacimiento);
        $(c.alta).datepicker('setDate', new Date());
        if (f.origen) { const o = [...document.querySelectorAll(`${c.origen} option`)].find((x) => x.text.trim().toLowerCase() === f.origen.toLowerCase()); if (o) $(c.origen).val(o.value).change(); }
      }, { c, f });
    }

    // 2. Forma de pago del cliente: TPV RedSys automática
    await page.evaluate((sel) => window.jQuery(sel).val('4').change(), c.formaPago);

    // 3. Tarifa: mismo camino que el botón «Nueva tarifa»
    const tarifa = await page.evaluate(({ c, f }) => {
      const $ = window.jQuery;
      window.hideSumaTotal(false);
      window.cargaSelTarifa(null);
      if (![...document.querySelectorAll(`${c.tarifa} option`)].some((o) => o.value === String(f.tarifaId))) return { ok: false, error: `La tarifa ${f.tarifaId} no está en el desplegable` };
      $(c.tarifa).val(String(f.tarifaId)).change();
      $(c.inicioTarifa).datepicker('setDate', f.inicio);
      window.cargaNwPrPago(false);
      window.calcularProrrateo(); // el prorrateo lo calcula AimHarder
      const cantidad = Number($('#nwPrCantidad').val());
      if (f.primerRecibo != null && Math.abs(cantidad - f.primerRecibo) > 0.01) return { ok: false, error: `El prorrateo de AimHarder (${cantidad} €) no coincide con el calculado (${f.primerRecibo} €)` };
      if (f.descuento) return { ok: false, error: 'No hay descuentos ni promociones: revisar a mano' };
      const radio = (texto) => [...document.querySelectorAll('input[type=radio]')].find((r) => {
        const l = r.id && document.querySelector(`label[for="${r.id}"]`);
        return ((l && l.textContent) || r.parentElement?.textContent || '').trim().toLowerCase().startsWith(texto);
      });
      const manual = radio('pago manual'); if (manual) { manual.checked = true; $(manual).change(); }
      const pend = document.querySelector(c.pagoPendiente) || radio('pago pendiente'); if (pend) { pend.checked = true; $(pend).change(); }
      if (!pend || !pend.checked) return { ok: false, error: 'No se pudo marcar «Pago pendiente»' };
      window.guardaTarifa(false);
      const sel = window.tarifasSel || [];
      const t = sel.find((x) => String(x.id) === String(f.tarifaId));
      return { ok: Boolean(t), tarifa: t?.nom, desde: t?.desde, cantidad };
    }, { c, f });
    if (!tarifa.ok) throw new Error(tarifa.error || 'La tarifa no quedó añadida a la ficha');

    if (dryRun) {
      return { estado: 'simulada', exSocio, detalle: `${exSocio ? 'Ficha existente' : 'Ficha nueva'} y tarifa rellenadas sin guardar: ${tarifa.tarifa} desde ${tarifa.desde}, prorrateo ${tarifa.cantidad} €.` };
    }

    // 4. Guardar (con un antiguo socio dado de baja, el panel pregunta si reactivarlo: sí)
    const respuesta = page.waitForResponse((r) => /\/api\/client\b/.test(r.url()) && r.request().method() === 'POST', { timeout: 30000 });
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('[onclick]')].find((e) => e.getAttribute('onclick') === 'guardarCliente(this, false);') || document.body;
      if (window.confirmareactivabaja) window.doguardarCliente(btn, false, 1);
      else window.doguardarCliente(btn, false, null); // la comprobación de duplicados ya se hizo con /api/checkmail
    });
    const r = await respuesta;
    let res; try { res = JSON.parse(await r.text()); } catch { res = null; }
    if (!r.ok() || !res || res.errors?.length || !res.id) throw new Error(`AimHarder no guardó la ficha: ${r.status()} ${JSON.stringify(res?.errors || res?.errorsReturn || '').slice(0, 200)}`);
    const clienteId = res.id;
    const avance = [`ficha ${clienteId} guardada`];

    const ficha = await page.evaluate(async ({ id, box }) => JSON.parse(await window.jQuery.get(`/api/client/${id}`, { box })), { id: clienteId, box });
    if (String(ficha.clformapago) !== '4') throw new Error(`La forma de pago no quedó en TPV RedSys (está en ${ficha.clformapago}) · ${avance.join(' · ')}`);
    avance.push('TPV RedSys guardado');

    // 5. Primer recibo: fecha de emisión = hoy
    await page.goto(`${f.base}/payments`, { waitUntil: 'networkidle' });
    const pendientes = async () => page.evaluate(async ({ id, box }) => JSON.parse(await window.jQuery.get('/api/pendingPayments', { box, clientId: id, type: window.jQuery('#fltipo').val() })).pending
      .filter((p) => String(p.clid) === String(id)), { id: clienteId, box });
    const recibo = elegirRecibo(await pendientes(), tarifa.tarifa);
    if (!recibo) throw new Error(`No aparece el primer recibo pendiente · ${avance.join(' · ')}`);
    if (recibo.since !== hoy) {
      await page.evaluate((pid) => window.fichaPago(pid), recibo.id);
      await page.waitForFunction((pid) => String(window.pagoEditId) === String(pid) && window.jQuery('#pgDesde').datepicker('getDate') && document.querySelector('#pgcantidad').value, recibo.id, { timeout: 20000 });
      const guardado = page.waitForResponse((x) => /\/api\/payment\b/.test(x.url()) && x.request().method() === 'POST', { timeout: 30000 });
      await page.evaluate((hoy) => {
        window.jQuery('#pgDesde').datepicker('setDate', hoy);
        window.guardarPago(document.createElement('span'));
      }, hoy);
      const rp = await guardado;
      let rpj; try { rpj = JSON.parse(await rp.text()); } catch { rpj = null; }
      if (!rpj || rpj.result != 1) throw new Error(`No se pudo cambiar la fecha de emisión del recibo ${recibo.id} · ${avance.join(' · ')}`);
    }
    const verificado = (await pendientes()).find((p) => String(p.id) === String(recibo.id));
    if (!verificado || verificado.since !== hoy) throw new Error(`El recibo ${recibo.id} no quedó emitido con fecha de hoy · ${avance.join(' · ')}`);
    avance.push(`recibo emitido hoy (${verificado.amountc} € pendiente)`);

    // 6. Antiguo socio: reenviar la invitación y comprobarlo
    let invitacion = 'enviada al guardar la ficha nueva';
    if (exSocio) {
      const inv = await page.evaluate(async ({ id, mail, box }) => JSON.parse(await window.jQuery.post('/api/inviteClient', { clid: id, clmail: mail, box })), { id: clienteId, mail: f.email, box });
      if (inv.errors?.length || inv.state != 1) throw new Error(`No se pudo reenviar la invitación: ${JSON.stringify(inv.errors || inv).slice(0, 200)} · ${avance.join(' · ')}`);
      invitacion = 'reenviada';
      avance.push('invitación reenviada');
    }

    return {
      estado: 'preparada',
      exSocio,
      clienteId,
      pendiente: Number(verificado.amountc),
      tarifa: tarifa.tarifa,
      desde: tarifa.desde,
      invitacion,
      detalle: `Alta guardada y verificada: ${avance.join(' · ')}.`,
    };
  } catch (e) {
    const shot = path.join(path.dirname(config.dbPath), `alta-error-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    return { estado: 'fallida', detalle: `${e.message} (captura: ${shot})` };
  } finally {
    await browser.close().catch(() => {});
  }
}
