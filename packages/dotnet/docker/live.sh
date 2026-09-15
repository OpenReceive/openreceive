#!/usr/bin/env bash
# Mainnet demo: a remote NWC wallet supplies Lightning; no local chain sync.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose() { docker compose -p openreceive-btcpay-live -f "$HERE/docker-compose.live.yml" "$@"; }
if [ "${1:-}" = "--stop" ]; then
  # Compose needs a value to parse the file; down never runs or pulls this image.
  export BTCPAY_IMAGE=unused
  compose down --remove-orphans
  exit
fi
source "$HERE/refresh-btcpay.sh"
export BTCPAY_DEMO_PLUGIN_DIR="$HERE/.state/plugins"
export BTCPAY_DEMO_PLUGIN_ACCESS=ro
if [ "${1:-}" = "--published" ]; then
  node "$HERE/../../../tools/dotnet/published-plugin.mjs"
  export BTCPAY_DEMO_PLUGIN_DIR="$HERE/.state/published-plugins"
  export BTCPAY_DEMO_PLUGIN_ACCESS=rw
else
  if [ "${1:-}" != "--no-build" ]; then
    bash "$HERE/build-plugin.sh"
  fi
  [ -f "$HERE/.state/plugins/BTCPayServer.Plugins.OpenReceive/BTCPayServer.Plugins.OpenReceive.dll" ] || {
    echo "Plugin build missing; run npm run demo btcpayserver without --no-build." >&2
    exit 1
  }
fi
compose up -d --remove-orphans
# Refresh the loaded assembly after rebuilding an already-running demo.
compose restart btcpayserver
