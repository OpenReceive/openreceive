# Security

- Keep receive-only NWC and payment-attempt `swap_data` server-side. Scan browser bundles for them.
- Wallet preflight fails closed when the NWC connection advertises spend methods such as
  `pay_invoice`: a leaked spend-capable code lets an attacker drain the wallet, so OpenReceive
  refuses to boot with one. Mint a receive-only code. If the wallet cannot and you accept the
  risk, the explicit override is `allowSpendCapableWallet: true`
  (Rails: `config.allow_spend_capable_wallet = true`) or
  `OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=true`; OpenReceive still logs a loud warning.
- Recompute checkout prices from host-owned order/catalog data; reject payer amounts.
- The attempt row commits before the invoice is exposed; the library serializes concurrent
  creates per order. Custom `OpenReceivePaymentRepository` implementations must keep that
  guarantee.
- Accept settlement only from `settled_at` or wallet state `settled`; a preimage is never final
  proof. A wallet notification carrying a qualifying finality signal for a known pending attempt
  settles it directly through the same write-once path; anything less — no finality signal, an
  unknown hash, a failed direct settlement — only wakes a bounded wallet scan.
- Settlement is write-once per attempt and fulfillment runs only for the order's first settled
  attempt, inside the settlement transaction, because delivery is at-least-once. A duplicate
  sibling settlement is recorded (`status_reason = 'duplicate_settlement'`) without fulfilling.
- Closing an unpaid attempt requires a successful wallet scan past expiry plus the 900-second
  grace — never the local clock alone.
- Treat `swap_data` as a provider credential: never serialize it into HTTP responses or logs.
  Optional encryption at rest belongs to the host framework/database.
- Provider completion alone does not fulfill an order; wallet settlement does.
