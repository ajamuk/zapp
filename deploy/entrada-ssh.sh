#!/usr/bin/env bash
# Instalar como /usr/local/bin/zapp-deploy-ssh, propiedad de root.
set -euo pipefail

if [[ ${SSH_ORIGINAL_COMMAND:-} =~ ^deploy\ ([a-f0-9]{40})$ ]]; then
  printf '%s\n' "${BASH_REMATCH[1]}" | /usr/bin/sudo -n /usr/local/sbin/zapp-deploy-main
else
  echo 'Esta clave solo puede solicitar un despliegue de Zapp.' >&2
  exit 1
fi
