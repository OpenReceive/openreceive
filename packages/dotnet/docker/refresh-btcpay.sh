#!/usr/bin/env bash
# Sourced by demo startup. Resolve on every run; a lookup or pull failure stops
# startup rather than silently reusing an old image or a stale .env override.
set -euo pipefail
btcpay_docker_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BTCPAY_IMAGE="$(node "$btcpay_docker_dir/../../../tools/dotnet/upstream.mjs")"
export BTCPAY_IMAGE
docker pull "$BTCPAY_IMAGE"
