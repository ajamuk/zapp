# Despliegue automático en el VPS

Al fusionar en `main`, GitHub pasa las pruebas y, si van bien, entra al VPS por SSH y ejecuta
[`deploy/desplegar.sh`](../deploy/desplegar.sh). Está **apagado** hasta que lo actives (paso 4).

## Qué hace en el VPS

1. Sube el código de ese commit (un paquete; el VPS no necesita acceso a GitHub).
2. Lo instala en una release nueva: `/opt/codex-hosting/apps/zapp/releases/<fecha>-<commit>`.
3. `npm ci --omit=optional` y `npm test` en el propio VPS.
4. Conserva los horarios del VPS (`config/horarios.json` de la versión en marcha) y su `.env` si lo tiene.
5. `npm run prueba-extremo`: arranca el servicio contra un GHL de mentira con el modelo real. No toca producción;
   gasta unos céntimos de la API de Anthropic en cada despliegue.
6. Solo si todo lo anterior pasa: cambia el enlace `current`, reinicia `codex-zapp` y espera a que `/health` diga
   que está bien (hasta 40 segundos).
7. **Si no responde bien, vuelve a la release anterior** y el despliegue sale en rojo en GitHub.
8. Guarda las 5 últimas releases y borra las más viejas.

No toca la base de datos, `/etc/codex-hosting/zapp.env`, el modo (`MODE`) ni nada de GHL o AimHarder. Los cambios
que solo tocan documentación (`docs/`, `*.md`) no despliegan.

Se niega a desplegar, sin cambiar nada, si:

- `current` es una carpeta de verdad y no un enlace a una release (ver «La primera vez»);
- `DB_PATH` en `zapp.env` no es una ruta absoluta fuera de las releases: la base, los audios, los tokens de
  AimHarder y la copia de horarios viven junto a ella, y con una ruta relativa cada release empezaría vacía.

## Configurarlo (una vez)

### 1. Una clave SSH solo para esto, en el VPS

```sh
ssh-keygen -t ed25519 -N '' -C 'despliegue-zapp-github' -f ~/.ssh/despliegue_zapp
cat ~/.ssh/despliegue_zapp.pub >> ~/.ssh/authorized_keys
cat ~/.ssh/despliegue_zapp        # la clave privada: va al secreto VPS_SSH_KEY y luego se borra de aquí
```

El usuario tiene que poder escribir en `/opt/codex-hosting/apps/zapp`, leer `/etc/codex-hosting/zapp.env` y
reiniciar el servicio: o es `root`, o tiene permiso de `sudo` sin contraseña para `systemctl restart codex-zapp`.

### 2. La huella del servidor

Desde tu ordenador (así GitHub solo se conecta a tu VPS y no a otro que se haga pasar por él):

```sh
ssh-keyscan -t ed25519 <host-del-vps>
```

### 3. Secretos en GitHub

En el repositorio: Settings → Secrets and variables → Actions → *New repository secret*.

| Secreto | Valor |
| --- | --- |
| `VPS_HOST` | Dirección del VPS |
| `VPS_USER` | Usuario SSH |
| `VPS_SSH_KEY` | La clave privada del paso 1, entera |
| `VPS_HOST_KEY` | La línea que devuelve `ssh-keyscan` en el paso 2 |
| `VPS_PORT` | Solo si el SSH no va por el puerto 22 |

### 4. Encenderlo

En la misma página, pestaña *Variables* → *New repository variable*: `DESPLIEGUE_VPS` = `activo`.
Para apagarlo, borra la variable o cámbiale el valor: las pruebas siguen pasando, pero no se despliega.

### 5. (Opcional) Pedir confirmación antes de cada despliegue

El despliegue usa el entorno `produccion` de GitHub. En Settings → Environments → `produccion` puedes marcar
*Required reviewers*: cada despliegue espera entonces a que alguien pulse «Approve».

## La primera vez

Comprueba en el VPS cómo está `current`:

```sh
ls -ld /opt/codex-hosting/apps/zapp/current
grep DB_PATH /etc/codex-hosting/zapp.env
```

- Si `current` es un enlace (`current -> …`) y `DB_PATH` es una ruta absoluta fuera de `releases/`, no hay nada que hacer.
- Si `current` es una carpeta, conviértela una vez, con el servicio parado un momento:

```sh
cd /opt/codex-hosting/apps/zapp && systemctl stop codex-zapp
mkdir -p releases && mv current releases/inicial && ln -s releases/inicial current
systemctl start codex-zapp && curl -s localhost:3200/health
```

  Si `DB_PATH` apuntaba dentro de esa carpeta, actualiza antes su ruta en `zapp.env` (o mueve `data/` fuera).

## Lanzarlo a mano y volver atrás

- **Desplegar sin fusionar nada**: Actions → «Desplegar en el VPS» → *Run workflow* (rama `main`).
- **Volver a una versión anterior** en el VPS:

```sh
ls /opt/codex-hosting/apps/zapp/releases
ln -sfn /opt/codex-hosting/apps/zapp/releases/<la-que-quieras> /opt/codex-hosting/apps/zapp/current
systemctl restart codex-zapp
```

- **Si un despliegue sale en rojo**: el registro del paso «Enviar el código y desplegar» dice en qué punto falló.
  Antes del cambio de versión no se ha tocado nada en marcha; después, ya se ha vuelto solo a la anterior.
