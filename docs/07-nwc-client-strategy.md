# NWC Client Strategy

OpenReceive depends on Nostr Wallet Connect, but the receive-checkout API is
not a raw NWC proxy.

The first JavaScript path will wrap `getAlby/js-sdk` behind a receive-only
interface. The OpenReceive checkout surface exposes `get_info`, `make_invoice`,
and `lookup_invoice` behavior, plus diagnostics where safe. It does not expose
send-payment methods.

Standalone NWC clients may support `pay_invoice` for general protocol users,
but OpenReceive backend SDKs must hide or refuse spend methods in checkout
APIs.

Every NWC client or adapter needs:

- URI parsing and redaction.
- Capability preflight.
- NIP-04 compatibility.
- NIP-44 v2 support where practical.
- Request and response event shape tests.
- Settlement normalization.
- Error normalization.
- Metadata size enforcement.
- Live wallet smoke tests that skip without `OPENRECEIVE_NWC`.

Crypto dependencies must be documented before an SDK is published. Do not claim
edge, serverless, or mobile-secret support until the crypto and polling
constraints are proven in that runtime.
