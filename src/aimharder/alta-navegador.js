import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Alta de socio en AimHarder rellenando el panel de administración con un navegador (Playwright).
 * La API de AimHarder no permite fijar la fecha de inicio, las condiciones ni los descuentos que hacen falta.
 *
 * Los selectores del formulario viven en config/aimharder-alta.json y hay que grabarlos una vez
 * sobre el panel real (ver docs/aimharder.md). Mientras falten, la función devuelve `no_configurado`
 * y el sistema avisa al equipo para hacer el alta a mano.
 */
export function cargarPasos() {
  const f = path.join(config.root, 'config', 'aimharder-alta.json');
  return JSON.parse(fs.readFileSync(f, 'utf8'));
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

const rellenar = (plantilla, datos) => String(plantilla).replace(/\{(\w+)\}/g, (_, k) => datos[k] ?? '');

export async function prepararAltaNavegador(datos, { dryRun = config.aimharder.altaDryRun, pasos = cargarPasos() } = {}) {
  const error = validarDatos(datos);
  if (error) return { estado: 'rechazada', detalle: error };
  if (!pasos.configurado || !config.aimharder.adminUrl) {
    return { estado: 'no_configurado', detalle: 'Faltan los selectores del panel de AimHarder o AIMHARDER_ADMIN_URL.' };
  }
  let playwright;
  try { playwright = await import('playwright'); } catch {
    return { estado: 'no_configurado', detalle: 'Playwright no está instalado (npm i playwright && npx playwright install chromium).' };
  }
  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage();
  const ctx = {
    ...datos,
    usuario: config.aimharder.adminUser,
    password: config.aimharder.adminPassword,
    tarifa_aimharder: pasos.tarifas?.[datos.sede]?.[datos.tarifa] || '',
    descuento_aimharder: datos.descuento ? pasos.descuentos?.[datos.descuento] || '' : '',
  };
  try {
    await page.goto(config.aimharder.adminUrl, { waitUntil: 'domcontentloaded' });
    for (const paso of pasos.pasos) {
      if (paso.soloSi && !ctx[paso.soloSi]) continue;
      if (paso.guardar && dryRun) continue; // en pruebas se rellena todo pero no se guarda
      const sel = rellenar(paso.selector || '', ctx);
      switch (paso.accion) {
        case 'ir': await page.goto(rellenar(paso.url, ctx), { waitUntil: 'domcontentloaded' }); break;
        case 'escribir': await page.fill(sel, rellenar(paso.valor, ctx)); break;
        case 'click': await page.click(sel); break;
        case 'elegir': await page.selectOption(sel, { label: rellenar(paso.valor, ctx) }); break;
        case 'esperar': await page.waitForSelector(sel, { timeout: paso.timeout || 15000 }); break;
        default: throw new Error(`Acción desconocida: ${paso.accion}`);
      }
    }
    return { estado: dryRun ? 'simulada' : 'preparada', detalle: dryRun ? 'Formulario rellenado sin guardar (dry run).' : 'Alta guardada en AimHarder.' };
  } catch (e) {
    const shot = path.join(config.root, 'data', `alta-error-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    return { estado: 'fallida', detalle: `${e.message} (captura: ${shot})` };
  } finally {
    await browser.close();
  }
}
