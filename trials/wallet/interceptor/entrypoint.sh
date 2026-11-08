#!/bin/sh
# Mint the interceptor's server certificate from the trial CA, naming every
# intercepted host, then start the proxy. The certificate stays inside this
# container: the shared certs volume (and the CA every shop trusts) is not
# touched, so fake-lsc and the running shops keep working.
set -eu
mkdir -p /work
cd /work
hosts="${INTERCEPT_HOSTS:?INTERCEPT_HOSTS names the hosts to intercept}"
san=""
for host in $(echo "$hosts" | tr ',' ' '); do
  san="${san:+$san,}DNS:$host"
done
openssl genrsa -out interceptor.key 2048 >/dev/null 2>&1
openssl req -new -key interceptor.key -subj "/CN=openreceive-trial-interceptor" -out interceptor.csr
printf "subjectAltName=%s\nextendedKeyUsage=serverAuth\n" "$san" > interceptor.ext
openssl x509 -req -in interceptor.csr -CA /certs/ca.crt -CAkey /certs/ca.key -CAcreateserial \
  -CAserial /work/ca.srl -out interceptor.crt -days 30 -sha256 -extfile interceptor.ext >/dev/null 2>&1
rm -f interceptor.csr interceptor.ext
exec node /app/interceptor.mjs
