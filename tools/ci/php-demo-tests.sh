#!/usr/bin/env bash
# Exercise the shipped PHP image and built CSS, using only the testkit wallet.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

image="openreceive-php-demo-test:local"
container=""
cleanup() {
  if [ -n "$container" ]; then docker rm -f "$container" >/dev/null; fi
}
trap cleanup EXIT
docker build -t "$image" -f examples/buttons/server/php-plain/Dockerfile .
container=$(docker run -d --rm -p 127.0.0.1::3008 \
  -e DEMO_WALLET=testkit --tmpfs /data "$image")
port=$(docker port "$container" 3008/tcp | awk -F: '{print $NF}')
export OPENRECEIVE_E2E_BASE_URL="http://127.0.0.1:$port"
export OPENRECEIVE_E2E_STACK=php-plain
ready=false
for ((attempt=0; attempt<60; attempt++)); do
  if curl --fail --silent "$OPENRECEIVE_E2E_BASE_URL/openreceive/rates" >/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
if [ "$ready" != true ]; then
  docker logs "$container"
  exit 1
fi
npx playwright test --config tests/e2e lightning.spec.ts plain-layout.spec.ts \
  --grep '@smoke|plain checkout'
