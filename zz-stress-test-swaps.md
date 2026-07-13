# Swap service stress-test scenarios

OpenReceive does not hold swap funds — the FixedFloat-compatible provider does.
Refunds only open when the provider hits `EMERGENCY` and OpenReceive maps that to
`refund_required`. Overpay goes to `attention` (manual), not the nonce refund UI.

Settlement authority is always the wallet sweep (`settled_at` /
`transaction_state == "settled"` on the shadow invoice). Provider `completed` is
informational only — UI should show "Finalizing", never "Paid", until the wallet
confirms.

---

## Mental model

```
start_swap → awaiting_deposit → confirming → exchanging → paying_invoice → completed
                                                                      ↓
                                                         wallet sweep → order paid

Underpay / late deposit → EMERGENCY (LESS / EXPIRED) → refund_required
  → stage address → confirm → refund_pending → refunded

Overpay → EMERGENCY (MORE / OVER / OVERPAID) → attention (manual; no refund_nonce)
```

---

## Happy path (baseline)

1. Start swap → send **exact** `deposit_amount` → wait for confirmations →
   provider pays shadow LN invoice → wallet sweep marks order **paid**.
2. Confirm UI stays on "Finalizing" while `provider_state === completed`, and
   only flips to paid after wallet settlement.

---

## Underpayment → refund path (main target)

These should land in `refund_required` → two-phase refund → `refunded`.

| # | Scenario | What to do | Expect |
|---|----------|------------|--------|
| 1 | Classic underpay | Send ~50–90% of `deposit_amount` | `EMERGENCY`/`LESS` → `refund_required` |
| 2 | Tiny dust underpay | Send exact amount minus 1 unit (e.g. 1 sat-equivalent / 1 lamport / 1 sun) | Same refund path if provider treats it as LESS |
| 3 | Full refund UX | From `refund_required`: stage address (`confirm: false`), confirm (`confirm: true`), wait for `refund_tx_id` | `refund_pending` → `refunded`; order stays unpaid |
| 4 | Wrong-network refund address | Stage a Solana address on a Tron attempt (or ETH on SOL) | Rejected at validation; stays `refund_required` |
| 5 | Stale refund nonce | Stage address, wait **>10 min**, then confirm | 409; refresh status for a new nonce; staged address is retained |
| 6 | Address mismatch on confirm | Stage addr A, confirm with addr B | Rejected; no provider `/emergency` call |
| 7 | Double-confirm spam | Confirm refund twice quickly | Second should no-op / stay `refund_pending` (CAS on `refund_dispatch_id`) |
| 8 | Refund address spam | Submit stage >5 times | 429 after 5 submissions |

**Best assets for underpay tests:** `USDT_TRON` or `USDT_SOL` (cheap, exact amounts
easy). ETH underpay is messier because gas floors are higher.

### What "success" looks like for refund stress

- Underpay → `refund_required` → stage → confirm → `refund_pending` → `refunded`
  + on-chain `refund_tx_id`
- Order status stays **unpaid**
- Refund amount is **less network fee** (FixedFloat behavior)
- Overpay never gets a `refund_nonce`
- `expired` with no deposit never offers refund

---

## Overpayment → attention (not auto-refund)

| # | Scenario | What to do | Expect |
|---|----------|------------|--------|
| 9 | Classic overpay | Send 110–200% of deposit | `MORE`/`OVER`/`OVERPAID` → `attention` + `provider_reported_emergency` |
| 10 | Huge overpay | Send 10× deposit | Same; polling stops; **no** `refund_nonce` |
| 11 | Manual recovery | In FixedFloat dashboard: refund or continue exchange, then call `refresh_swap` | `attention` does **not** auto-poll (by design). Operator `refresh_swap` (scoped to `provider_reported_emergency`) pulls the latest provider state once. |

Do **not** expect the in-app refund form here. That is intentional.
`attention` is terminal; do not auto-refund — only `refund_required` carries a
nonce and a safe refund path.

---

## "Too little gas" / deposit never arrives

OpenReceive has no gas estimator. Low gas usually means the deposit never
confirms, so the provider never sees it.

| # | Scenario | What to do | Expect |
|---|----------|------------|--------|
| 12 | ETH underpriced gas | Broadcast deposit with gas too low to mine before deposit window (~10 min default) | Stays `awaiting_deposit` → provider `EXPIRED` → OpenReceive `expired` (no refund — nothing credited) |
| 13 | Stuck then mined late | Low gas, then bump/replace after order expiry | Often FixedFloat `EMERGENCY`/`EXPIRED` (tx after window) → usually `refund_required` if they credit it late |
| 14 | Failed/dropped tx | Broadcast then drop (or never broadcast) | `expired`; no refund path |
| 15 | Wrong chain | Send USDT ERC-20 to a Tron deposit address (or SOL to ETH) | Funds lost at chain level / never detected → `expired` or provider emergency depending on whether anything hits their watcher |

---

## Timing / race stress

| # | Scenario | What to do | Expect |
|---|----------|------------|--------|
| 16 | Deposit at last second | Send exact amount in final ~30s of window | Either completes or late → emergency/refund |
| 17 | Deposit after expiry | Wait for `expired`, then send exact amount anyway | Provider may open emergency → refund path |
| 18 | Settlement attention | Provider reaches `completed` but LN payout never hits wallet (hard live; easy with testkit) | After `settlement_attention_seconds` (default 60s) → `attention` / `provider_completed_without_wallet_settlement` |
| 19 | Dual pay | Pay LN display invoice **and** send swap deposit | Both can succeed; merchant may get paid twice (documented risk) |
| 20 | Supersede attempts | Start swap A, start swap B (same or different asset), pay A's deposit | A can still settle; max **3** non-terminal attempts per checkout |

---

## Refund UX / API abuse

| # | Scenario | What to do | Expect |
|---|----------|------------|--------|
| 21 | Confirm without stage | `refund_swap` with `confirm: true` and no prior stage | Rejected |
| 22 | Refund while not in refund state | Call refund during `awaiting_deposit` | Rejected |
| 23 | Lost capability token | Drop `order_access_token`, try refund | 401/403 |
| 24 | Cross-attempt refund | Use attempt A's nonce against attempt B | Rejected |

---

## Local (no real money) first

Use the testkit before burning gas:

```js
swap.forceRefundRequired("USDT_TRON");
swap.forceAttention("USDT_TRON", "provider_completed_without_wallet_settlement");
swap.forceCreateError();
swap.script("USDT_TRON", ["confirming", "exchanging", "paying_invoice", "completed"]);
```

That covers refund UI, nonce flow, and attention without FixedFloat.

See also `docs/internal/swap-operations.md` → "Testing swaps locally".

---

## Suggested live order (cheap → expensive)

1. **USDT_TRON underpay** → full refund UX (scenarios 1, 3–8)
2. **USDT_TRON overpay** → confirm `attention`, not refund form (9–11)
3. **Late deposit after expiry** (17)
4. **ETH low-gas / late bump** (12–13) only if you care about EVM edge cases
5. **Dual pay** (19) once, with a tiny checkout amount

---

## Provider state cheat sheet

| `provider_state` | Phase | Terminal | Meaning |
|------------------|-------|----------|---------|
| `creating_provider_order` | preparing | no | Deposit address being created |
| `awaiting_deposit` | awaiting_deposit | no | Show address/amount |
| `confirming` | processing | no | Deposit detected, confirming |
| `exchanging` | processing | no | Provider converting |
| `paying_invoice` | processing | no | Provider paying LN invoice |
| `completed` | settling | **no** | Provider done; **not paid yet** |
| `expired` | terminal | yes | No deposit before the window |
| `refund_required` | refund | no | Collect refund address |
| `refund_pending` | refund | no | Refund submitted to provider |
| `refunded` | terminal | yes | Provider reports refund sent |
| `attention` | attention | yes | Operator review required |
| `failed` | terminal | yes | Address unusable |

### FixedFloat emergency → OpenReceive mapping

| FixedFloat condition | OpenReceive state |
|----------------------|-------------------|
| `EMERGENCY`, no choice yet, not OVER/MORE/OVERPAID | `refund_required` |
| `EMERGENCY`, `choice: REFUND`, no refund tx | `refund_pending` |
| `EMERGENCY`, `choice: REFUND`, refund tx present | `refunded` |
| `EMERGENCY` with `MORE` / `OVER` / `OVERPAID` | `attention` |
| `EMERGENCY`, `choice: EXCHANGE` | `attention` |
| `EXPIRED` (no deposit) | `expired` |

FixedFloat emergency reasons include: `EXPIRED` (tx after order expiry), `LESS`
(underpayment), `MORE` (overpayment), `LIMIT` (amount outside limits).

---

## Useful constants

| Constant | Default | Notes |
|----------|---------|-------|
| Deposit window | 600s | Provider config `deposit_window_seconds` |
| Settlement SLA | 900s | `settlement_sla_seconds` |
| Invoice expiry margin | 300s | Default floor `600+900+300=1800` |
| Expired grace poll | 900s | Keep polling top-level `expired` until `provider_expires_at + 900` |
| Settlement attention | 60s | `swap.settlement_attention_seconds` |
| Refund nonce TTL | 600s (10 min) | Confirm after this → 409; staged address retained |
| Status poll interval | ≥10s | While non-terminal (plus expired grace) |
| Max active attempts | 3 | Per checkout |
| Max refund address submissions | 5 | Then 429 |
| Provider weight soft cap | 200/min | Per-provider durable ledger; create gate at 150; failover to next `swap.providers` entry |

---

## Attention runbook (when funds may be in limbo)

| `attention_reason` | Cause | Action |
|--------------------|-------|--------|
| `provider_completed_without_wallet_settlement` | Provider done, no LN settlement | Reconcile wallet + `payout_tx_id` |
| `provider_order_creation_stale` | Hung create; no deposit address shown | Safe to retry |
| `provider_order_creation_failed` | Provider rejected create | Check `provider_error` |
| `provider_order_creation_needs_reconcile` | Create timeout; FF may have an orphan order | Reconcile in FF dashboard before retry |
| `provider_reported_emergency` | Overpay / manual exchange | Dashboard action, then `refresh_swap` |
| `provider_order_expires_after_shadow_invoice` | FF window > shadow bolt11 | Raise invoice expiry; abandon attempt |

---

## Related docs

- `docs/guides/automated-swaps.md` — integrator setup and payer flow
- `docs/internal/swap-operations.md` — lifecycle, attention runbook, audit events
- `zz-fixedfloat-api.txt` — FixedFloat EMERGENCY statuses and `/emergency` API
- `spec/test-vectors/swap-emergency-refund.json` — conformance vector for emergency → refund
- `packages/js/testkit/src/swap-provider.ts` — local force/script helpers
