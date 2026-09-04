#!/usr/bin/env bash
# Funds the regtest stack: mines coins, funds both LND wallets, opens a
# customer -> merchant channel. Idempotent: reruns only top up what is missing.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
ensure_helper_image

wait_for "bitcoind" 120 bcli getblockchaininfo
bcli -named createwallet wallet_name=regtest load_on_startup=true >/dev/null 2>&1 || bcli loadwallet regtest >/dev/null 2>&1 || true
bwallet() { bcli -rpcwallet=regtest "$@"; }
export -f bwallet
height=$(bcli getblockcount)
if [ "$height" -lt 110 ]; then
  log "mining $((111 - height)) blocks"
  bcli generatetoaddress $((111 - height)) "$(bwallet getnewaddress)" >/dev/null
fi

for node in merchant_lnd customer_lnd; do
  wait_for "$node REST" 240 lnd_rest "$node" GET /v1/getinfo
  wait_for "$node synced" 240 bash -c "lnd_rest $node GET /v1/getinfo | jq_ -e '.synced_to_chain == true'"
done

fund_node() { # fund_node <host> <btc>
  local host="$1" amount="$2"
  local confirmed
  confirmed=$(lnd_rest "$host" GET /v1/balance/blockchain | jq_ -r '.confirmed_balance')
  if [ "${confirmed:-0}" -ge 50000000 ]; then
    log "$host already funded (${confirmed} sat)"
    return
  fi
  local addr
  addr=$(lnd_rest "$host" GET '/v1/newaddress?type=WITNESS_PUBKEY_HASH' | jq_ -r '.address')
  log "funding $host at $addr with $amount BTC"
  bwallet sendtoaddress "$addr" "$amount" >/dev/null
  bcli generatetoaddress 3 "$(bwallet getnewaddress)" >/dev/null
  wait_for "$host funds" 120 bash -c "lnd_rest $host GET /v1/balance/blockchain | jq_ -e '(.confirmed_balance|tonumber) >= 50000000'"
}
fund_node customer_lnd 5
fund_node merchant_lnd 1

merchant_pubkey=$(lnd_rest merchant_lnd GET /v1/getinfo | jq_ -r '.identity_pubkey')
active=$(lnd_rest customer_lnd GET /v1/channels | jq_ -r "[.channels[] | select(.remote_pubkey == \"$merchant_pubkey\" and .active == true)] | length")
if [ "${active:-0}" -ge 1 ]; then
  log "customer -> merchant channel already active"
else
  log "connecting customer_lnd to merchant_lnd"
  lnd_rest customer_lnd POST /v1/peers "{\"addr\":{\"pubkey\":\"$merchant_pubkey\",\"host\":\"merchant_lnd:9735\"},\"perm\":true}" >/dev/null || true
  sleep 2
  log "opening a 0.16 BTC channel customer -> merchant (0.03 BTC pushed; regtest max is 0.16777215 without wumbo)"
  lnd_rest customer_lnd POST /v1/channels "{\"node_pubkey_string\":\"$merchant_pubkey\",\"local_funding_amount\":\"16000000\",\"push_sat\":\"3000000\",\"sat_per_vbyte\":\"5\"}" | head -c 400; echo
  sleep 3
  bcli generatetoaddress 6 "$(bwallet getnewaddress)" >/dev/null
  wait_for "channel active" 180 bash -c "lnd_rest customer_lnd GET /v1/channels | jq_ -e '[.channels[] | select(.active == true)] | length >= 1'"
fi
log "regtest funded"
