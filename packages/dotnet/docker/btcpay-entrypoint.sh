#!/usr/bin/env bash
# Trust the stack's private CA (the NWC relay is wss:// behind it) before handing
# over to the official BTCPay entrypoint.
set -e
if [ -f /certs/ca.crt ]; then
  cp /certs/ca.crt /usr/local/share/ca-certificates/openreceive-ca.crt
  update-ca-certificates >/dev/null 2>&1 || true
fi
mkdir -p /root/.btcpayserver/Plugins
exec /app/docker-entrypoint.sh "$@"
