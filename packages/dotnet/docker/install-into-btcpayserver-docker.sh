#!/usr/bin/env bash
# Installs the plugin into a btcpayserver-docker deployment (the official docker
# stack, e.g. the mainnet one in ../btcpay-dev/btcpayserver-docker): builds the
# Release plugin inside the .NET SDK image, copies it into the BTCPay container's
# plugin directory and restarts the container. Works on a stopped container too.
#   ./install-into-btcpayserver-docker.sh [container]     default: generated_btcpayserver_1
#   NO_BUILD=1 ./install-into-btcpayserver-docker.sh      reuse the last build
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
C="${1:-generated_btcpayserver_1}"
PLUGIN=BTCPayServer.Plugins.OpenReceive
SRC="$HERE/.state/plugins/$PLUGIN"
docker container inspect "$C" >/dev/null 2>&1 || die "container $C not found (is btcpayserver-docker set up?)"
[ "${NO_BUILD:-0}" = 1 ] || "$HERE/build-plugin.sh"
[ -f "$SRC/$PLUGIN.dll" ] || die "no build at $SRC"
# `docker cp` into a STOPPED container does not reach a volume mount, so copy
# through the plugin volume itself (found on the container's mounts).
VOL=$(docker container inspect -f '{{range .Mounts}}{{if eq .Destination "/root/.btcpayserver/Plugins"}}{{.Name}}{{end}}{{end}}' "$C")
[ -n "$VOL" ] || die "$C has no volume mounted at /root/.btcpayserver/Plugins"
log "installing $PLUGIN into volume $VOL (/root/.btcpayserver/Plugins/$PLUGIN in $C)"
docker run --rm -v "$VOL":/p -v "$SRC":/src:ro alpine sh -c "rm -rf /p/$PLUGIN && mkdir -p /p/$PLUGIN && cp -r /src/. /p/$PLUGIN/ && ls /p/$PLUGIN | wc -l" | sed 's/^/  files: /'
if [ "$(docker container inspect -f '{{.State.Running}}' "$C")" = "true" ]; then
  docker restart "$C" >/dev/null && log "restarted $C"
else
  log "$C is stopped; the plugin loads when you start the stack"
fi
log "done. Watch: docker logs -f $C 2>&1 | grep -E 'Plugins.OpenReceive|nwc\.|swap\.'"
