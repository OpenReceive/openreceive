#!/usr/bin/env bash
# Build the solution and run the kernel/vector suite with no host SDK or regtest stack.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

btcpay_source="${BTCPAY_SERVER_ROOT:-$DOTNET_DIR/submodules/btcpayserver}"
[ -f "$btcpay_source/BTCPayServer/BTCPayServer.csproj" ] || die "BTCPay source missing: run 'git submodule update --init --depth 1 packages/dotnet/submodules/btcpayserver' or set BTCPAY_SERVER_ROOT."
btcpay_source="$(cd "$btcpay_source" && pwd)"
command -v docker >/dev/null 2>&1 || die "Docker is required for test:dotnet. Install and start Docker Desktop; no host .NET SDK is needed."
docker info >/dev/null 2>&1 || die "Docker is not available. Start Docker Desktop and retry test:dotnet."

log "building the .NET solution and running unit tests in $SDK_IMAGE"
exec docker run --rm \
  -v "$REPO_ROOT":/work \
  -v "$btcpay_source":/work/packages/dotnet/submodules/btcpayserver \
  -v "$NUGET_VOLUME":/root/.nuget \
  -e BTCPAY_SERVER_ROOT=/work/packages/dotnet/submodules/btcpayserver \
  -e DOTNET_CLI_TELEMETRY_OPTOUT=1 -e DOTNET_NOLOGO=1 \
  -w /work/packages/dotnet \
  "$SDK_IMAGE" \
  sh -ec '
    dotnet build BTCPayServer.Plugins.OpenReceive.slnx -nologo -v q \
      -p:BaseIntermediateOutputPath=obj-docker/ -p:BaseOutputPath=bin-docker/
    dotnet test BTCPayServer.Plugins.OpenReceive.Tests --no-build -nologo -v q \
      -p:BaseIntermediateOutputPath=obj-docker/ -p:BaseOutputPath=bin-docker/ "$@"
  ' dotnet-tests "$@"
