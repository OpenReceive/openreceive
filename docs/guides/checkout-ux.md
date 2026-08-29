# Checkout UX

The shipped checkout — React's `<Checkout>` and the `<openreceive-checkout>`
custom element — already follows these rules. Read this page if you build your
own UI on `@openreceive/browser/headless`, or if you are deciding how much of
the shipped checkout to keep.

Each rule names the helper that already does it. Use the helper.

## Show a status, not a stepper

Do not draw Cart → Pay → Done. Checkout is a status, not a position on a line.

Render `createCheckoutStatusModel`. Use its `title`, `detail`, countdown, and
`phase`. That `phase` already treats a timed-out invoice as expired, so the
screen turns over when the clock does.

Use `checkoutLabels.switchPaymentMethod` for the back-link. That is a
breadcrumb, not a step back.

## Show what they are buying

The shipped checkout can only show the amount — OpenReceive does not own your
line items. Return an optional `description` from `amountFor`
(`config.amount_for` in Rails) and both drop-ins print it above the amount.

It is one display string. For a richer order summary, pass markup: React
`<Checkout>` takes `children` (a render prop with the live model); the custom
element projects `slot="order"` into its shadow root.

See [Frontend checkout](frontend-checkout.md#show-the-payer-what-they-are-buying).

## Ask "which network?" only when there is more than one

USDT has several networks. SOL and ETH have one. A single-network coin should
start the swap from the tile — do not ask a question that has one answer.

Call `resolveWizardSelection` and branch on `kind`. A one-network group comes
back as `start_swap`, never `choose_network`. Key the selection map by group
(`USDT`), valued by `pay_in_asset` (`USDT_TRON`).

## Say why a method is unavailable

A greyed tile that just says "unavailable" does not tell the payer whether to
add a dollar or give up. `createMethodGridDisplay` puts `limitMessage` on the
tile ("Minimum amount $2.71"), quoted from the group's cheapest network.

## Give every pasteable value a copy row

Deposit address, memo (when present), and the deposit amount each get a
labelled copy row. On token rails the QR is the address only — the payer types
the amount by hand.

Use `display.copyRows` from `createSwapDisplayModel`. Copy the amount as a
bare number (`0.032664`), not `0.032664 SOL`.

A required memo is part of the address. A deposit sent without it may never
be refundable. Put it in a copy row, not inside a warning banner.

## Use the model's network warning

Render `swap.networkWarningTitle` and `swap.networkWarning` as the model gives
them. Some rails get a loud "wrong network = lost funds" warning; SOL does
not, because a Solana address cannot be an Ethereum address. Do not hard-code
one banner for every coin.

## Wallet suggestions go under the Lightning invoice

`getPaymentWizardRoutes()` plus `createWizardRouteDisplays` returns the rows
— name, icon, link, and optional pay tutorial. Lightning only. Present them
as suggestions, not endorsements: any wallet that pays a Lightning invoice
works.

Serve the icons yourself with `assetBaseUrl` / `asset-base-url`. Under most
bundlers the packaged URLs become dead `file://` links otherwise. See
[Provider registry](provider-registry.md#assets-are-files-your-host-serves).

On a short panel, pass `providerPreviewLimit` so the list does not push the
QR off the screen.

## No "Open wallet" button on desktop

`openWallet` leaves the current page. On a phone that hands off to a wallet
app. On a desktop it either does nothing or walks the payer off a checkout
that is still waiting for payment. The drop-in draws no wallet button unless
you pass `components.OpenWalletButton`.

## Use the packaged labels

`checkoutLabels` is every payer-facing string the shipped UI prints
(`copyInvoice`, `switchPaymentMethod`, `chooseNetwork`, and the rest). Read
it before you write your own.

## Show the transaction record, collapsed

`createTransactionDetails({ reference, checkout_id, ...displayInvoice })` —
or `createTransactionDetailsFromState(state)` — builds the rows: order id,
amounts, bolt11, payment hash, explorer links, and swap fields. Keep the
panel collapsed. Show it on the live checkout and on the receipt after
payment.

Skip the caret when there are no rows (nothing has been chosen yet).

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
outcome — the provider state can change between the two steps.

The refund screen **replaces** the deposit panel. On `refund_required`,
`refund_pending`, and `refunded`, take away the QR, address, amount, and fee
breakdown. Take away "switch payment method" on `refund_required` so the
payer cannot dismiss the attempt being refunded.

The payer almost always leaves the page to fetch a refund address. They need
a URL that brings them back. Tell the model what you actually built:

```ts
createSwapDisplayModel(invoice, { resumable: true });
```

and render `display.refundReturnLabel`. If the page is not bookmarkable, it
says not to close the tab. [Swap refunds](swap-refunds.md) is the whole
route back. Read it before you turn swaps on.

## Related

- [Frontend checkout](frontend-checkout.md) — the drop-ins that already follow these rules
- [Headless checkout](headless-checkout.md) — the helpers named above
- [Swap refunds](swap-refunds.md) — the refund flow and the way back
- [Provider registry](provider-registry.md) — wallet suggestions and their icons
