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
de retorno y `current/.commit` identifica el SHA desplegado. El workflow conserva las releases
existentes y las copias disponibles para recuperación.

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
