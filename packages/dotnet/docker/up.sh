#!/usr/bin/env bash
# One command from nothing to a running, funded regtest BTCPay with the plugin loaded.
#   ./up.sh            build + start everything, fund, install plugin
#   ./up.sh --no-build skip the plugin/testkit builds (restart with what is there)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
BUILD=1
[ "${1:-}" = "--no-build" ] && BUILD=0
mkdir -p "$HERE/.state/plugins"
if [ "$BUILD" = 1 ]; then
  "$HERE/build-plugin.sh"
  log "building testkit-nwc and fake-lsc images"
  compose build testkit-nwc fake-lsc
fi
log "starting the stack"
compose up -d --remove-orphans
"$HERE/regtest-fund.sh"
compose restart btcpayserver >/dev/null
wait_for "BTCPay" 240 sh -c "curl -sf $BTCPAY_URL/api/v1/health | grep -q synchronized"
ensure_helper_image
wait_for "testkit-nwc" 180 sh -c "docker run --rm --network $NETWORK $HELPER_IMAGE curl -sf http://testkit-nwc:7790/health"
wait_for "fake-lsc" 120 sh -c "docker run --rm --network $NETWORK $HELPER_IMAGE curl -skf https://fake-lsc:7788/__testkit/health"
echo
log "BTCPay:      $BTCPAY_URL   (register the first user: it becomes admin)"
log "NWC code:    curl -s http://127.0.0.1:17790/uri"
log "LSC URI:     curl -sk 'https://127.0.0.1:17788/__testkit/lsc-uri?host=fake-lsc:7788'"
log "logs:        docker compose -p $PROJECT logs -f btcpayserver testkit-nwc fake-lsc"
