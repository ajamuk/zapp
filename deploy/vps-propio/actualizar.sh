#!/usr/bin/env bash
# Actualiza Sofía en el VPS propio: construye la imagen de un commit, pasa los tests dentro de ella y la va poniendo
# negocio a negocio. Si un negocio no responde bien con la nueva, vuelve a la anterior y se para ahí.
#
#   deploy/vps-propio/actualizar.sh [commit|rama]          (por defecto origin/main)
#   SOLO="metro boxnorte" deploy/vps-propio/actualizar.sh   (solo esos negocios, p. ej. para probar en uno primero)
#   NAVEGADOR=1 deploy/vps-propio/actualizar.sh             (imagen con Chromium, si algún negocio da altas en AimHarder)
#
# Se ejecuta desde una copia del repositorio en el VPS. No toca los .env, la configuración ni los datos de nadie.
set -euo pipefail

REF="${1:-origin/main}"
BASE="${SOFIA_BASE:-/srv/sofia}"
CONSERVAR="${SOFIA_IMAGENES_CONSERVAR:-5}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

git fetch --quiet origin
COMMIT="$(git rev-parse --verify "$REF^{commit}")"
CORTO="${COMMIT:0:12}"
IMAGEN="sofia:$CORTO"
# La imagen en marcha queda como «respaldo» para volver a ella si un negocio no arranca con la nueva
ANTERIOR=""
if docker image inspect sofia:actual >/dev/null 2>&1; then docker tag sofia:actual sofia:respaldo; ANTERIOR=sofia:respaldo; fi

echo "→ Imagen $IMAGEN"
TMP="$(mktemp -d)"; trap 'rm -rf -- "$TMP"' EXIT
git archive --format=tar "$COMMIT" | tar -x -C "$TMP"
echo "$COMMIT" > "$TMP/.commit"
docker build --pull -q -t "$IMAGEN" --build-arg NAVEGADOR="${NAVEGADOR:-0}" --label "sofia.commit=$COMMIT" "$TMP" >/dev/null

echo "→ Tests dentro de la imagen"
docker run --rm --network none -e NODE_ENV=test "$IMAGEN" npm test --silent > "$TMP/pruebas.log" 2>&1 \
  || { tail -40 "$TMP/pruebas.log"; echo "✘ Fallan los tests: no se actualiza nadie."; exit 1; }
grep -E '^# (tests|pass|fail)' "$TMP/pruebas.log" || true

sano() { # <puerto>
  for _ in $(seq 1 30); do curl -fsS -m 5 "http://127.0.0.1:$1/health" 2>/dev/null | grep -q '"ok":true' && return 0; sleep 2; done
  return 1
}

clientes=()
if [ -n "${SOLO:-}" ]; then for c in $SOLO; do clientes+=("$BASE/clientes/$c"); done
else for d in "$BASE"/clientes/*/; do [ -f "$d/compose.yml" ] && clientes+=("${d%/}"); done; fi
[ "${#clientes[@]}" -gt 0 ] || { echo "No hay negocios en $BASE/clientes."; exit 1; }

for dir in "${clientes[@]}"; do
  id="${dir##*/}"
  puerto="$(grep -oE '127\.0\.0\.1:[0-9]+:3200' "$dir/compose.yml" | cut -d: -f2)"
  echo "→ $id (puerto $puerto)"
  SOFIA_IMAGEN="$IMAGEN" docker compose -f "$dir/compose.yml" up -d --quiet-pull
  if sano "$puerto"; then echo "  ✔ $id responde bien con $CORTO"; continue; fi
  echo "  ✘ $id no responde bien con $CORTO: vuelve a la imagen anterior y se para la actualización."
  docker compose -f "$dir/compose.yml" logs --tail 60 sofia || true
  if [ -n "$ANTERIOR" ]; then SOFIA_IMAGEN="$ANTERIOR" docker compose -f "$dir/compose.yml" up -d && sano "$puerto" && echo "  ↩ $id ha vuelto a la anterior y responde."; fi
  exit 1
done

if [ -n "${SOLO:-}" ]; then
  # Prueba en unos pocos: los demás siguen con «actual». Estos vuelven a «actual» en su próximo `up -d` sin SOFIA_IMAGEN.
  echo "✔ Sofía $CORTO en: $SOLO. Para ponerla en todos: deploy/vps-propio/actualizar.sh $CORTO"
  exit 0
fi
# Todos bien: la nueva pasa a ser «actual» (un `docker compose up -d` posterior no cambia nada)
if [ -n "$ANTERIOR" ]; then docker tag "$ANTERIOR" sofia:anterior; fi
docker tag "$IMAGEN" sofia:actual
echo "✔ Sofía $CORTO en ${#clientes[@]} negocio(s)."

# Limpieza: se conservan las últimas $CONSERVAR imágenes por fecha, además de actual y anterior
docker image ls sofia --format '{{.CreatedAt}}\t{{.Repository}}:{{.Tag}}' | sort -r | cut -f2 \
  | grep -vE ':(actual|anterior|respaldo)$' | tail -n +"$((CONSERVAR + 1))" | xargs -r docker image rm >/dev/null 2>&1 || true
