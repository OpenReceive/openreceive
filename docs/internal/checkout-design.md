# Checkout design notes

Contributor notes behind the public checkout guides. Integrators should start
at [Frontend checkout](../guides/frontend-checkout.md), [Checkout UX](../guides/checkout-ux.md),
and [Headless checkout](../guides/headless-checkout.md). This page is the
*why* and the gotchas those pages no longer spell out.

## Status `phase` is not the snapshot `phase`

`createCheckoutStatusModel` returns its own `phase`. That is not a pass-through
of the snapshot's `phase`.

A non-terminal snapshot whose countdown has reached zero is reported as
`expired`. The screen turns over the moment the clock does. Render the
snapshot's raw `phase` instead and you show a live checkout over a dead bolt11
until the next poll disagrees.

`title` and `detail` on the model are the finished payer-facing strings both
shipped renderers print. Do not rewrite them.

## Progress is a status, not a position

Three vocabularies come off the wire, and the forward path is the minority of
all three:

| Type | Values | Of which |
| --- | --- | --- |
| `Status` | 4 | one in-progress, three outcomes |
| `CheckoutPhase` | 6 | `invoice_created`, `verifying`, `settled`, `expired`, `failed`, `cancelled` |
| `SwapProviderState` | 12 | including `refund_required`, `refund_pending`, `refunded`, `attention` |

A Cart → Pay → Done stepper has a slot for exactly one of those per column,
and nowhere to put an expired invoice, a failed swap, or a refund in review.
A bar indexed off a host stage enum sits lit on "Pay" over an invoice that
expired ten minutes ago, and draws the refund flow as "step 2 of 3".

That is why the shipped renderers draw a status line plus a backwards
breadcrumb and no forward stepper. Backwards movement is
`checkoutLabels.switchPaymentMethod`, not a step-back. The one `onStep` in
the shipped UI is the provider tutorial carousel — a slideshow, which makes
no claim about progress.

If a custom UI still wants a stepper, it owns the answer to where `expired`,
`failed`, `cancelled`, and the refund states go. They are not points on a
line.

## Network selection map

`resolveWizardSelection` returns `selectedAssetByGroup` keyed by **group key**
(`USDT`) and valued by the chosen option's **`pay_in_asset`** (`USDT_TRON`) —
not by `network_label`. The wrong write type-checks and simply leaves the
tile unselected with no error.

A group with one option comes back as `start_swap`, never `choose_network`.
The network question exists because the deposit address is network-specific
and a wrong send is unrecoverable. Asking it on SOL teaches the payer that
the step is ceremony, one screen before USDT, where it is the whole
decision.

`createMethodGridDisplay` carries the same rule per tile as `needsNetworkStep`
/ `startPayInAsset`.

## Deposit risk is derived, not tabulated

`swapDepositRisk(payInAsset)` asks whether the address format pins the chain
and whether the asset is that chain's native coin. An unrecognized rail falls
through to the full alarm. The axis is **address ambiguity, not
native-vs-token**:

| Rail | Address | Reachable mistake | Panel |
| --- | --- | --- | --- |
| `ETH_ETH` | `0x…` | chain ambiguous (same string on six EVM chains) | full alarm |
| `USDT_ETH` / `USDC_ETH` | `0x…` | chain + asset ambiguous | full alarm |
| `USDT_TRON` | `T…` | chain pinned; USDT is in every exchange withdrawal dropdown | full alarm |
| `SOL_SOL` | base58 ed25519 | SOL exists on no other chain | quiet |

`ETH_ETH` is a native coin and needs the alarm most of anything on the list.
A banner shown on every rail is read on none. The display model already
carries this as `depositRisk` (`"chain_ambiguous" | "asset_only" | "pinned"`)
and picks its own heading. Do not keep a rail list of your own.

This is a different question from QR amount prefill, which really is
native-vs-token.

## Deposit QR amount prefill

Only native-coin rails encode an amount in the QR: `ETH_ETH` emits
`ethereum:<address>?value=<wei>` and `SOL_SOL` emits
`solana:<address>?amount=<sol>`. Token rails (`USDT_TRON`, `USDT_ETH`,
`USDC_ETH`, and any future ERC-20/TRC-20) encode the **bare address**. The
EIP-681 token-transfer form is parsed inconsistently across wallets; a
wallet that mis-parses it shows a broken request rather than no prefill.

A `deposit_amount` the checkout cannot convert raises. An amount-less
payment URI that lets the payer type any amount against a fixed-rate order
would be worse.

On those token rails the payer types six decimals by hand. Copy
`depositAmount` **bare** — `"0.032664 SOL"` is not a wallet amount field.
The model keeps `depositAmount`, `assetLabel`, and `networkLabel` separate
on purpose; `networkWarningEmphasis` is for reading, not copying.

A missing `deposit_memo` is worse than an underpayment: a deposit that
arrives without it may not be creditable and there is no `refund_required`
to act on.

## QR encoding is async

`createQrSvg` / `createQrPayloadSvg` are both async. React types
`dangerouslySetInnerHTML.__html` as `string | TrustedHTML`, and
`TrustedHTML` is an empty interface every object satisfies, so passing the
promise straight in type-checks and renders the literal text
`[object Promise]`.

`createQrSvgController` is that resolved: call `show(invoice)` or
`showPayload(payload)` whenever the payload changes, render what `onValue`
last handed you, and an encode that lands after the payload changed is
dropped. `stop()` on teardown.

## `mergeAttemptIntoSnapshot` argument order

`(attempt, snapshot)` — it reads backwards from the name. TypeScript
catches a swap either way. Folding a started attempt into the running
snapshot makes the deposit the active invoice without dropping a still-valid
Lightning sibling.

## Refund staging survives polling

The address the payer is typing lives in the browser. The server does not
know about it until confirm, so a raw `/swaps/status` answer omits it.
`stageSwapRefund` posts `/swaps/status` and holds the address;
`confirmSwapRefund` is the only call that posts `/swaps/refunds`. Wiring
the review button to the confirm call silently skips the confirmation.

The controller folds the staged attempt into every snapshot it publishes,
before `onSnapshot` and before the derived state. A host that stores what
it is handed keeps the field. There is no overlay rule to remember.

Exactly one provider state allows a refund: `refund_required`. The server
re-reads live state at confirm time and answers `409 CONFLICT` for anything
else. Handle that as a normal outcome.

An overpayment is `refund_required` — the provider returns the whole deposit,
because the payout is a fixed-amount bolt11 and there is nothing to exchange
the surplus into. A deposit that missed a required memo is neither: it needs a
human. `completed` means the **provider** is done — not settlement.
Settlement is the wallet sweep, proven by payment hash.

`POST /checkouts/prepare` returns the amount and the pay-in catalog and
**no attempts**. A checkout rebuilt from the reference alone opens on the
method grid. Re-selecting the same coin re-serves a live attempt, but past
expiry it mints a new deposit address. The durable handle is the payment
hash via `POST /swaps/status`. See [Swap refunds](../guides/swap-refunds.md).

On `refund_required`, `refund_pending`, and `refunded`, the deposit panel
is actively misleading. Take away the QR, address, amount, and fee
breakdown. Take away "switch payment method" on `refund_required` only —
once `refund_pending`, switching method is how the payer buys after all.

`createTransactionDetails` returns no rows while the rail is
`checkout_lock` (the deferred placeholder before the payer has chosen
anything). Render the caret only when the rows are non-empty.

## Wallet suggestions

`@openreceive/provider-data` is a hard dependency of `@openreceive/browser`.
The registry is static data and does not prove a provider will complete a
payment, quote a fee, or serve the payer's jurisdiction.

`getPaymentWizardRoutes()` with no arguments returns `btc-lightning`. The
registry also carries `usdt`, `usdc`, `eth`, `xmr`, `ltc`, `trx`, `sol`,
and `xrp`, but those list exchanges that convert an asset *into* a
Lightning payment — a mid-payment misdirection on a deposit panel.

The registry answers ~37 Lightning providers. There is no default preview
limit, because the shipped renderers draw the whole grid on a screen that
has room for it. A fixed-height panel should pass `providerPreviewLimit`
(`OPENRECEIVE_PROVIDER_PREVIEW_LIMIT` is the number the shipped styles are
drawn against) and build "show all" from `display.providerCount`.

The payment-method icons are compiled into `@openreceive/browser`
(`paymentIconSvgs`, generated from `src/assets/icons/*.svg`): the custom
element draws them inline in its shadow root, and `paymentIconUrls` hands the
same markup to any `<img>` as `data:` URIs. No host serves them. Inline SVG
is allowed only there, for those build-gated first-party strings.

`@openreceive/provider-data`'s images are files. Their packaged URLs resolve
against `import.meta.url`, which only works under Vite/Rollup; other bundlers
yield dead `file://` links that also publish the server's directory layout.
Serve that package's `dist/assets` tree and point at it with `assetBaseUrl` /
`asset-base-url`. `resolveAssetUrl` is the function form — it cannot cross an
HTML attribute, so it is React-and-`defineElements` only. A resolver, when
set, is also honoured for the payment icons (served as files from the same
root), which is the escape hatch for an `img-src` without `data:`. Grep the
built bundle for `file://` before shipping.

## Headless surface curation

A symbol is on `/headless` if and only if one of OpenReceive's renderers
imports it by name, or a real headless integration needs it — never
`export *`. The renderers and the flagship example compile against exactly
this surface, so both double as its regression test.

Neither [Headless checkout](../guides/headless-checkout.md) nor
[Headless surface inventory](headless-surface.md) can drift from the entry
module: both carry generated blocks, and
`node tools/docs/generate-headless-surface.mjs --check` fails the gate
when either is stale.

The leftovers block in the public guide is every exported symbol the
hand-written sections do not name in backticks. Completeness is
machine-checked; the grouping is not.

`createGuestCheckoutResume` and `createGuestOrderFetcher` live on
`@openreceive/browser`, not `/headless`, because the guest-resume
controller is host behaviour (storage, order fetch). `/headless` carries
only `enterCheckoutResumePath`, the History API write itself.

## `openWallet` is `location.assign`

The default path is `location.assign("lightning:…")` on the **current**
window. With no registered handler it is a dead primary CTA beside the QR.
With one it walks the payer off the page that was about to tell them they
had paid. The drop-in renders a wallet button only if you pass
`components.OpenWalletButton`. Pass `open` to route the URI somewhere that
is not the checkout window.

## Session `swap` option is all-or-nothing

`createCheckoutSession` takes `swap` as one option (`CheckoutSwapOptions`):
`selection` (five accessors over state you already hold), `prefix`, and
`fetch`, optionally `onStarted`. Supplying two of three used to leave
`startSwap` returning at the first `undefined` with no throw, no `onError`,
and no state change. Omit `swap` entirely for Lightning-only; `startSwap`
then reports through `onError` rather than doing nothing.

Pass the prepared snapshot back as `requestCheckout({ previous })` to keep
sibling attempts (a live swap beside the new bolt11) and to keep the
catalog against a server older than contract 0.4.1.
