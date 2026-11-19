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
