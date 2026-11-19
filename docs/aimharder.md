# AimHarder: búsqueda de socios y alta por navegador

## 1. Búsqueda por teléfono (API)

Sirve para separar socios de leads antes de que conteste la IA.

- `AIMHARDER_API_URL`: endpoint de búsqueda de clientes. El sistema llama a `GET <url>?phone=<teléfono>`
  con `Authorization: Bearer <AIMHARDER_API_KEY>`.
- Se espera una lista de clientes (o `{ clients: [...] }`). Se considera socio a quien tenga `active: true`
  (o `status: "active"`). Si la API de AimHarder usa otros nombres de campo, se ajusta en
  `src/aimharder/index.js` (función `buscarSocioPorTelefono`), 10 líneas.
- Sin configurar, todo el mundo se trata como lead.

**Pendiente:** pasar la URL real de búsqueda y un ejemplo de respuesta (puede salir del pipeline de
reconciliación AimHarder–GHL que ya existe).

## 2. Alta por navegador (Playwright)

La API crea socios, pero no con la fecha de inicio, las condiciones y los descuentos que hacen falta.
Por eso el alta se hace rellenando el panel de administración con un navegador sin pantalla.

Instalar en el VPS:

```sh
npm i playwright
npx playwright install --with-deps chromium
```

Grabar los pasos una vez:

1. En un ordenador con pantalla: `npx playwright codegen <URL del panel de AimHarder>`.
2. Hacer un alta de prueba completa (cliente de prueba): login, nuevo cliente, datos, tarifa, fecha de inicio, descuento, guardar.
3. Copiar los selectores que genera codegen a `config/aimharder-alta.json` (un paso por campo) y los nombres
   exactos de las tarifas y descuentos de AimHarder en `tarifas` y `descuentos`.
4. Poner `"configurado": true`.
5. Probar con `AIMHARDER_ALTA_DRY_RUN=true`: rellena todo pero no pulsa Guardar.

Mientras no esté configurado, cuando un lead da sus datos el equipo recibe por Telegram un aviso con todo
(nombre, email, nacimiento, sede, tarifa, inicio y primer recibo) para hacer el alta a mano.

Si un alta falla, se guarda una captura de pantalla en `data/` y se avisa al equipo.
