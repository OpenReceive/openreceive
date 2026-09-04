#!/usr/bin/env bash
# Pays a BOLT11 from customer_lnd (the payer node) through LND's router API.
#   ./pay.sh <bolt11>
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
BOLT11="${1:-}"; [ -n "$BOLT11" ] || die "usage: pay.sh <bolt11>"
ensure_helper_image
lnd_rest customer_lnd POST /v2/router/send "{\"payment_request\":\"$BOLT11\",\"timeout_seconds\":60,\"fee_limit_sat\":1000}" | tail -n 1 | jq_ -c '{status: .result.status, failure_reason: .result.failure_reason, fee_sat: .result.fee_sat}'
