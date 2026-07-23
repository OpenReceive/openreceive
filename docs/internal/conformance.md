# Conformance

Node and Ruby share exact-money, settlement-authority, NIP-47 paging, token-envelope, and HTTP
vectors under `spec/test-vectors`. The OpenAPI and AsyncAPI contracts define the public route
and verified-event shapes.

Conformance requires: pages no larger than 20; dedupe by payment hash; creation-time scan
ranges; preimage-alone rejection; cross-purpose/tampered token rejection; create response only
after host commit; and replay-safe paid delivery.
