# Swap refunds, and the way back to them

A swap deposit that arrives short, or late, becomes refundable. The payer has to
give an address on their own network, and they are almost never in a position to
do it on the spot — the address lives in another wallet, on another device, and
fetching it means leaving your page.

**That is the whole difficulty.** Every other rule on this page is a detail
beside it: a refund form is a promise, and the promise is only kept if the payer
can reach that form again after they have closed the tab. This guide is the
refund flow end to end and, at length, the part that gets built last and
discovered first — the route back.

The mechanics of the two refund calls are in
[Headless checkout → Refunds](headless-checkout.md#refunds); the UI rules in
[Checkout UX → The refund screens](checkout-ux.md#the-refund-screens). This page
is what a shop has to be able to do.

## When a refund happens at all

Refunds here are one specific thing. The wallet is receive-only, so there is no
merchant-initiated refund of a settled Lightning payment; a swap refund is a
payer reclaiming a deposit that never converted. **Exactly one provider state
allows it: `refund_required`.**

| `refund_reason` | What the payer did |
| --- | --- |
| `underpaid` | sent less than `deposit_amount` |
| `late_deposit` | sent after the provider's window closed |
| `underpaid_and_late` | both |

The two cases people expect to be here are not:

- **An overpayment is `attention`, not a refund.** There is no `refund_required`
  to act on and no form that can help. It needs a human.
- **A deposit sent without a required `deposit_memo`** may not be creditable and
  produces no `refund_required` either — strictly worse than an underpayment,
  which is why the deposit panel renders the memo beside the address rather than
  below the fold.

Underpayment is the case a UI can actually prevent, and it is a rendering
decision: on token rails the QR encodes the bare address and carries **no
amount**, so the payer types six decimals by hand. Give the amount its own
labelled copy row. See [Automated swaps](automated-swaps.md).

## The two-step form

`stageSwapRefund` then `confirmSwapRefund`, and **only the second one submits**.

```ts
// Step one. Posts /swaps/status; touches no refund route.
await controller.stageSwapRefund({ attemptId: swap.attemptId, refundAddress });
// Step two, after the payer has read the address back.
await controller.confirmSwapRefund({ attemptId: swap.attemptId, refundAddress });
```

Wiring the review button to the confirm call silently skips the confirmation the
payer thinks they still owe — on a value they typed by hand, to an address that
cannot be recovered from.

Three more rules:

- **Validate with `getSwapRefundFormError(payInAsset, address, networkLabel)`**
  before you enable submit. These are checksum checks, not length guards,
  because a false accept sends money nowhere recoverable.
- **`409 CONFLICT` is a normal outcome, not an error screen.** The server
  re-reads live provider state at confirm time, and it does change under the
  payer between the two steps.
- **You do not maintain the staging.** The typed address lives in the browser
  and the server does not know about it until confirm, so a raw `/swaps/status`
  answer omits it. The controller folds it back into every snapshot it
  publishes, so a host that stores what it is handed keeps what the payer is
  mid-way through.

## The refund replaces the payment screen

When `provider_state` is `refund_required`, `refund_pending` or `refunded`, the
deposit panel is not merely finished with — it is **actively misleading**. A
payer reading "send 15.01 USDT to this address" beside a notice that their last
send is being refunded will send again.

So swap the screen, do not append to it. `SwapDisplayModel.state` is the switch:

```ts
const REFUND_STATES = new Set(["refund_required", "refund_pending", "refunded"]);
return REFUND_STATES.has(display.state) ? <RefundScreen … /> : <DepositScreen … />;
```

Off the refund screen: the QR, the deposit address, the amount, the fee
breakdown, and the countdown. On it: what went wrong
(`providerStateLabel` / `providerStateDetail`), what the provider says about the
money (`depositReceivedAmount`, `depositAmount`, `refundAmount`), the way back
(below), and the form.

Take the "switch payment method" affordance off too, for `refund_required`
specifically. On most custom UIs that control dismisses the current attempt —
which here hides the one screen that can claim the money back, behind a method
grid. Once the refund is `refund_pending` the deposit is finished with and
switching method is how the payer buys after all, so put it back.

The shipped drop-ins already do all of this; this section is what you inherit
the moment you stop using them.

## The way back

> A refund form on a checkout the payer cannot return to is a form that will be
> filled in by nobody.

The deposit is already sent. The refund is a second visit, often minutes or
hours later, and everything needed to find the attempt again is in a page the
payer is about to close.

There are three layers, and each is useless without the one above it.

### 1. A per-order URL

A checkout that lives at one route with no per-order path — a single-page shop,
a modal over a cart — loses the order id the moment the tab closes.

Give the order its own URL, and serve your app there. The drop-ins take
`syncUrl` (History API, `/checkout/:reference`), `resumePathPrefix`, and
`routeReference` for an app router that already owns the path. If your host owns
routing, push it yourself with `enterCheckoutResumePath` from
`@openreceive/browser/headless`.

Then **tell the display model what you actually built**:

```ts
createSwapDisplayModel(invoice, { resumable: true });
```

and render `display.refundReturnLabel` rather than picking a `checkoutLabels`
string yourself. Resumable, it says to bookmark the page; not resumable, it says
not to close the tab. Telling a payer to bookmark a page that will not bring
them back is worse than saying nothing, which is why the safe copy is the
default and one declared fact chooses between them.

### 2. Your order, restored

OpenReceive ships no order-read route: it never sees your order, and a summary
endpoint is yours to write. `createGuestCheckoutResume` and
`createGuestOrderFetcher` are the glue — URL parse and push, a sessionStorage
mirror for instant same-tab restore, and your fetch when that misses. **They are
on `@openreceive/browser`, not on `/headless`**, because the controller is host
behaviour: your storage, your order fetch, your authorization.

Authorize that endpoint the way you authorize everything else, and remember what
[Authorization](authorization.md) says: possession of an order id is a claim, not
proof. A guest shop that scopes orders to a signed visitor cookie has, as a
consequence, scoped resume to the browser that placed the order. That is a
reasonable answer — say so on the screen rather than letting a payer discover it
on their phone.

### 3. The attempt, restored

**This is the layer that gets missed, and it is the one that decides whether the
refund screen actually comes back.**

`POST …/checkouts/prepare` answers with the amount and the pay-in catalog and
**no attempts**. It is not a resume call and was never meant to be one. So a
checkout rebuilt from the reference alone — including the shipped drop-ins in
create mode — opens on the **method grid**. The payer who bookmarked their
refund screen arrives back at a shop.

Two ways to close that gap, and they are not equivalent:

**Re-select the coin** — `POST …/swaps` with the same `pay_in_asset`. For an
order that already has a committed attempt this **re-serves that attempt** with
live provider state instead of minting a second one, so it is safe to let the
payer simply click USDT → Tron again. This is what happens if you build nothing:
three clicks, and the refund screen is back.

But it holds only while the attempt is still live and comfortably before expiry.
The shadow Lightning invoice behind a swap is minted for roughly half an hour
(the provider's deposit window plus its settlement SLA plus a margin), and past
that the identical click **mints a second attempt with a new deposit address** —
and the refund the payer came back for is no longer what the screen is showing.
A refund claimed the next morning is exactly the case that outlives the window.

**Keep the payment hash** — `POST …/swaps/status` with
`{ reference, payment_hash }` addresses one attempt directly, with no reuse test,
so it still reaches a refund screen a day later. The hash is public, it is the
payer's own evidence that they paid, and the server stays the authority on what
the attempt is. Store it beside your order, or in the payer's browser.

**On a drop-in, that is one prop.** `resumePaymentHash` makes the checkout
reopen the attempt after prepare instead of showing the method grid:

```tsx
<Checkout reference={order.id} resumable resumePaymentHash={order.swapPaymentHash} />
```

It is create-mode only, and a hash the server will not serve is ignored — the
payer lands on the method grid rather than an error. Where the hash comes from
is yours: `onState` reports every attempt the checkout watches, and a swap
attempt names its own `payment_hash`.

**On a custom UI, it is one call.** `resumeSwapAttempt` is the same thing the
drop-ins use — it posts `/swaps/status` and folds the answer into the snapshot
the poll controller and every display model already read:

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

A miss is silence, not an error: it returns the prepared snapshot unchanged, so
an attempt the server will not serve leaves the payer on the method grid exactly
as they would have been. `requestSwapStatus` is the unforgiving version, when
you want to see the `404` yourself.

### What each layer buys you

| You built | A payer who closes the tab | A payer who comes back hours later |
| --- | --- | --- |
| Nothing | loses the order id and the deposit with it | — |
| Per-order URL + order restore | back on the method grid | back on the method grid |
| … + re-select the coin | back on the deposit or refund screen | **a new deposit address; the refund is off-screen** |
| … + `resumePaymentHash` / `resumeSwapAttempt` | back on the refund screen | back on the refund screen |

## When a payer cannot self-serve

`attention` — the overpayment and the double-deposit
(`emergency_repeat`) — has no form. Neither does a deposit that missed a
required memo. Show the payer their attempt's identifying facts (`providerOrderId`,
`depositTxId`, `paymentHash`) with copy buttons, and a way to reach a human.
Those values are public checkout state; withholding them makes your support
inbox the payer's only recourse in a dispute, which is the dependency Lightning
exists to remove. See [Checkout UX → the receipt](checkout-ux.md).

## Where this is implemented

`examples/buttons` builds it four ways, and all four carry all three layers.
The two stacks with a custom UI (`server/rails`, `server/nextjs-fullstack`) call
`resumeSwapAttempt` from `shared/client/stores/ShopCheckout.ts`; the two that
mount the packaged checkout (`server/node-express`,
`server/static-html-small-api`) pass `resumePaymentHash` instead. The storage
either way is `examples/buttons/shared/checkout-resume.ts` — one localStorage
note per order, written from the checkout's own state callback.

## Related

- [Headless checkout → Refunds](headless-checkout.md#refunds) — the calls and the twelve provider states
- [Checkout UX → The refund screens](checkout-ux.md#the-refund-screens) — the copy and the panels
- [Automated swaps](automated-swaps.md) — the deposit panel that prevents most refunds
- [Authorization](authorization.md) — who may read an order, and what an order id proves
- [Frontend checkout](frontend-checkout.md) — `syncUrl`, `routeReference`, `resumable` on the drop-ins
