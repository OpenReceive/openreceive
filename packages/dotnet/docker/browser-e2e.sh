#!/usr/bin/env bash
# Runs the Playwright browser suite (tests/e2e-btcpay) INSIDE the official Playwright
# image on the stack's network, so Chromium never has to exist on the host.
# Pass --host to run with the host's node_modules/browsers instead.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
PW_VERSION=$(node -e 'console.log(require("/dev/stdin").devDependencies["@playwright/test"].replace(/^[^0-9]*/, ""))' < "$REPO_ROOT/package.json" 2>/dev/null || echo "1.62.1")
KEY="${OPENRECEIVE_BTCPAY_API_KEY:-$( [ -f "$HERE/.state/e2e-store" ] && awk '{print $2}' "$HERE/.state/e2e-store" || true)}"
if [ "${1:-}" = "--host" ]; then
  cd "$REPO_ROOT" && OPENRECEIVE_BTCPAY_API_KEY="$KEY" npx playwright test --config tests/e2e-btcpay/playwright.config.ts "${@:2}"
  exit $?
fi
ensure_helper_image
docker run --rm --network "$NETWORK" --ipc=host \
  -v "$REPO_ROOT":/work -w /work \
  -e OPENRECEIVE_BTCPAY_URL=http://btcpayserver:49392 \
  -e OPENRECEIVE_BTCPAY_API_KEY="$KEY" \
  -e OPENRECEIVE_E2E_TESTKIT_URL=http://testkit-nwc:7790 \
  -e OPENRECEIVE_E2E_TESTKIT_SPEND_URL=http://testkit-nwc-spend:7790 \
  -e OPENRECEIVE_E2E_FAKELSC_URL=https://fake-lsc:7788 \
  -e OPENRECEIVE_E2E_FAKELSC_HOST=fake-lsc:7788 \
  -e OPENRECEIVE_E2E_CUSTOMER_LND_URL=http://customer_lnd:8080 \
  "mcr.microsoft.com/playwright:v${PW_VERSION}-noble" \
  npx playwright test --config tests/e2e-btcpay/playwright.config.ts "$@"
