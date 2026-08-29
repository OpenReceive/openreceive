# Swap refunds, and the way back to them

A swap deposit that arrives short, or late, becomes refundable. The payer has
to give an address on their own network, and they are almost never able to
do it on the spot — the address lives in another wallet.

A refund form is a promise. The promise is only kept if the payer can reach
that form again after they close the tab.

The two refund calls are in [Headless checkout → Refunds](headless-checkout.md#refunds).
The UI rules are in [Checkout UX → The refund screens](checkout-ux.md#the-refund-screens).
This page is what a shop has to be able to do.

## When a refund happens

The wallet is receive-only, so there is no merchant refund of a settled
Lightning payment. A swap refund is a payer reclaiming a deposit that never
converted. **Exactly one provider state allows it: `refund_required`.**

| `refund_reason` | What the payer did |
| --- | --- |
| `underpaid` | sent less than `deposit_amount` |
| `late_deposit` | sent after the provider's window closed |
| `underpaid_and_late` | both |

Two cases people expect to be here are not:

- **An overpayment is `attention`, not a refund.** There is no form. It needs
  a human.
- **A deposit sent without a required `deposit_memo`** may not be creditable
  and produces no `refund_required` either.

Underpayment is the case a UI can prevent: on token rails the QR has no
amount, so give the amount its own copy row. See
[Automated swaps](automated-swaps.md).

## The two-step form

`stageSwapRefund` then `confirmSwapRefund`. Only the second submits.

```ts
await controller.stageSwapRefund({ attemptId: swap.attemptId, refundAddress });
await controller.confirmSwapRefund({ attemptId: swap.attemptId, refundAddress });
```

- Validate with `getSwapRefundFormError(payInAsset, address, networkLabel)`
  before submit.
- `409` is a normal outcome — the provider state can change between the
  two steps.
- You do not maintain the typed address across polls. The controller keeps
  it on every snapshot it publishes.

## The refund replaces the payment screen

When `provider_state` is `refund_required`, `refund_pending`, or `refunded`,
do not leave the deposit panel on screen. A payer reading "send 15.01 USDT"
beside a refund notice will send again.

```ts
const REFUND_STATES = new Set(["refund_required", "refund_pending", "refunded"]);
return REFUND_STATES.has(display.state) ? <RefundScreen … /> : <DepositScreen … />;
```

Off the refund screen: QR, address, amount, fees, countdown. On it: what
went wrong, what the provider says about the money, the way back, and the
form.

Take "switch payment method" off on `refund_required` so the payer cannot
dismiss the attempt being refunded. Put it back once the refund is
`refund_pending`.

The shipped drop-ins already do this.

## The way back

There are three layers. Each is useless without the one above it.

### 1. A per-order URL

A checkout with no per-order path loses the order id when the tab closes.

Give the order its own URL. The drop-ins take `syncUrl`, `resumePathPrefix`,
and `routeReference`. If you own routing, push it with
`enterCheckoutResumePath` from `@openreceive/browser/headless`.

Then tell the display model what you built:

```ts
createSwapDisplayModel(invoice, { resumable: true });
```

and render `display.refundReturnLabel`. Resumable, it says to bookmark the
page. Not resumable, it says not to close the tab.

### 2. Your order, restored

OpenReceive ships no order-read route. `createGuestCheckoutResume` and
`createGuestOrderFetcher` (on `@openreceive/browser`, not `/headless`) parse
the URL, keep a same-tab sessionStorage mirror, and call your fetch.

Authorize that endpoint the way you authorize everything else. Possession of
an order id is a claim, not proof — [Authorization](authorization.md). A
guest shop scoped to a signed visitor cookie has scoped resume to the
browser that placed the order. Say so on the screen.

### 3. The attempt, restored

`POST …/checkouts/prepare` returns the amount and the catalog, and **no
attempts**. A checkout rebuilt from the reference alone opens on the method
grid.

**Re-select the coin** (`POST …/swaps` with the same asset) re-serves a live
attempt. Past expiry, the same click mints a **new** deposit address, and
the refund is no longer on screen.

**Keep the payment hash.** `POST …/swaps/status` with
`{ reference, payment_hash }` addresses one attempt, even a day later.

On a drop-in, that is one prop:

```tsx
<Checkout reference={order.id} resumable resumePaymentHash={order.swapPaymentHash} />
```

Create-mode only. A hash the server will not serve is ignored. Get the hash
from `onState`.

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

A miss returns the prepared snapshot unchanged. `requestSwapStatus` is the
unforgiving version if you want the `404`.

### What each layer buys you

| You built | A payer who closes the tab | A payer who comes back hours later |
| --- | --- | --- |
| Nothing | loses the order id and the deposit | — |
| Per-order URL + order restore | back on the method grid | back on the method grid |
| … + re-select the coin | back on the deposit or refund screen | a new deposit address; the refund is off-screen |
| … + `resumePaymentHash` / `resumeSwapAttempt` | back on the refund screen | back on the refund screen |

## When a payer cannot self-serve

`attention` (overpayment, double-deposit) has no form. Neither does a
deposit that missed a required memo. Show the attempt's identifying facts
(`providerOrderId`, `depositTxId`, `paymentHash`) with copy buttons, and a
way to reach a human.

## Where this is implemented

`examples/buttons` builds it four ways. The custom-UI stacks call
`resumeSwapAttempt`; the drop-in stacks pass `resumePaymentHash`. Storage is
`examples/buttons/shared/checkout-resume.ts`.

## Related

- [Headless checkout → Refunds](headless-checkout.md#refunds)
- [Checkout UX → The refund screens](checkout-ux.md#the-refund-screens)
- [Automated swaps](automated-swaps.md)
- [Authorization](authorization.md)
- [Frontend checkout](frontend-checkout.md)
