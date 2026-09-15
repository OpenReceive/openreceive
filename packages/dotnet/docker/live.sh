#!/usr/bin/env bash
# Mainnet demo: a remote NWC wallet supplies Lightning; no local chain sync.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose() { docker compose -p openreceive-btcpay-live -f "$HERE/docker-compose.live.yml" "$@"; }
if [ "${1:-}" = "--stop" ]; then
  compose down --remove-orphans
  exit
fi
if [ "${1:-}" != "--no-build" ]; then
  bash "$HERE/build-plugin.sh"
fi
[ -f "$HERE/.state/plugins/BTCPayServer.Plugins.OpenReceive/BTCPayServer.Plugins.OpenReceive.dll" ] || {
  echo "Plugin build missing; run npm run demo btcpayserver without --no-build." >&2
  exit 1
}
compose up -d --remove-orphans
# Refresh the loaded assembly after rebuilding an already-running demo.
compose restart btcpayserver
