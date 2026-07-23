# Security

- Keep receive-only NWC and token keys server-side. Scan browser bundles for them.
- Recompute checkout prices from host-owned order/catalog data; reject payer amounts.
- Commit payment hash before exposing the invoice and use a host-row compare-and-set for
  retries/concurrency.
- Accept settlement only from `settled_at` or wallet state `settled`; a preimage is not final
  proof and notifications are only hints.
- Make `paid_at` and fulfillment idempotent because `onPaid` is at-least-once.
- Treat capability and recovery tokens as secrets. Rotate with a keyring: current key first,
  old decrypt-only keys after it.
- Never expose plaintext swap provider credentials. Provider completion alone does not fulfill
  an order; wallet settlement does.
