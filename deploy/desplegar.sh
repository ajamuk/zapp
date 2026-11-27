#!/usr/bin/env bash
# Despliegue de ZAPP en el VPS. Lo llama activar-desde-main.sh, o a mano:
#   bash desplegar.sh /tmp/zapp-<commit>.tgz <commit>
# Instala el código en una release nueva, la valida y solo entonces cambia `current` y reinicia el servicio.
# Si el servicio no arranca bien con la release nueva, vuelve a la anterior. No toca la base de datos ni el .env.
set -euo pipefail

PAQUETE="${1:?Falta la ruta del paquete (.tgz)}"
COMMIT="${2:?Falta el commit}"
APP="${ZAPP_APP:-/opt/codex-hosting/apps/zapp}"
ENV_FILE="${ZAPP_ENV:-/etc/codex-hosting/zapp.env}"
SERVICIO="${ZAPP_SERVICIO:-codex-zapp}"
SALUD="${ZAPP_SALUD:-http://127.0.0.1:3200/health}"

[[ "$COMMIT" =~ ^[0-9a-f]{7,40}$ ]] || { echo "Commit no válido: $COMMIT"; exit 1; }
[ -f "$PAQUETE" ] || { echo "No existe el paquete $PAQUETE"; exit 1; }
[ -f "$ENV_FILE" ] || { echo "No existe $ENV_FILE: sin él el servicio no tiene claves ni base de datos."; exit 1; }
umask 022
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo -n"
reiniciar() { if [ -n "${ZAPP_REINICIAR:-}" ]; then bash -c "$ZAPP_REINICIAR"; else $SUDO systemctl restart "$SERVICIO"; fi; }
sano() { for _ in $(seq 1 20); do curl -fsS -m 5 "$SALUD" 2>/dev/null | grep -q '"ok":true' && return 0; sleep 2; done; return 1; }
valor() { grep -E "^\s*$1\s*=" "$ENV_FILE" | tail -1 | sed -E "s/^\s*$1\s*=\s*//; s/^[\"']|[\"']\s*$//g" || true; }

ACTUAL="$APP/current"
# `current` tiene que ser un enlace a una release: si es una carpeta de verdad, cambiarla aquí podría llevarse datos
if [ -e "$ACTUAL" ] && [ ! -L "$ACTUAL" ]; then
  echo "✘ $ACTUAL es una carpeta, no un enlace. Conviértela una vez a mano (ver docs/despliegue.md) y vuelve a lanzar."; exit 1
fi
# La base, los audios, los tokens y los horarios viven junto a DB_PATH: tiene que estar fuera de las releases
DB="$(valor DB_PATH)"
case "$DB" in
  /*) case "$(realpath -m -- "$DB")" in "$APP"/releases/*|"$APP"/current/*) echo "✘ DB_PATH está dentro de una release: muévela fuera antes de desplegar."; exit 1;; esac ;;
  *) echo "✘ DB_PATH en $ENV_FILE tiene que ser una ruta absoluta fuera de las releases (ahora: «${DB:-vacío}»): si no, cada despliegue empezaría con una base vacía."; exit 1 ;;
esac

ANTERIOR="$(readlink -f "$ACTUAL" 2>/dev/null || true)"
NUEVA=$(mktemp -d "$APP/releases/$(date -u +%Y%m%dT%H%M%SZ)-${COMMIT:0:7}-XXXXXX")
echo "→ Release nueva: $NUEVA (ahora en marcha: ${ANTERIOR:-ninguna})"
chmod 755 "$NUEVA"
trap 'echo "✘ El despliegue ha fallado antes de cambiar nada en marcha: se borra $NUEVA"; rm -rf "$NUEVA"' ERR
tar -xzf "$PAQUETE" -C "$NUEVA"
echo "$COMMIT" > "$NUEVA/.commit"
cd "$NUEVA"

echo "→ Dependencias"
npm ci --include=optional --no-audit --no-fund
if [ -n "$(valor AIMHARDER_ADMIN_USER)" ] && [ -n "$(valor AIMHARDER_ADMIN_PASSWORD)" ]; then
  echo '→ Chromium para las altas de AimHarder'
  ./node_modules/.bin/playwright install chromium
  node --input-type=module -e "import { chromium } from 'playwright'; const browser = await chromium.launch(); await browser.close();"
fi
echo "→ Pruebas"
npm test > pruebas.log 2>&1 || { tail -40 pruebas.log; echo "✘ Las pruebas fallan en el VPS."; false; }
grep -E '^# (tests|pass|fail)' pruebas.log || true

# Horarios propios del VPS (README): se conservan los de la versión en marcha
if [ -n "$ANTERIOR" ] && [ -f "$ANTERIOR/config/horarios.json" ] && ! cmp -s "$ANTERIOR/config/horarios.json" config/horarios.json; then
  cp config/horarios.json config/horarios.repo.json
  cp "$ANTERIOR/config/horarios.json" config/horarios.json
  echo "→ Se conservan los horarios del VPS (los del repositorio quedan en config/horarios.repo.json)"
fi

if [ "${ZAPP_SIN_PRUEBA_EXTREMO:-}" = "1" ]; then echo "→ Prueba de extremo a extremo: omitida (ZAPP_SIN_PRUEBA_EXTREMO=1)"
else
  echo "→ Prueba de extremo a extremo (modelo real, GHL de mentira; no toca producción)"
  CLAVE="$(valor ANTHROPIC_API_KEY)"
  [ -n "$CLAVE" ] || { echo "✘ Falta ANTHROPIC_API_KEY en $ENV_FILE para la prueba de extremo a extremo."; false; }
  install -m 600 /dev/null extremo.log
  ANTHROPIC_API_KEY="$CLAVE" AI_MODEL="$(valor AI_MODEL)" npm run --silent prueba-extremo > extremo.log 2>&1 || {
    echo "✘ Falló la prueba de extremo a extremo. Revisa el registro protegido de la release en el VPS."
    mkdir -p "$APP/backups"
    mv extremo.log "$APP/backups/extremo-${NUEVA##*/}.log"
    false
  }
  echo '✔ Pasó la prueba de extremo a extremo.'
fi
trap - ERR

echo "→ Cambio de versión y reinicio"
ln -sfn "$NUEVA" "$ACTUAL.nuevo" && mv -Tf "$ACTUAL.nuevo" "$ACTUAL"
if reiniciar && sano; then
  if [ -n "$ANTERIOR" ] && [ -d "$ANTERIOR" ]; then
    ln -sfn "$ANTERIOR" "$APP/previous.nuevo" && mv -Tf "$APP/previous.nuevo" "$APP/previous"
  fi
  echo "✔ Desplegado $COMMIT y el servicio responde bien."
  # Releases antiguas: cada una ocupa unos 75 MB y se acumulaban sin límite. Se conservan las más recientes
  # (ZAPP_RELEASES_CONSERVAR, 5 por defecto), además de `current` y `previous`, que nunca se borran.
  CONSERVAR="${ZAPP_RELEASES_CONSERVAR:-5}"
  PREVIA="$(readlink -f "$APP/previous" 2>/dev/null || true)"
  if [[ $CONSERVAR =~ ^[0-9]+$ ]] && [ "$CONSERVAR" -ge 2 ]; then
    find "$APP/releases" -mindepth 1 -maxdepth 1 -type d -name '20*' -printf '%f\n' | sort -r | tail -n +"$((CONSERVAR + 1))" \
      | while IFS= read -r vieja; do
          [ "$APP/releases/$vieja" = "$NUEVA" ] || [ "$APP/releases/$vieja" = "$PREVIA" ] && continue
          rm -rf -- "${APP:?}/releases/$vieja"
        done
  fi
else
  echo "✘ El servicio no responde bien con la release nueva."
  if [ -n "$ANTERIOR" ] && [ -d "$ANTERIOR" ]; then
    ln -sfn "$ANTERIOR" "$ACTUAL.nuevo" && mv -Tf "$ACTUAL.nuevo" "$ACTUAL"
    if reiniciar && sano; then echo "↩ Se ha vuelto a la versión anterior ($ANTERIOR) y responde bien."; else echo "✘✘ Tampoco responde la anterior: hay que entrar al VPS (journalctl -u $SERVICIO -n 100)."; fi
  fi
  exit 1
fi
