#!/usr/bin/env bash
# Stops the stack. Pass --volumes to also wipe chain, wallets, relay and BTCPay data.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
if [ "${1:-}" = "--volumes" ]; then compose down --volumes --remove-orphans; else compose down --remove-orphans; fi
