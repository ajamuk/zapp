#!/usr/bin/env bash
# Da de alta un negocio en el VPS propio: su carpeta con configuración, datos, claves y su compose.
#
#   deploy/vps-propio/nuevo-cliente.sh <id> <puerto> <dominio>
#   deploy/vps-propio/nuevo-cliente.sh boxnorte 3202 boxnorte.tudominio.com
#
# Crea $SOFIA_BASE/clientes/<id>/ (por defecto /srv/sofia/clientes/<id>) con:
#   .env         claves generadas, MODE=shadow y PUBLIC_URL del dominio (rellenar GHL, Anthropic…)
#   config/      copia de la configuración de ejemplo del repositorio (instrucciones, negocio, tarifas…)
#   data/        base de datos, audios, copias de seguridad (solo el contenedor escribe aquí)
#   compose.yml  el contenedor del negocio, escuchando solo en 127.0.0.1:<puerto>
#   nginx.conf   bloque de nginx para el dominio (copiar a /etc/nginx/sites-available y pedir el certificado)
# No arranca nada ni toca nginx: lo dice al final. Ver docs/vps-propio.md.
set -euo pipefail

ID="${1:-}"; PUERTO="${2:-}"; DOMINIO="${3:-}"
uso() { echo "Uso: $0 <id> <puerto> <dominio>   (p. ej. $0 boxnorte 3202 boxnorte.tudominio.com)" >&2; exit 1; }
[[ $ID =~ ^[a-z0-9][a-z0-9-]{1,30}$ ]] || { echo "id no válido: minúsculas, números y guiones (2–31)." >&2; uso; }
[[ $PUERTO =~ ^[0-9]{4,5}$ ]] && (( PUERTO >= 1024 && PUERTO <= 65535 )) || { echo "Puerto no válido." >&2; uso; }
[[ $DOMINIO =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || { echo "Dominio no válido." >&2; uso; }

BASE="${SOFIA_BASE:-/srv/sofia}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIR="$BASE/clientes/$ID"
UID_CONTENEDOR="${SOFIA_UID:-1000}"   # usuario «node» de la imagen

[ -e "$DIR" ] && { echo "Ya existe $DIR: no se toca." >&2; exit 1; }
if grep -qs -- "127.0.0.1:$PUERTO:" "$BASE"/clientes/*/compose.yml; then echo "El puerto $PUERTO ya lo usa otro negocio." >&2; exit 1; fi
if command -v ss >/dev/null && ss -ltn "( sport = :$PUERTO )" | grep -q LISTEN; then echo "El puerto $PUERTO ya está ocupado en este servidor." >&2; exit 1; fi

umask 027
mkdir -p "$DIR/data" "$DIR/config"
cp -R "$REPO/config/." "$DIR/config/"

clave() { openssl rand -hex 24; }
# .env a partir del ejemplo: sin rutas ni puerto (los fija compose.yml), con claves nuevas y siempre en modo prueba
grep -vE '^\s*(DB_PATH|PORT|HOST|CONFIG_DIR)\s*=' "$REPO/.env.example" \
  | sed -E \
      -e "s|^MODE=.*|MODE=shadow|" \
      -e "s|^WEBHOOK_SECRET=.*|WEBHOOK_SECRET=$(clave)|" \
      -e "s|^ADMIN_TOKEN=.*|ADMIN_TOKEN=$(clave)|" \
      -e "s|^PUBLIC_URL=.*|PUBLIC_URL=https://$DOMINIO|" \
  > "$DIR/.env"
chmod 600 "$DIR/.env"

cat > "$DIR/compose.yml" <<EOF
# Sofía · $ID. Arrancar: docker compose -f $DIR/compose.yml up -d
name: sofia-$ID
services:
  sofia:
    image: \${SOFIA_IMAGEN:-sofia:actual}
    env_file: .env
    environment:
      DB_PATH: /data/setter.db
      CONFIG_DIR: /config
      HOST: 0.0.0.0
      PORT: "3200"
    volumes:
      - ./data:/data
      - ./config:/config:ro
    ports:
      - "127.0.0.1:$PUERTO:3200"
    restart: unless-stopped
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    mem_limit: 512m
    cpus: 1.0
    stop_grace_period: 75s   # el apagado ordenado espera hasta 60 s a las respuestas en curso
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "5" }
EOF

sed -e "s|{{DOMINIO}}|$DOMINIO|g" -e "s|{{PUERTO}}|$PUERTO|g" -e "s|{{ID}}|$ID|g" "$REPO/deploy/vps-propio/nginx-cliente.conf" > "$DIR/nginx.conf"

if [ "$(id -u)" -eq 0 ]; then chown -R "$UID_CONTENEDOR:$UID_CONTENEDOR" "$DIR/data" "$DIR/config"; fi
chmod 750 "$DIR/data"

cat <<EOF
✔ Negocio «$ID» preparado en $DIR (modo prueba, sin enviar nada a nadie).

Siguientes pasos:
  1. Rellena $DIR/.env (ANTHROPIC_API_KEY, GHL_TOKEN, GHL_LOCATION_ID, Telegram…).
  2. Adapta $DIR/config/ (prompt-sofia.md, negocio.md, negocio.json, tarifas, horarios…).
  3. nginx:  cp $DIR/nginx.conf /etc/nginx/sites-available/sofia-$ID.conf
             ln -s ../sites-available/sofia-$ID.conf /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx
             certbot --nginx -d $DOMINIO
  4. Arranca: docker compose -f $DIR/compose.yml up -d
     Salud:   curl -fsS http://127.0.0.1:$PUERTO/health
  5. Panel:   https://$DOMINIO/panel  (clave: ADMIN_TOKEN de $DIR/.env)
EOF
