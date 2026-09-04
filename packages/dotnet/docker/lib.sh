#!/usr/bin/env bash
# Shared helpers for the regtest stack scripts.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOTNET_DIR="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$DOTNET_DIR/../.." && pwd)"
PROJECT=openreceive-btcpay
NETWORK="${PROJECT}_default"
BTCPAY_URL="${BTCPAY_URL:-http://127.0.0.1:14180}"
SDK_IMAGE="${SDK_IMAGE:-mcr.microsoft.com/dotnet/sdk:10.0}"
NUGET_VOLUME="${NUGET_VOLUME:-btcpay-plugin-nuget}"
compose() { docker compose -p "$PROJECT" -f "$HERE/docker-compose.yml" "$@"; }
log() { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
# Run curl+jq inside the compose network (nothing on the host needs to be installed).
HELPER_IMAGE="${HELPER_IMAGE:-openreceive-regtest-helper:local}"
netcurl() { docker run --rm --network "$NETWORK" "$HELPER_IMAGE" sh -c "$*"; }
jq_() { docker run --rm -i "$HELPER_IMAGE" jq "$@"; }
ensure_helper_image() {
  if ! docker image inspect "$HELPER_IMAGE" >/dev/null 2>&1; then
    log "building helper image (alpine + curl + jq)"
    printf 'FROM alpine:3.20\nRUN apk add --no-cache curl jq bash\n' | docker build -q -t "$HELPER_IMAGE" - >/dev/null
  fi
}
lnd_rest() { # lnd_rest <host> <method> <path> [json-body]
  local host="$1" method="$2" path="$3" body="${4:-}"
  if [ -n "$body" ]; then
    netcurl "curl -sS -m 120 -X $method -H 'Content-Type: application/json' --data '$body' 'http://$host:8080$path'"
  else
    netcurl "curl -sS -m 120 -X $method 'http://$host:8080$path'"
  fi
}
bcli() { compose exec -T bitcoind bitcoin-cli -regtest -rpcuser=ceiwHEbqWI83 -rpcpassword=DwubwWsoo3 -rpcport=43782 "$@"; }
wait_for() { # wait_for <label> <seconds> <command...>
  local label="$1" seconds="$2"; shift 2
  local i=0
  until "$@" >/dev/null 2>&1; do
    i=$((i+1)); [ "$i" -ge "$seconds" ] && die "timed out waiting for $label"
    sleep 1
  done
  log "$label ready"
}
export PROJECT NETWORK HELPER_IMAGE HERE BTCPAY_URL
export -f compose log die netcurl jq_ lnd_rest bcli 2>/dev/null || true
