#!/usr/bin/env bash
# Sourced by up.sh (the regtest stack) and live.sh (the mainnet demo). Both bind BTCPay to
# 127.0.0.1:14180 on purpose — one URL, one login habit — so they cannot run together, and
# without this check the second one fails minutes into its plugin build with Docker's
# "Bind for 127.0.0.1:14180 failed: port is already allocated". Say who holds the port and
# exactly how to stop it, before any work is done.
#   require_btcpay_port_free <compose project of the caller>
require_btcpay_port_free() {
  local project="$1" holder hint
  holder="$(docker ps --filter publish=14180 --format '{{.Names}}' 2>/dev/null | head -n 1)"
  [ -z "$holder" ] && return 0
  case "$holder" in
    "$project-btcpayserver-"*) return 0 ;; # our own stack: compose reuses or restarts it
    openreceive-btcpay-live-btcpayserver-*) hint="npm run demo btcpayserver -- --stop" ;;
    openreceive-btcpay-btcpayserver-*) hint="npm run demo btcpayserver -- --testkit --stop" ;;
    *) hint="docker stop $holder" ;;
  esac
  echo "error: 127.0.0.1:14180 is held by $holder; only one BTCPay stack runs at a time. Stop it first: $hint" >&2
  exit 1
}
