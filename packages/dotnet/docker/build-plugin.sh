#!/usr/bin/env bash
# Builds the plugin INSIDE the .NET SDK container (no host .NET needed) against the
# pinned BTCPay submodule, and drops the output where the compose file bind-mounts
# BTCPay's plugin directory. Restart btcpayserver afterwards (up.sh does).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
CONFIG="${CONFIG:-Release}"
OUT="$HERE/.state/plugins/BTCPayServer.Plugins.OpenReceive"
mkdir -p "$OUT"
[ -f "$DOTNET_DIR/submodules/btcpayserver/BTCPayServer/BTCPayServer.csproj" ] || die "BTCPay submodule missing: run 'git submodule update --init --depth 1 packages/dotnet/submodules/btcpayserver'"
log "building BTCPayServer.Plugins.OpenReceive ($CONFIG) in $SDK_IMAGE"
docker run --rm \
  -v "$REPO_ROOT":/work \
  -v "$NUGET_VOLUME":/root/.nuget \
  -e DOTNET_CLI_TELEMETRY_OPTOUT=1 -e DOTNET_NOLOGO=1 \
  -w /work/packages/dotnet \
  "$SDK_IMAGE" \
  dotnet build BTCPayServer.Plugins.OpenReceive/BTCPayServer.Plugins.OpenReceive.csproj -c "$CONFIG" -nologo -v m \
    -p:BaseIntermediateOutputPath=obj-docker/ -p:BaseOutputPath=bin-docker/ \
    -o /work/packages/dotnet/docker/.state/plugins/BTCPayServer.Plugins.OpenReceive
ls "$OUT" | head -20
log "plugin built into $OUT"
