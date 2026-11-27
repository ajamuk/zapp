# Despliegue automático de Zapp

Al fusionar cambios de código en `main`, GitHub Actions ejecuta los tests. Si pasan y la variable
`DESPLIEGUE_VPS` vale `activo`, solicita el despliegue al VPS mediante el entorno `produccion`.
Actions también permite lanzar el workflow manualmente desde `main`.

El VPS comprueba que el SHA solicitado es el de `main` en `ajamuk/zapp` y descarga ese código por
HTTPS. La cuenta SSH de despliegue solo puede enviar la orden `deploy <SHA>`. No tiene shell,
transferencia de archivos ni reenvío. La clave de host se fija en el workflow a partir de la clave
pública del VPS obtenida por un acceso administrativo ya verificado.

El script crea una release bajo `/opt/codex-hosting/apps/zapp/releases`, instala dependencias y
ejecuta los tests. Conserva los horarios del VPS y usa la clave de Anthropic del servidor para una
prueba de extremo a extremo con GHL simulado y base temporal. Esa prueba consume API de Anthropic.
Cuando están configuradas las altas de AimHarder, verifica que Chromium arranca antes de activar la release.
La configuración real se carga desde `/etc/codex-hosting/zapp.env`, propiedad de root. `DB_PATH`
debe ser absoluto y apuntar fuera de las releases. Las credenciales de aplicación y la base de
producción se quedan en el servidor.

Tras pasar las pruebas, actualiza `current`, reinicia solo `codex-zapp` y comprueba `/health`.
Si el reinicio o la comprobación falla, vuelve a la release previa. `previous` mantiene el enlace
de retorno y `current/.commit` identifica el SHA desplegado. Tras un despliegue correcto se conservan las cinco
releases más recientes (`ZAPP_RELEASES_CONSERVAR`) además de `current` y `previous`, y se borran las demás.
Cada release ocupa unos 75 MB. Las copias de `backups/` no se tocan.

## Configuración del VPS y GitHub

- Instalar `deploy/entrada-ssh.sh` como `/usr/local/bin/zapp-deploy-ssh` y
  `deploy/activar-desde-main.sh` como `/usr/local/sbin/zapp-deploy-main`, ambos propiedad de root.
- La cuenta de sistema `zapp-deploy` usa una clave dedicada en `authorized_keys` con
  `restrict,command="/usr/local/bin/zapp-deploy-ssh"`. En sudoers, permitirle exclusivamente
  `/usr/local/sbin/zapp-deploy-main ""`. El script recibe el SHA por entrada estándar.
- En el entorno GitHub `produccion`, permitido solo desde `main`, guardar `VPS_HOST`, `VPS_USER`,
  `VPS_SSH_KEY`, `VPS_HOST_KEY` y `VPS_PORT` si es distinto de 22. La privada de despliegue va
  directamente al almacén de secretos, nunca al repositorio. Para rotarla, cambiar también su pública
  en la cuenta del VPS.
- Para pausar despliegues, cambiar o borrar `DESPLIEGUE_VPS`. Los tests de GitHub siguen activos.

## Comprobar o volver atrás

Desde el VPS, consultar `readlink -f /opt/codex-hosting/apps/zapp/current`, el fichero
`current/.commit` y `curl -fsS http://127.0.0.1:3200/health`. Verificar también
`https://apps.crossfitmpo.com/zapp/` con una sesión de administración de MetroTools.

Un fallo de la prueba de extremo a extremo deja un registro protegido en
`/opt/codex-hosting/apps/zapp/backups/extremo-*.log`. Si un cambio supera el arranque pero falla
después, pausar los despliegues, volver al directorio apuntado por `previous`, reiniciar
`codex-zapp` y comprobar de nuevo la salud y el panel. La base de datos queda en su ruta persistente.

## Pendiente en el VPS actual

- **El servicio corre como root.** `codex-zapp.service` no tiene `User=`. El servicio, su Chromium y las pruebas del
  despliegue se ejecutan como root. Para cambiarlo, en una ventana autorizada:
  1. Crea un usuario de sistema (`useradd --system --home /opt/metro-setter zapp`).
  2. Dale la carpeta de `DB_PATH` (`chown -R zapp: <carpeta de DB_PATH>`).
  3. Da acceso de lectura a lo que el servicio lee de otras apps: el almacén de tokens de AimHarder, las bases de
     metro-trial-ops y clientes-analytics, el registro de El Cañaveral, el Python de hermes y el modelo de metrito-stt.
  4. Añade al servicio `User=zapp`, `Group=zapp`, `ProtectSystem=strict`, `ReadWritePaths=<carpeta de DB_PATH>`,
     `ProtectHome=true` y `CapabilityBoundingSet=`.
  5. Reinicia y comprueba `/health`, una respuesta en modo prueba, una transcripción y el panel.

  El VPS propio ya funciona así: el contenedor usa el usuario `node`, sin privilegios
  ([vps-propio.md](vps-propio.md)).
- **Cambios en `config/prompt-sofia.md` y `config/negocio.md`.** Solo se copian a la base la primera vez. Después,
  Sofía usa la versión en producción del panel (Ajustes → Instrucciones). Un cambio en esos archivos no llega a
  producción al desplegar: hay que crear la versión en el panel y activarla.
