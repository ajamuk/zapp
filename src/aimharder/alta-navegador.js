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

export function validarDatos(d) {
  const faltan = ['nombre_completo', 'email', 'fecha_nacimiento', 'sede', 'tarifa', 'fecha_inicio'].filter((k) => !d[k]);
  if (faltan.length) return `Faltan datos: ${faltan.join(', ')}`;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email)) return 'Email no válido';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.fecha_nacimiento) || !/^\d{4}-\d{2}-\d{2}$/.test(d.fecha_inicio)) return 'Fechas en formato AAAA-MM-DD';
  const edad = (Date.now() - Date.parse(d.fecha_nacimiento)) / (365.25 * 864e5);
  if (edad < 16) return 'Menor de 16: necesita gestión del equipo';
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
    url: `https://${sub}.aimharder.com/clients?new`,
    ...partirNombre(d.nombre_completo),
    email: d.email.trim().toLowerCase(),
    movil: String(d.telefono || '').replace(/^\+?34/, '').replace(/\D/g, ''),
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
  const context = await browser.newContext(fs.existsSync(sesion) ? { storageState: sesion } : {});
  const page = await context.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  try {
    await login(page);
    await context.storageState({ path: sesion });
    await page.goto(f.url, { waitUntil: 'networkidle' });
    await page.waitForSelector('#clnom', { timeout: 20000 });

    // ¿Existe ya alguien con ese email en esta sede? El panel lo comprueba con /api/checkmail
    const c = cfg.campos;
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
      if (f.origen) { const o = [...document.querySelectorAll(`${c.origen} option`)].find((x) => x.text.trim() === f.origen); if (o) $(c.origen).val(o.value).change(); }
    }, { c, f });

    // Tarifa: mismo camino que el botón «Nueva tarifa» → elegir tarifa → día de inicio → pago pendiente → Continuar
    const tarifa = await page.evaluate(({ c, f }) => {
      const $ = window.jQuery;
      window.hideSumaTotal(false);
      window.cargaSelTarifa(null);
      if (![...document.querySelectorAll(`${c.tarifa} option`)].some((o) => o.value === String(f.tarifaId))) return { ok: false, error: `La tarifa ${f.tarifaId} no está en el desplegable` };
      $(c.tarifa).val(String(f.tarifaId)).change();
      $(c.inicioTarifa).datepicker('setDate', f.inicio);
      window.cargaNwPrPago(false);
      // Primer recibo: el panel calcula la parte proporcional del mes (comprobado: 23 nov, 105 € → 28 €)
      window.calcularProrrateo();
      const cantidad = Number($('#nwPrCantidad').val());
      if (f.primerRecibo != null && Math.abs(cantidad - f.primerRecibo) > 0.01) return { ok: false, error: `El prorrateo de AimHarder (${cantidad} €) no coincide con el calculado (${f.primerRecibo} €)` };
      if (f.descuento) {
        const o = [...document.querySelectorAll(`${c.descuento} option`)].find((x) => x.text.trim().toLowerCase() === f.descuento.toLowerCase());
        if (!o) return { ok: false, error: `Descuento «${f.descuento}» no existe en esta sede` };
        $(c.descuento).val(o.value).change();
      }
      const pend = document.querySelector(c.pagoPendiente); if (pend) { pend.checked = true; $(pend).change(); }
      window.guardaTarifa(false);
      const sel = window.tarifasSel || [];
      return { ok: sel.length > 0 && String(sel[0].id) === String(f.tarifaId), tarifa: sel[0]?.nom, desde: sel[0]?.desde, cantidad };
    }, { c, f });
    if (!tarifa.ok) throw new Error(tarifa.error || 'La tarifa no quedó añadida a la ficha');

    if (dryRun) {
      return { estado: 'simulada', detalle: `Ficha y tarifa rellenadas sin guardar: ${tarifa.tarifa} desde ${tarifa.desde}, primer recibo ${tarifa.cantidad} €.` };
    }

    // Guardar. El panel envía la ficha y la tarifa juntas a /api/client y, con email, manda la invitación.
    const respuesta = page.waitForResponse((r) => /\/api\/client\b/.test(r.url()) && r.request().method() === 'POST', { timeout: 30000 });
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('[onclick]')].find((e) => e.getAttribute('onclick') === 'guardarCliente(this, false);');
      window.guardarCliente(btn, false);
    });
    const r = await respuesta;
    const cuerpo = await r.text();
    if (!r.ok() || /error/i.test(cuerpo.slice(0, 200))) throw new Error(`AimHarder no guardó la ficha: ${r.status()} ${cuerpo.slice(0, 200)}`);
    return { estado: 'preparada', detalle: `Alta guardada: ${tarifa.tarifa} desde ${tarifa.desde}, primer recibo ${tarifa.cantidad} € pendiente.` };
  } catch (e) {
    const shot = path.join(path.dirname(config.dbPath), `alta-error-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    return { estado: 'fallida', detalle: `${e.message} (captura: ${shot})` };
  } finally {
    await browser.close();
  }
}
