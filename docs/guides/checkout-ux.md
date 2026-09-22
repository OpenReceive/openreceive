# Checkout UX

The shipped checkout already follows these rules. That means React's
`<Checkout>` and the `<openreceive-checkout>` custom element. Read this page if
you build your own UI on `@openreceive/browser/headless`, or if you are
deciding how much of the shipped checkout to keep.

Each rule names the helper that already does it. Use the helper.

## Show a status, not a stepper

Do not draw Cart → Pay → Done. Checkout is a status, not a position on a line.

Render `createCheckoutStatusModel`. Use its `title`, `detail`, countdown, and
`phase`. That `phase` already treats a timed-out invoice as expired, so the
screen changes when the clock runs out.

Use `checkoutLabels.switchPaymentMethod` for the back-link. That is a
breadcrumb, not a step back. The method grid and the Lightning invoice are
separate screens, and only one shows at a time. Switching payment method hides
the QR, countdown, waiting status, and copy action. Keep the live bolt11 in the
session so you can reuse it when the payer selects Bitcoin again. Do not
dismiss it. Only a swap's `refund_required` screen forbids leaving.

## Show what they are buying

The shipped checkout can only show the amount, because OpenReceive does not own
your line items. Return an optional `description` from `amountFor`
(`config.amount_for` in Rails). Both drop-ins print it above the amount. It is
also the invoice memo, so the payer's wallet shows the same words. Without it,
the BOLT11 carries no description at all.

It is one display string. For a richer order summary, pass markup:

- React `<Checkout>` takes `children`, a render prop that receives the live
  model.
- The custom element projects `slot="order"` into its shadow root.

See [Frontend checkout](frontend-checkout.md#show-the-payer-what-they-are-buying).

## Ask "which network?" only when there is more than one

USDT has several networks. SOL and ETH have one. For a single-network coin,
start the swap from the tile. Do not ask a question that has only one answer.

Call `resolveWizardSelection` and branch on `kind`. A one-network group comes
back as `start_swap`, never `choose_network`. Key the selection map by group
(`USDT`), with `pay_in_asset` as the value (`USDT_TRON`).

## Say why a method is unavailable

A greyed tile that just says "unavailable" does not tell the payer whether to
add a dollar or give up. `createMethodGridDisplay` puts `limitMessage` on the
tile ("Minimum amount $2.71"). The limit comes from the group's cheapest
network.

## Give every pasteable value a copy row

The deposit address, the memo (when present), and the deposit amount each get
a labelled copy row. On token rails the QR holds only the address, so the payer
types the amount by hand.

Use `display.copyRows` from `createSwapDisplayModel`. Copy the amount as a
bare number (`0.032664`), not `0.032664 SOL`.

A required memo is part of the address. A deposit sent without it may never
be refundable. Put it in a copy row, not inside a warning banner.

## One amount to send

A payer on a USDC checkout asked "50.05 or 50.03?". The header said "Pay 50.05
USDC". The payment breakdown, one line below, said "You send $50.03". That
second number was the rate feed's USD value of the first. The payer could not
tell which one to type into their wallet.

`swap.deposit_amount` is the only amount a payer is ever told to send. It is in
the pay-in token. `swap.fee.pay_in_fiat` and `payout_fiat` are valuations. They
explain why the deposit is larger than the cart total, and they are not
instructions.

Some stablecoins are pegged to the fee currency. The shared asset table marks
this with `pegged_to`: USDT and USDC are pegged to USD. For these coins:

- The breakdown is in the token: "You send 50.05 USDC", "Swap + network fees
  1.05 USDC (2.1%)".
- `pay_in_fiat` is never rendered, neither in the breakdown nor in the
  transaction details.
- The cart total stays in fiat.

Floating assets (SOL, ETH) keep the fiat breakdown. There, "$50.03" cannot be
mistaken for "0.71 SOL".

This is not a depeg rule. On an ordinary day, a feed rate a hundredth of a
percent off $1.00 puts the two numbers a cent apart. So the fiat value of a
pegged deposit is never shown at all. It is not shown behind a threshold or
with an "approx." marker either. `createSwapFeeBreakdown(fee, swap)` applies
the rule. Pass the swap, not just the fee, or the breakdown falls back to fiat.

## Use the model's network warning

Render `swap.networkWarningTitle` and `swap.networkWarning` exactly as the
model gives them. Some rails get a loud "wrong network = lost funds" warning.
SOL does not, because a Solana address cannot be an Ethereum address. Do not
hard-code one banner for every coin.

## Wallet suggestions go under the Lightning invoice

`getPaymentWizardRoutes()` plus `createWizardRouteDisplays` returns the rows.
Each row has a name, icon, link, and optional pay tutorial. This is for
Lightning only. Present the rows as suggestions, not endorsements. Any wallet
that pays a Lightning invoice works.

The logos are data URIs inside `@openreceive/provider-data`, so you have
nothing to serve, under any bundler. A tutorial's screenshot arrives after
`loadPayTutorialImages()` resolves. Until then,
`WizardProviderTutorialDisplay.image` is `undefined`. Before that, draw the
caption alone. Never draw an `<img>` with an empty `src`. See
[Provider registry](provider-registry.md#assets).

On a short panel, pass `providerPreviewLimit` so the list does not push the
QR off the screen.

## No "Open wallet" button on desktop

`openWallet` leaves the current page. On a phone, that hands off to a wallet
app. On a desktop, it either does nothing or takes the payer away from a
checkout that is still waiting for payment. The drop-in draws no wallet button
unless you pass `components.OpenWalletButton`.

## Use the packaged labels

`checkoutLabels` holds every payer-facing string the shipped UI prints
(`copyInvoice`, `switchPaymentMethod`, `chooseNetwork`, and the rest). Read
it before you write your own.

## Show the transaction record, collapsed

`createTransactionDetails({ reference, checkout_id, ...displayInvoice })` builds
the rows. So does `createTransactionDetailsFromState(state)`. The rows are the
order id, amounts, bolt11, payment hash, explorer links, and swap fields. Keep
the panel collapsed. Show it on the live checkout and on the receipt after
payment.

Skip the caret when there are no rows, which happens when nothing has been
chosen yet.

This is the payer's evidence that they paid. Both shipped settled panels
render this builder.

## The refund screens

A swap refund is a payer reclaiming a deposit that never converted. There is
no merchant refund of a settled Lightning payment.

It is two steps, and only the second submits:

```ts
await controller.stageSwapRefund({ attemptId, refundAddress });
await controller.confirmSwapRefund({ attemptId, refundAddress });
```

Validate with `getSwapRefundFormError` first. Treat `409` as a normal
outcome. The provider state can change between the two steps.

The refund screen **replaces** the deposit panel. On `refund_required`,
`refund_pending`, and `refunded`, remove the QR, address, amount, and fee
breakdown. On `refund_required`, also remove "switch payment method" so the
payer cannot dismiss the attempt being refunded.

The payer almost always leaves the page to fetch a refund address. They need
a URL that brings them back. Tell the model what you actually built:

```ts
createSwapDisplayModel(invoice, { resumable: true });
```

Then render `display.refundReturnLabel`. If the page is not bookmarkable, the
label tells the payer not to close the tab. [Swap refunds](swap-refunds.md)
covers the whole route back. Read it before you turn swaps on.

## Related

- [Frontend checkout](frontend-checkout.md) — the drop-ins that already follow these rules
- [Headless checkout](headless-checkout.md) — the helpers named above
- [Swap refunds](swap-refunds.md) — the refund flow and the way back
- [Provider registry](provider-registry.md) — wallet suggestions and their icons
