#!/usr/bin/env bash
# Runs the xunit integration project INSIDE the .NET SDK container on the stack's
# network, so nothing but Docker is needed on the host. Assumes up.sh finished.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
docker run --rm \
  --network "$NETWORK" \
  -v "$REPO_ROOT":/work \
  -v "$NUGET_VOLUME":/root/.nuget \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e DOTNET_CLI_TELEMETRY_OPTOUT=1 -e DOTNET_NOLOGO=1 \
  -e OPENRECEIVE_E2E_BTCPAY_URL=http://btcpayserver:49392 \
  -e OPENRECEIVE_E2E_API_KEY="${OPENRECEIVE_E2E_API_KEY:-$( [ -f "$HERE/.state/e2e-store" ] && awk '{print $2}' "$HERE/.state/e2e-store" || true)}" \
  -e OPENRECEIVE_E2E_TESTKIT_URL=http://testkit-nwc:7790 \
  -e OPENRECEIVE_E2E_TESTKIT_SPEND_URL=http://testkit-nwc-spend:7790 \
  -e OPENRECEIVE_E2E_FAKELSC_URL=https://fake-lsc:7788 \
  -e OPENRECEIVE_E2E_FAKELSC_HOST=fake-lsc:7788 \
  -e OPENRECEIVE_E2E_CUSTOMER_LND_URL=http://customer_lnd:8080 \
  -w /work/packages/dotnet \
  "$SDK_IMAGE" \
  dotnet test OpenReceive.IntegrationTests -nologo -v n \
    -p:BaseIntermediateOutputPath=obj-docker/ -p:BaseOutputPath=bin-docker/ "$@"
