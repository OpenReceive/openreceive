#!/bin/sh
# Mints a private CA plus server certificates for the in-network TLS endpoints
# (relay-tls for wss://, fake-lsc for https://). Idempotent: reruns are no-ops.
set -eu
out="${1:-/certs}"
mkdir -p "$out"
if [ -f "$out/ca.crt" ] && [ -f "$out/fake-lsc.pfx" ] && [ -f "$out/relay-tls.crt" ]; then
  echo "certs: already present in $out"
  exit 0
fi
apk add --no-cache openssl >/dev/null
cd "$out"
openssl genrsa -out ca.key 2048 >/dev/null 2>&1
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 -subj "/CN=OpenReceive regtest CA" -out ca.crt
for host in relay-tls fake-lsc; do
  openssl genrsa -out "$host.key" 2048 >/dev/null 2>&1
  openssl req -new -key "$host.key" -subj "/CN=$host" -out "$host.csr"
  printf "subjectAltName=DNS:%s,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n" "$host" > "$host.ext"
  openssl x509 -req -in "$host.csr" -CA ca.crt -CAkey ca.key -CAcreateserial -out "$host.crt" -days 3650 -sha256 -extfile "$host.ext" >/dev/null 2>&1
  rm -f "$host.csr" "$host.ext"
done
openssl pkcs12 -export -out fake-lsc.pfx -inkey fake-lsc.key -in fake-lsc.crt -certfile ca.crt -passout pass:openreceive
chmod 644 ./*.crt ./*.key ./*.pfx
echo "certs: minted CA and server certificates in $out"
