# Swap refunds, and the way back to them

A swap deposit that arrives short, or late, becomes refundable. A swap is a
payment in another coin that a provider converts to Lightning. To get a
refund, the payer has to give an address on their own network. They can
almost never do that on the spot, because the address lives in another wallet.

A refund form is a promise. You only keep that promise if the payer can reach
the form again after they close the tab.

The two refund calls are in [Headless checkout → Refunds](headless-checkout.md#refunds).
The UI rules are in [Checkout UX → The refund screens](checkout-ux.md#the-refund-screens).
This page covers what your shop has to be able to do.

## When a refund happens

The wallet is receive-only, so you cannot refund a settled Lightning
payment. A swap refund is a payer reclaiming a deposit that never
converted. **Exactly one provider state allows it: `refund_required`.**

| `refund_reason` | What the payer did |
| --- | --- |
| `underpaid` | Sent less than `deposit_amount` |
| `overpaid` | Sent more than `deposit_amount` |
| `late_deposit` | Sent after the provider's window closed |
| `underpaid_and_late` | Sent too little, and late |
| `overpaid_and_late` | Sent too much, and late |

A refund returns the **whole** deposit, even on an overpayment. The payout
is a fixed-amount bolt11, so there is nothing to exchange a surplus into. The
order stays unpaid, and the payer can pay again afterwards.

One case people expect here is not covered:

- **A deposit sent without a required `deposit_memo`** may not be credited
  to anyone, and it produces no `refund_required`.

Your UI can prevent underpayment. On token rails the QR has no amount, so
give the amount its own copy row. See
[Automated swaps](automated-swaps.md).

## The two-step form

`stageSwapRefund` then `confirmSwapRefund`. Only the second submits.

```ts
await controller.stageSwapRefund({ attemptId: swap.attemptId, refundAddress });
await controller.confirmSwapRefund({ attemptId: swap.attemptId, refundAddress });
```

- Validate with `getSwapRefundFormError(payInAsset, address, networkLabel)`
  before submit.
- `409` is a normal outcome. The provider state can change between the
  two steps.
- You do not need to keep the typed address across polls. The controller
  keeps it on every snapshot it publishes.

## The refund replaces the payment screen

When `provider_state` is `refund_required`, `refund_pending`, or `refunded`,
do not leave the deposit panel on screen. A payer reading "send 15.01 USDT"
beside a refund notice will send again.

```ts
const REFUND_STATES = new Set(["refund_required", "refund_pending", "refunded"]);
return REFUND_STATES.has(display.state) ? <RefundScreen … /> : <DepositScreen … />;
```

Leave these off the refund screen: QR, address, amount, fees, countdown.
Put these on it: what went wrong, what the provider says about the money, the
way back, and the form.

On `refund_required`, remove "switch payment method" so the payer cannot
dismiss the attempt being refunded. Put it back once the refund is
`refund_pending`.

The shipped drop-ins already do this.

## The way back

There are three layers. Each one is useless without the one above it.

### 1. A per-order URL

A checkout with no per-order path loses the order id when the tab closes.

Give the order its own URL. The drop-ins take `syncUrl`, `resumePathPrefix`,
and `routeReference`. If you own routing, push it with
`enterCheckoutResumePath` from `@openreceive/browser/headless`.

Then tell the display model what you built:

```ts
createSwapDisplayModel(invoice, { resumable: true });
```

Then render `display.refundReturnLabel`. With `resumable: true`, the label
tells the payer to bookmark the page. Without it, the label tells them not to
close the tab.

### 2. Your order, restored

OpenReceive ships no route that reads orders. You write that endpoint.
`createGuestCheckoutResume` and `createGuestOrderFetcher` help on the browser
side. They live on `@openreceive/browser`, not `/headless`. They parse the
URL, keep a copy in sessionStorage for the same tab, and call your fetch.

Authorize that endpoint the way you authorize everything else. Having an
order id is a claim, not proof. See [Authorization](authorization.md). If a
guest shop scopes orders to a signed visitor cookie, then only the browser
that placed the order can resume it. Say so on the screen.

### 3. The attempt, restored

`POST …/checkouts/prepare` returns the amount and the catalog, and **no
attempts**. So a checkout rebuilt from the reference alone opens on the
method grid.

**Re-select the coin.** `POST …/swaps` with the same asset serves the live
attempt again. After it expires, the same click creates a **new** deposit
address, and the refund is no longer on screen.

**Keep the payment hash.** `POST …/swaps/status` with
`{ reference, payment_hash }` finds one specific attempt, even a day later.

On a drop-in, that is one prop:

```tsx
<Checkout reference={order.id} resumable resumePaymentHash={order.swapPaymentHash} />
```

This works in create mode only. If the server will not serve the hash, the
checkout ignores it. Get the hash from `onState`.

On a custom UI:

```ts
import { resumeSwapAttempt } from "@openreceive/browser/headless";

const snapshot = await resumeSwapAttempt({
  fetch,
  prefix,
  reference,
  paymentHash: rememberedHash,
  snapshot: preparedSnapshot,
});
```

If no attempt matches, it returns the prepared snapshot unchanged. If you
want the `404` instead, use `requestSwapStatus`.

### What each layer buys you

| You built | A payer who closes the tab | A payer who comes back hours later |
| --- | --- | --- |
| Nothing | Loses the order id and the deposit | — |
| Per-order URL + order restore | Back on the method grid | Back on the method grid |
| … + re-select the coin | Back on the deposit or refund screen | Gets a new deposit address, and the refund is off-screen |
| … + `resumePaymentHash` / `resumeSwapAttempt` | Back on the refund screen | Back on the refund screen |

## When a payer cannot self-serve

Some cases have no form. The `attention` state has none. It covers a second
deposit onto a finished order, or a provider state we do not recognize. A
deposit that missed a required memo has no form either. For these, show the
attempt's identifying facts (`providerOrderId`, `depositTxId`,
`paymentHash`) with copy buttons, and a way to reach a human.

## Where this is implemented

`examples/buttons` builds it four ways. The custom-UI stacks call
`resumeSwapAttempt`. The drop-in stacks pass `resumePaymentHash`. The storage
code is in `examples/buttons/shared/checkout-resume.ts`.

## Related

- [Headless checkout → Refunds](headless-checkout.md#refunds)
- [Checkout UX → The refund screens](checkout-ux.md#the-refund-screens)
- [Automated swaps](automated-swaps.md)
- [Authorization](authorization.md)
- [Frontend checkout](frontend-checkout.md)
