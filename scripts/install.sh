#!/usr/bin/env bash
# Compatibility shim. Some CDNs cached an old install.sh without --with-db.
# Canonical script: setup-vps.sh
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
if [[ -f "${DIR}/setup-vps.sh" ]]; then
  exec bash "${DIR}/setup-vps.sh" "$@"
fi
echo "Download the current installer:" >&2
echo "  curl -fsSL https://raw.githubusercontent.com/Pelessaria/Agravion-FS25/main/scripts/setup-vps.sh -o setup-vps.sh" >&2
echo "  chmod +x setup-vps.sh && sudo ./setup-vps.sh --help" >&2
exit 1
