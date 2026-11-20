# AimHarder: búsqueda de socios y alta por navegador

## 1. Socios (API pública)

La API (`https://api.aimharder.com`, un token por sede) no busca por teléfono. Por eso el servicio descarga los
clientes de las tres sedes con sus tarifas vigentes (`GET /clients?with-current-memberships=true`) y guarda un
índice teléfono → socio en SQLite. Se repite al arrancar y cada 4 horas (unos 7 s por sede).

- Socio = tiene alguna tarifa vigente hoy → la IA no contesta, se etiqueta `socio` y se asigna a su sede.
- Exsocio (ficha sin tarifa vigente) → se trata como lead y se etiqueta `exsocio`.
- En el VPS se comparten los tokens de las demás apps: `AIMHARDER_TOKEN_STORE=/etc/aimharder-mcp.tokens.json`.
  Ese fichero lo renueva cada hora un cron central (`aimharder-refresh-tokens.py`), que lo copia al resto de apps.
  Sofía lo relee antes de cada petición y nunca renueva: si lo hiciera, la pareja nueva dejaría fuera a las demás.
  El límite de peticiones de AimHarder probablemente es por centro o por IP, así que se comparte igualmente.
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

## Procedimiento de alta (20 nov 2026)

1. **Datos**: nombre y apellidos, fecha de nacimiento, teléfono y email. Sofía pide solo el que falte. Edad mínima 16 años.
2. **Confirmación**: sede, tarifa y fecha de inicio confirmadas por el lead. Sin matrícula ni promociones.
3. **Ficha**: nueva o, si es antiguo socio en esa sede (índice por teléfono), la suya. Si `/api/checkmail` dice que el email ya existe y no tenemos su ficha, se pasa al equipo para no duplicar.
4. **Forma de pago**: `#clformapago` = 4 (Pago automático con TPV RedSys). Tras guardar se comprueba con `GET /api/client/{id}`.
5. **Tarifa**: AimHarder calcula el prorrateo. Primer recibo manual y pendiente.
6. **Emisión**: en `/payments`, `fichaPago(id)` → `#pgDesde` = hoy → `guardarPago`. Se comprueba con `GET /api/pendingPayments?clientId=` que `since` = hoy. El importe pendiente verificado es el que se da al lead.
7. **Antiguo socio**: `POST /api/inviteClient {clid, clmail, box}` y se comprueba `state == 1`. El nuevo recibe la invitación al guardar.
8. **Aviso al lead** (salvo `avisar_lead: false`): sede, fecha de inicio, correo y app (o recuperar contraseña), y firmar documentos y pagar el primer recibo en la app con el importe verificado. Se comprueba que GHL devuelve el id de cada mensaje; si no, aviso al equipo.
9. **Nunca** se firma por el lead ni se marca un pago como pagado.

El `box` de cada sede se lee del propio panel (Parla: 9146).
