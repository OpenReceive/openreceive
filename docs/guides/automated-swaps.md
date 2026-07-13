# Automated Swaps

OpenReceive always settles merchant orders to Lightning. Automated swaps let a
payer use supported crypto assets while the backend creates a shadow Lightning
invoice for that attempt.

## Configure a provider

You create the OpenReceive server instance exactly as in the
[Node Quickstart](quickstart-node.md). Automated swaps add no swap-specific app
code — put provider credentials only in the ignored backend `openreceive.yml`:

```yaml
OPENRECEIVE_NWC: nostr+walletconnect://...
OPENRECEIVE_NAMESPACE: my_app

swap:
  providers:
    - id: fixedfloat
      protocol: fixedfloat
      base_url: https://ff.io
      key: ...
      secret: ...
```

`providers` order is priority order. Leave `swap.providers` empty or leave
provider keys blank to keep automated swaps disabled. Never send provider keys
or `openreceive.yml` to browser code, mobile apps, source maps, fixtures, or
logs. Commit `openreceive.yml.example`, not the real file.

Weight budgets, expiry floors, and failover math live in
[Swap Operations](../internal/swap-operations.md).

## Payer flow

Mount OpenReceive and render `<Checkout orderId />` — swaps ride the same mount
with no app-owned multiplexer. The checkout UI lists payable assets when swaps
are enabled.

The payer sees the deposit address, exact amount, asset and network, and
provider expiry. Warn payers to pay with **one method only** — if a payer pays
the Lightning invoice and also sends funds to a deposit address, the merchant
can receive both.

Need a custom HTTP surface? See
[Custom Controller Integration](../internal/custom-controller-integration.md).

## Lifecycle (payer-facing)

| State | What the payer sees |
| --- | --- |
| `awaiting_deposit` | Show deposit address and exact amount |
| `confirming` / `exchanging` / `paying_invoice` | Processing |
| `completed` | "Finalizing" — **not paid yet** |
| `expired` / `failed` | This attempt is done; start over if needed |
| `refund_required` | Collect a refund address (see below) |
| `attention` | Needs operator review |

Provider completion never marks an order paid. OpenReceive settles only when the
wallet sweep sees `settled_at` or a settled transaction state. Full twelve-state
catalog and operator attention runbook:
[Swap Operations](../internal/swap-operations.md).

## Refunds

When the provider reports `refund_required`, the checkout element collects a
refund address for the same network, shows it back for confirmation, then
submits — all through the mounted routes.

Checkout also surfaces why the refund is needed when the provider reports it:

| Field | Meaning |
| --- | --- |
| `refund_reason` | `underpaid`, `late_deposit`, or `underpaid_and_late` (from FixedFloat `emergency.status`) |
| `deposit_received_amount` | Amount actually received on the deposit tx |
| `refund_amount` | Estimated refund excluding network fees |

Refund confirmation is two-phase and nonce-guarded. Stage the address
(`confirm` omitted/false), show it back, then submit again with `confirm: true`
before `refund_nonce_expires_at`. Warn payers to use an address they control and
not to paste the deposit address.

On guest sites, keep the public `order_id` in the URL so a refresh remounts
`<Checkout orderId>` — see [Guest resume](frontend-checkout.md#guest-resume).
