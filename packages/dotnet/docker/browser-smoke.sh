#!/usr/bin/env bash
# Fresh BTCPay + testkit wallet, Chromium setup/save/reload/checkout, then cleanup.
# Uses no host ports, saved API keys, external wallet, or funded Lightning node.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
PROJECT="openreceive-btcpay-smoke-$$"
NETWORK="${PROJECT}_default"
btcpay_source="${BTCPAY_SERVER_ROOT:-$DOTNET_DIR/submodules/btcpayserver}"
export BTCPAY_DOTNET_ROOT="${BTCPAY_DOTNET_ROOT:-$DOTNET_DIR}"
export BTCPAY_PLUGIN_OUTPUT="$BTCPAY_DOTNET_ROOT/BTCPayServer.Plugins.OpenReceive/bin-docker/Debug/net10.0"
export SDK_IMAGE
smoke_compose() {
  docker compose -p "$PROJECT" -f "$HERE/docker-compose.yml" -f "$HERE/docker-compose.smoke.yml" "$@"
}
cleanup() {
  local result=$?
  trap - EXIT
  if [ "$result" -ne 0 ]; then
    smoke_compose logs --no-color --tail 80 btcpayserver | sed -E 's/secret=[0-9a-fA-F]{64}/secret=[REDACTED]/g' || true
  fi
  docker rm -f "${PROJECT}-browser" "${PROJECT}-build" >/dev/null 2>&1 || true
  smoke_compose down --volumes --remove-orphans || result=1
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

log "building the plugin and test wallet"
docker run --rm --name "${PROJECT}-build" -v "$REPO_ROOT":/work -v "$NUGET_VOLUME":/root/.nuget \
  -v "$BTCPAY_DOTNET_ROOT":/work/packages/dotnet \
  -v "$btcpay_source":/work/packages/dotnet/submodules/btcpayserver \
  -e BTCPAY_SERVER_ROOT=/work/packages/dotnet/submodules/btcpayserver \
  -e DOTNET_CLI_TELEMETRY_OPTOUT=1 -e DOTNET_NOLOGO=1 \
  -w /work/packages/dotnet "$SDK_IMAGE" \
  dotnet build BTCPayServer.Plugins.OpenReceive.slnx -nologo -v q \
    -p:BaseIntermediateOutputPath=obj-docker/ -p:BaseOutputPath=bin-docker/

log "starting an isolated BTCPay browser smoke stack"
smoke_compose up -d btcpayserver testkit-nwc
PW_VERSION=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).packages["node_modules/@playwright/test"].version' "$REPO_ROOT/package-lock.json")
log "running setup/save smoke in Chromium"
docker run --rm --name "${PROJECT}-browser" --network "$NETWORK" --ipc=host \
  -v "$REPO_ROOT":/work -w /work \
  -e OPENRECEIVE_BTCPAY_BOOTSTRAP=1 \
  -e OPENRECEIVE_BTCPAY_URL=http://btcpayserver:49392 \
  -e OPENRECEIVE_E2E_TESTKIT_URL=http://testkit-nwc:7790 \
  "mcr.microsoft.com/playwright:v${PW_VERSION}-noble" \
  npx playwright test --config tests/e2e-btcpay/playwright.config.ts --grep @smoke
