#!/usr/bin/env bash
# Builds the plugin INSIDE the .NET SDK container (no host .NET needed) against the
# pinned BTCPay submodule, and drops the output where the compose file bind-mounts
# BTCPay's plugin directory. Restart btcpayserver afterwards (up.sh does).
#
# The bundle is the plugin project's OWN output directory: the plugin assembly plus the
# NuGet dependencies BTCPay does not ship (NNostr and friends). Never `dotnet build -o`
# here: -o is a global property, so every project in the graph — BTCPay Server itself
# and its 130 host assemblies — would land in the plugin directory too.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
CONFIG="${CONFIG:-Release}"
PLUGIN=BTCPayServer.Plugins.OpenReceive
OUT="$HERE/.state/plugins/$PLUGIN"
BUILT="$DOTNET_DIR/$PLUGIN/bin-docker/$CONFIG/net10.0"
[ -f "$DOTNET_DIR/submodules/btcpayserver/BTCPayServer/BTCPayServer.csproj" ] || die "BTCPay submodule missing: run 'git submodule update --init --depth 1 packages/dotnet/submodules/btcpayserver'"
log "building $PLUGIN ($CONFIG) in $SDK_IMAGE"
docker run --rm \
  -v "$REPO_ROOT":/work \
  -v "$NUGET_VOLUME":/root/.nuget \
  -e DOTNET_CLI_TELEMETRY_OPTOUT=1 -e DOTNET_NOLOGO=1 \
  -w /work/packages/dotnet \
  "$SDK_IMAGE" \
  dotnet build "$PLUGIN/$PLUGIN.csproj" -c "$CONFIG" -nologo -v m \
    -p:BaseIntermediateOutputPath=obj-docker/ -p:BaseOutputPath=bin-docker/
[ -f "$BUILT/$PLUGIN.dll" ] || die "no build output at $BUILT"
rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$BUILT/." "$OUT/"
# Host assemblies in a plugin directory are at best dead weight and at worst a second
# copy of BTCPay loaded beside the real one: refuse a bundle that carries any.
if ls "$OUT" | grep -q -E '^BTCPayServer\.(dll|exe|deps\.json|runtimeconfig\.json)$|^BTCPayServer\.(Abstractions|Client|Common|Data)\.dll$|\.runtimeconfig\.json$'; then
  ls "$OUT" | grep -E '^BTCPayServer\.|runtimeconfig' >&2
  die "the plugin bundle contains BTCPay host files; the build must not use -o"
fi
ls "$OUT"
log "plugin built into $OUT ($(ls "$OUT" | wc -l | tr -d ' ') files)"
