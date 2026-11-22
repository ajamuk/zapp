#!/usr/bin/env bash
# Instalar como /usr/local/sbin/zapp-deploy-main, propiedad de root.
# La conexión solo aporta un SHA. El VPS descarga y verifica el código por HTTPS.
set -euo pipefail
umask 077
export PATH=/usr/bin:/bin

IFS= read -r commit
[[ $commit =~ ^[a-f0-9]{40}$ ]] || exit 1

exec 9>/run/lock/zapp-deploy.lock
flock -w 120 9
temporal=$(mktemp -d /var/tmp/zapp-deploy.XXXXXXXX)
trap 'rm -rf -- "$temporal"' EXIT
git -C "$temporal" init --quiet
git -C "$temporal" fetch --quiet --depth=1 --no-tags https://github.com/ajamuk/zapp.git refs/heads/main
actual=$(git -C "$temporal" rev-parse FETCH_HEAD)
if [[ $actual != "$commit" ]]; then
  echo 'El commit solicitado ya no es el de main. Ejecuta el workflow del commit actual.' >&2
  exit 1
fi

if [[ $(cat /opt/codex-hosting/apps/zapp/current/.commit 2>/dev/null || true) == "$commit" ]] &&
  curl -fsS -m 5 http://127.0.0.1:3200/health | grep -q '"ok":true'; then
  echo "Zapp ya sirve $commit."
  exit 0
fi

git -C "$temporal" archive --format=tar.gz --output="$temporal/zapp.tgz" "$commit"
git -C "$temporal" show "$commit:deploy/desplegar.sh" > "$temporal/desplegar.sh"
bash "$temporal/desplegar.sh" "$temporal/zapp.tgz" "$commit"
