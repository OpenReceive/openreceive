# Conformance

Node and Ruby share exact-money, settlement-authority, NIP-47 paging, and HTTP vectors under
`spec/test-vectors`. The OpenAPI contract defines the public route shapes.

Conformance requires: pages no larger than 20; dedupe by payment hash; creation-time scan
ranges; preimage-alone rejection; create response only after host commit; and replay-safe paid
delivery.
