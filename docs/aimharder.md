# AimHarder: búsqueda de socios y alta por navegador

## 1. Socios (API pública)

La API (`https://api.aimharder.com`, un token por sede) no busca por teléfono. Por eso el servicio descarga los
clientes de las tres sedes con sus tarifas vigentes (`GET /clients?with-current-memberships=true`) y guarda un
índice teléfono → socio en SQLite. Se repite al arrancar y cada 4 horas (unos 7 s por sede).

- Socio = tiene alguna tarifa vigente hoy → la IA no contesta, se etiqueta `socio` y se asigna a su sede.
- Exsocio (ficha sin tarifa vigente) → se trata como lead y se etiqueta `exsocio`.
- Tokens en `.env` (`AIMHARDER_TOKEN_*` y `AIMHARDER_REFRESH_*`). Cuando caducan (la API responde 410) se renuevan
  solos con el refresh token y la pareja nueva se guarda en `data/aimharder-tokens.json`.

Comprobado el 19 nov 2026: Parla 317 socios con tarifa, Getafe 382, Las Rosas 260.

## Horarios y tarifas

`npm run sync-aimharder` regenera `config/horarios.json` desde las clases de AimHarder y avisa si algún precio de
`config/tarifas.json` ya no coincide. Conviene lanzarlo cada vez que se cambie el horario (o programarlo semanal).

## 2. Alta por navegador (Playwright)

La API crea fichas, pero no la tarifa con fecha de inicio, el primer pago prorrateado ni el descuento. Por eso
el alta se hace en el panel (`https://<sede>.aimharder.com/clients?new`) con un navegador sin pantalla.

**Mapeado el 20 nov 2026 sobre el panel real** (`config/aimharder-alta.json`):

1. Ficha: nombre y apellidos, nacimiento, móvil, email, fecha de alta (hoy), origen (Instagram/Facebook) y una nota.
2. Tarifa, con las mismas funciones del botón «Nueva tarifa»: se elige la tarifa por su ID de AimHarder, se pone
   el día de inicio, se pulsa «Calcular prorrateo» y se marca **pago pendiente**. El sistema comprueba que el
   prorrateo de AimHarder coincide con el suyo (probado: Academy 3 días en Las Rosas desde el 23 nov → 28 €).
3. Guardar: el panel envía ficha y tarifa juntas; con email, AimHarder manda la invitación a la app.

Probado en seco sobre el formulario de Las Rosas, sin guardar. Falta:

- **Usuario y contraseña** de un usuario del panel solo para esto (`AIMHARDER_ADMIN_USER` / `PASSWORD`). Mejor uno
  nuevo con permiso «Sólo altas» que tu cuenta.
- **Descuentos:** hoy el desplegable de descuentos solo tiene «Ninguno». Si se crean descuentos en AimHarder
  (p. ej. de apertura), se pasan por su nombre.
- Primera alta real con `AIMHARDER_ALTA_DRY_RUN=false`, revisándola en el panel.

Instalar en el VPS:

```sh
npm i playwright
npx playwright install --with-deps chromium
```

Si un alta falla, se guarda una captura en `data/` y el equipo recibe los datos por Telegram para hacerla a mano.
