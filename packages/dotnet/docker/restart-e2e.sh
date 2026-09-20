#!/usr/bin/env bash
# Restart proof against the running regtest stack: an invoice paid while BTCPay is DOWN
# must show as Settled after BTCPay comes back. Run e2e.sh once first (it creates the
# store this script reuses).
#   ./restart-e2e.sh                paid while down, restart, expect Settled
#   ./restart-e2e.sh --failed-scan  the same, but the relay is also down when BTCPay
#                                   starts, so the first history scans FAIL; the invoice
#                                   must stay New (never Expired/Invalid), and settle once
#                                   the relay is back
#   ./restart-e2e.sh --manual       pause before each step so an operator can do it by hand
#                                   (pay from another wallet, watch the BTCPay UI, …)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ensure_helper_image
FAILED_SCAN=0; MANUAL=0
for arg in "$@"; do
  case "$arg" in
    --failed-scan) FAILED_SCAN=1 ;;
    --manual) MANUAL=1 ;;
    *) die "usage: restart-e2e.sh [--failed-scan] [--manual]" ;;
  esac
done
STATE="$HERE/.state"
[ -f "$STATE/e2e-store" ] || die "no saved store: run ./e2e.sh once first"
read -r STORE APIKEY < "$STATE/e2e-store"
AUTH=(-H "Authorization: token $APIKEY")
api() { # api <method> <path> [json]
  if [ -n "${3:-}" ]; then
    curl -sS -m 30 -X "$1" -H "Content-Type: application/json" "${AUTH[@]}" --data "$3" "$BTCPAY_URL$2"
  else
    curl -sS -m 30 -X "$1" "${AUTH[@]}" "$BTCPAY_URL$2"
  fi
}
status() { api GET "/api/v1/stores/$STORE/invoices/$INVOICE" | jq_ -r '.status'; }
step() { # step <what happens next> <the command that does it>
  log "$1"
  [ "$MANUAL" = 1 ] || return 0
  printf '      by hand: %s\n      press Enter to let the script do it (or do it yourself first, then Enter) ' "$2"
  read -r _
}
btcpay_up() { curl -sf -m 5 "$BTCPAY_URL/api/v1/health" | grep -q synchronized; }

btcpay_up || die "BTCPay is not up at $BTCPAY_URL: run ./up.sh"
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

step "1. make an invoice" "BTCPay UI → Invoices → Create (store $STORE), Lightning only"
INV=$(api POST "/api/v1/stores/$STORE/invoices" '{"amount":"1.75","currency":"USD","checkout":{"paymentMethods":["BTC-LN"]}}')
INVOICE=$(echo "$INV" | jq_ -r '.id'); [ -n "$INVOICE" ] && [ "$INVOICE" != "null" ] || die "invoice creation failed: $INV"
BOLT11=$(api GET "/api/v1/stores/$STORE/invoices/$INVOICE/payment-methods" | jq_ -r '.[] | select(.paymentMethodId=="BTC-LN") | .destination')
[[ "$BOLT11" == lnbcrt* ]] || die "no BTC-LN bolt11 on invoice $INVOICE"
log "   invoice $INVOICE  $BTCPAY_URL/i/$INVOICE"
log "   bolt11  $BOLT11"

step "2. stop BTCPay (the wallet, the relay and the payer stay up)" "docker compose -p $PROJECT stop btcpayserver"
compose stop btcpayserver >/dev/null
! btcpay_up || die "BTCPay still answers after the stop"

step "3. pay the invoice while BTCPay is down" "$HERE/pay.sh <bolt11 above>"
PAY=$(lnd_rest customer_lnd POST /v2/router/send "{\"payment_request\":\"$BOLT11\",\"timeout_seconds\":60,\"fee_limit_sat\":1000}" | tail -n 1)
[ "$(echo "$PAY" | jq_ -r '.result.status')" = "SUCCEEDED" ] || die "payment failed: $PAY"
log "   paid: the wallet holds the money, BTCPay has not seen it"

if [ "$FAILED_SCAN" = 1 ]; then
  step "3b. stop the relay, so the first scans after the restart fail" "docker compose -p $PROJECT stop relay"
  compose stop relay >/dev/null
fi

step "4. start BTCPay" "docker compose -p $PROJECT start btcpayserver"
compose start btcpayserver >/dev/null
wait_for "BTCPay" 240 btcpay_up

if [ "$FAILED_SCAN" = 1 ]; then
  log "5. relay still down: the invoice must wait, not close"
  sleep 25
  S=$(status); log "   invoice status with the relay down: $S"
  [ "$S" = "New" ] || die "a failed scan changed the invoice to $S"
  step "5b. start the relay" "docker compose -p $PROJECT start relay"
  compose start relay >/dev/null
fi

# BTCPay re-polls every monitored invoice when its listener (re)starts; after a failed
# start it retries on its own one-minute connection check, so allow a few of those.
log "6. wait for BTCPay to record the payment it missed"
S=""
for _ in $(seq 1 240); do
  S=$(status); [ "$S" = "Settled" ] && break
  sleep 1
done
log "   invoice status: $S"
log "   what the plugin and BTCPay logged:"
compose logs --since "$STARTED_AT" btcpayserver 2>/dev/null \
  | grep -E "Payment detected|nwc\.(scan|sweep|listen|notification)\.(failed|recovered|truncated|start|settled)|Error while contacting|Could reconnect" \
  | sed -E 's/secret=[0-9a-f]{64}/secret=[REDACTED]/g' | tail -n 15 || true
[ "$S" = "Settled" ] || die "paid while BTCPay was down, and still $S after the restart"
log "RESTART E2E PASSED — invoice $INVOICE paid while BTCPay was down is Settled$([ "$FAILED_SCAN" = 1 ] && echo ' (first scans failed, then recovered)')"
