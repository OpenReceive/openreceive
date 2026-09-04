#!/usr/bin/env bash
# End-to-end proof against the running regtest stack (see up.sh), driven purely over
# HTTP: registers the first BTCPay user, creates a store, points its Lightning node at
# the testkit's receive-only NWC code through the plugin's Greenfield API, creates an
# invoice, pays its BOLT11 from customer_lnd, and asserts BTCPay records it as Settled.
# Then turns on swaps with the fake LSC provider and pays an invoice through a swap.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ensure_helper_image
STATE="$HERE/.state"; mkdir -p "$STATE"
EMAIL="${E2E_EMAIL:-e2e@openreceive.test}"
PASSWORD="${E2E_PASSWORD:-OpenReceive-e2e-Passw0rd!}"

api() { # api <method> <path> [json] [extra curl args]
  local method="$1" path="$2" body="${3:-}"; shift 3 2>/dev/null || shift $#
  if [ -n "$body" ]; then
    curl -sS -m 30 -X "$method" -H "Content-Type: application/json" "$@" --data "$body" "$BTCPAY_URL$path"
  else
    curl -sS -m 30 -X "$method" "$@" "$BTCPAY_URL$path"
  fi
}
jqh() { jq_ "$@"; }

APIKEY="${E2E_API_KEY:-}"
if [ -z "$APIKEY" ] && [ -f "$STATE/e2e-store" ]; then
  # A key minted by an earlier run keeps working across BTCPay restarts; BTCPay closes
  # public registration after the first admin and may disable Basic auth, so reuse it.
  APIKEY=$(awk '{print $2}' "$STATE/e2e-store")
  curl -sf -m 10 -H "Authorization: token $APIKEY" "$BTCPAY_URL/api/v1/users/me" >/dev/null || APIKEY=""
fi
if [ -z "$APIKEY" ]; then
  log "1. first user (becomes admin)"
  api POST /api/v1/users "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"isAdministrator\":true}" >/dev/null || true
  log "2. API key"
  APIKEY=$(api POST /api/v1/api-keys '{"label":"e2e","permissions":["unrestricted"]}' -u "$EMAIL:$PASSWORD" | jqh -r '.apiKey')
  [ -n "$APIKEY" ] && [ "$APIKEY" != "null" ] || die "could not create an API key (is BTCPay up and registration allowed? Or export E2E_API_KEY from Account → API keys)"
else
  log "1–2. reusing the saved API key"
fi
AUTH=(-H "Authorization: token $APIKEY")
log "3. store"
STORE=$(api POST /api/v1/stores '{"name":"OpenReceive e2e","defaultCurrency":"USD"}' "${AUTH[@]}" | jqh -r '.id')
[ -n "$STORE" ] && [ "$STORE" != "null" ] || die "could not create a store"
log "   store $STORE"

log "4. NWC code from the testkit wallet"
NWC=$(curl -sS -m 10 http://127.0.0.1:17790/uri)
[[ "$NWC" == nostr+walletconnect://* ]] || die "testkit did not hand out an NWC URI: $NWC"
log "   $(echo "$NWC" | sed -E 's/secret=[0-9a-f]{64}/secret=[REDACTED]/')"

log "5. wallet preflight through the plugin API"
PRE=$(api POST "/api/v1/stores/$STORE/openreceive/wallet/test" "{\"nwcUri\":$(printf '%s' "$NWC" | jqh -R .)}" "${AUTH[@]}")
echo "$PRE" | jqh -c '{ok, code, encryption, notifications, methods, network}'
[ "$(echo "$PRE" | jqh -r '.ok')" = "true" ] || die "preflight refused: $(echo "$PRE" | jqh -r '.message')"

log "6. use it as the store's Lightning node"
SET=$(api PUT "/api/v1/stores/$STORE/openreceive/settings" "{\"nwcUri\":$(printf '%s' "$NWC" | jqh -R .)}" "${AUTH[@]}")
[ "$(echo "$SET" | jqh -r '.lightningNodeIsOpenReceive')" = "true" ] || die "settings did not take: $SET"
echo "$SET" | jqh -c '{lightningNodeIsOpenReceive, lightningNode, invoiceExpirationMinutes}'
LN=$(api GET "/api/v1/stores/$STORE/payment-methods/BTC-LN" "" "${AUTH[@]}")
echo "$LN" | jqh -c '{enabled, connectionString: (.config.connectionString // .config | tostring | sub("secret=[0-9a-f]{64}"; "secret=[REDACTED]"))}'

log "7. invoice"
INV=$(api POST "/api/v1/stores/$STORE/invoices" '{"amount":"2.50","currency":"USD","checkout":{"paymentMethods":["BTC-LN"]}}' "${AUTH[@]}")
INVOICE=$(echo "$INV" | jqh -r '.id'); [ -n "$INVOICE" ] && [ "$INVOICE" != "null" ] || die "invoice creation failed: $INV"
log "   invoice $INVOICE"
PM=$(api GET "/api/v1/stores/$STORE/invoices/$INVOICE/payment-methods" "" "${AUTH[@]}")
BOLT11=$(echo "$PM" | jqh -r '.[] | select(.paymentMethodId=="BTC-LN") | .destination')
[[ "$BOLT11" == lnbcrt* ]] || die "no BTC-LN bolt11 on the invoice: $PM"
log "   bolt11 ${BOLT11:0:40}…"

log "8. pay from customer_lnd"
# LND 0.21 dropped the legacy SendPaymentSync route: use the router API, which streams
# updates until the payment reaches a final state.
PAY=$(lnd_rest customer_lnd POST /v2/router/send "{\"payment_request\":\"$BOLT11\",\"timeout_seconds\":60,\"fee_limit_sat\":1000}" | tail -n 1)
echo "$PAY" | jqh -c '{status: .result.status, failure_reason: .result.failure_reason}'
[ "$(echo "$PAY" | jqh -r '.result.status')" = "SUCCEEDED" ] || die "payment failed: $PAY"

log "9. wait for BTCPay to record the payment"
for i in $(seq 1 40); do
  STATUS=$(api GET "/api/v1/stores/$STORE/invoices/$INVOICE" "" "${AUTH[@]}" | jqh -r '.status')
  [ "$STATUS" = "Settled" ] && break
  sleep 1
done
log "   invoice status: $STATUS"
[ "$STATUS" = "Settled" ] || die "invoice never settled (status $STATUS)"
echo "$STORE $APIKEY" > "$STATE/e2e-store"
chmod 600 "$STATE/e2e-store"

if [ "${E2E_SWAPS:-1}" = "1" ]; then
  log "10. enable swaps with the fake LSC provider"
  LSC=$(curl -sSk -m 10 'https://127.0.0.1:17788/__testkit/lsc-uri?host=fake-lsc:7788' | jqh -r '.uri')
  SWAPSET=$(api PUT "/api/v1/stores/$STORE/openreceive/settings" "{\"lscPrimary\":$(printf '%s' "$LSC" | jqh -R .),\"swapsEnabled\":true}" "${AUTH[@]}")
  echo "$SWAPSET" | jqh -c '{swapsEnabled, lscPrimaryConfigured, invoiceExpirationMinutes}'
  [ "$(echo "$SWAPSET" | jqh -r '.swapsEnabled')" = "true" ] || die "swaps not enabled: $SWAPSET"

  log "11. invoice paid through a USDT (Tron) swap"
  curl -sSk -m 10 -X POST -H 'Content-Type: application/json' --data '{"selector":"USDT_TRON","states":["confirming","exchanging","completed"]}' https://127.0.0.1:17788/__testkit/script >/dev/null
  INV2=$(api POST "/api/v1/stores/$STORE/invoices" '{"amount":"25.00","currency":"USD","checkout":{"paymentMethods":["BTC-LN"]}}' "${AUTH[@]}" | jqh -r '.id')
  SWAP=$(api POST /api/plugins/openreceive/swaps "{\"invoiceId\":\"$INV2\",\"payInAsset\":\"USDT_TRON\"}")
  echo "$SWAP" | jqh -c '{swap_id, state, deposit_address, deposit_amount, provider, expires_in_seconds}'
  SWAPID=$(echo "$SWAP" | jqh -r '.swap_id'); [ -n "$SWAPID" ] && [ "$SWAPID" != "null" ] || die "swap creation failed: $SWAP"
  for i in $(seq 1 60); do
    S=$(api GET "/api/plugins/openreceive/swaps/$INV2/$SWAPID")
    STATE2=$(echo "$S" | jqh -r '.state'); ISTATUS=$(echo "$S" | jqh -r '.invoice_status'); WS=$(echo "$S" | jqh -r '.wallet_settled')
    [ "$ISTATUS" = "Settled" ] && [ "$WS" = "true" ] && break
    sleep 1
  done
  log "   swap state: $STATE2, invoice status: $ISTATUS, wallet_settled: $WS"
  [ "$ISTATUS" = "Settled" ] || die "swap-paid invoice never settled"
  [ "$WS" = "true" ] || die "swap row was not stamped wallet_settled"
  echo "$S" | jqh -c '{state, phase, payout_tx_id, deposit_tx_id, wallet_settled}'

  log "12. refund path (underpaid deposit)"
  curl -sSk -m 10 -X POST -H 'Content-Type: application/json' --data '{"selector":"USDT_TRON","reason":"underpaid"}' https://127.0.0.1:17788/__testkit/force-refund-required >/dev/null
  INV3=$(api POST "/api/v1/stores/$STORE/invoices" '{"amount":"30.00","currency":"USD","checkout":{"paymentMethods":["BTC-LN"]}}' "${AUTH[@]}" | jqh -r '.id')
  SWAP3=$(api POST /api/plugins/openreceive/swaps "{\"invoiceId\":\"$INV3\",\"payInAsset\":\"USDT_TRON\"}"); SWAPID3=$(echo "$SWAP3" | jqh -r '.swap_id')
  for i in $(seq 1 30); do
    S3=$(api GET "/api/plugins/openreceive/swaps/$INV3/$SWAPID3"); [ "$(echo "$S3" | jqh -r '.state')" = "refund_required" ] && break; sleep 1
  done
  echo "$S3" | jqh -c '{state, refund_reason}'
  [ "$(echo "$S3" | jqh -r '.state')" = "refund_required" ] || die "refund_required never reached"
  BAD=$(api POST "/api/plugins/openreceive/swaps/$INV3/$SWAPID3/refund" '{"refundAddress":"TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBg"}')
  echo "$BAD" | jqh -c '{code, message}'
  [ "$(echo "$BAD" | jqh -r '.code')" = "invalid_refund_address" ] || die "bad checksum accepted"
  GOOD=$(api POST "/api/plugins/openreceive/swaps/$INV3/$SWAPID3/refund" '{"refundAddress":"TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf"}')
  echo "$GOOD" | jqh -c '{state, refund_address, refund_reason}'
  [ "$(echo "$GOOD" | jqh -r '.state')" = "refund_pending" ] || die "refund not accepted"
  log "   merchant view:"; api GET "/api/v1/stores/$STORE/openreceive/invoices/$INV3/swaps" "" "${AUTH[@]}" | jqh -c '.[] | {state, refundReason, refundAddress}'
fi
log "13. a spend-capable code is refused unless the override is ticked"
SPEND=$(curl -sS -m 10 http://127.0.0.1:17791/uri)
R1=$(api POST "/api/v1/stores/$STORE/openreceive/wallet/test" "{\"nwcUri\":$(printf '%s' "$SPEND" | jqh -R .)}" "${AUTH[@]}")
echo "$R1" | jqh -c '{ok, code, spendMethods}'
[ "$(echo "$R1" | jqh -r '.code')" = "spend_capability_advertised" ] || die "spend-capable code was not refused"
R2=$(api POST "/api/v1/stores/$STORE/openreceive/wallet/test" "{\"nwcUri\":$(printf '%s' "$SPEND" | jqh -R .),\"allowSpendCapableWallet\":true}" "${AUTH[@]}")
echo "$R2" | jqh -c '{ok, code}'
[ "$(echo "$R2" | jqh -r '.ok')" = "true" ] || die "override did not admit the spend-capable code"
# Saving it through BTCPay's own Lightning config path must be refused the same way.
R3=$(api PUT "/api/v1/stores/$STORE/payment-methods/BTC-LN" "{\"enabled\":true,\"config\":{\"connectionString\":\"type=openreceive;nwc=$SPEND\"}}" "${AUTH[@]}" -o /dev/null -w '%{http_code}')
log "   BTCPay Greenfield PUT payment-methods/BTC-LN with the spend-capable code -> HTTP $R3 (expected 422)"
[ "$R3" = "422" ] || die "BTCPay accepted a spend-capable OpenReceive connection string"

log "E2E PASSED — BTCPay $BTCPAY_URL, store $STORE, login $EMAIL"
