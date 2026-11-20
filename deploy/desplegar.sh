#!/usr/bin/env bash
# Se ejecuta en el VPS (lo llama GitHub Actions tras dejar el código en la versión subida).
# No toca .env ni data/: el modo (shadow/live) y las claves siguen como estén en el VPS.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "→ Versión $(git rev-parse --short HEAD)"
npm install --omit=optional --no-audit --no-fund

if pm2 describe metro-setter >/dev/null 2>&1; then pm2 reload metro-setter --update-env
else pm2 start deploy/ecosystem.config.cjs; fi
pm2 save >/dev/null

# Nginx: el bloque del servidor incluye deploy/nginx-locations.conf, así que basta con recargar.
if command -v nginx >/dev/null 2>&1; then
  if [ "$(id -u)" = 0 ]; then nginx -t -q && systemctl reload nginx
  else sudo -n nginx -t -q && sudo -n systemctl reload nginx || echo "⚠ No se pudo recargar Nginx (falta sudo sin contraseña)"; fi
fi

PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2); PORT=${PORT:-3200}
for i in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:$PORT/health"; then echo; echo "✓ Desplegado"; exit 0; fi
  sleep 2
done
echo "✗ El servicio no responde en /health"; pm2 logs metro-setter --lines 40 --nostream; exit 1
