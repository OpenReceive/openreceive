# Checkout design notes

These are contributor notes behind the public checkout guides. Integrators
should start at [Frontend checkout](../guides/frontend-checkout.md),
[Checkout UX](../guides/checkout-ux.md), and
[Headless checkout](../guides/headless-checkout.md). This page covers the
reasons and the gotchas those guides no longer spell out.

## Status `phase` is not the snapshot `phase`

`createCheckoutStatusModel` returns its own `phase`. It does not pass the
snapshot's `phase` through.

When a snapshot is not terminal but its countdown has reached zero, the model
reports `expired`. The screen changes the moment the clock runs out. If you
render the snapshot's raw `phase` instead, you show a live checkout over a dead
bolt11 until the next poll corrects it.

`title` and `detail` on the model are the finished strings for the payer. Both
shipped renderers print them. Do not rewrite them.

## Progress is a status, not a position

Three sets of values come off the wire. In all three, most values are not steps
on the forward path:

| Type | Values | Of which |
| --- | --- | --- |
| `Status` | 4 | one in-progress, three outcomes |
| `CheckoutPhase` | 6 | `invoice_created`, `verifying`, `settled`, `expired`, `failed`, `cancelled` |
| `SwapProviderState` | 12 | including `refund_required`, `refund_pending`, `refunded`, `attention` |

A Cart → Pay → Done stepper has room for exactly one of those values per
column. It has nowhere to put an expired invoice, a failed swap, or a refund in
review. A progress bar driven by a host's stage enum stays lit on "Pay" over an
invoice that expired ten minutes ago. It draws the refund flow as "step 2 of 3".

So the shipped renderers draw a status line and a backwards breadcrumb, with no
forward stepper. Going back is `checkoutLabels.switchPaymentMethod`, not a step
back. The only `onStep` in the shipped UI belongs to the provider tutorial
carousel. That is a slideshow, and it makes no claim about progress.

If a custom UI still wants a stepper, it must decide where `expired`,
`failed`, `cancelled`, and the refund states go. They are not points on a line.

## Network selection map

`resolveWizardSelection` returns `selectedAssetByGroup`. Its keys are **group
keys** (`USDT`). Its values are the chosen option's **`pay_in_asset`**
(`USDT_TRON`), not its `network_label`. Writing the wrong value still
type-checks. The tile just stays unselected, with no error.

A group with one option comes back as `start_swap`, never `choose_network`. We
ask the network question because the deposit address depends on the network,
and sending on the wrong one cannot be undone. Asking it for SOL would teach the
payer that the step is a formality. One screen later, for USDT, it is the whole
decision.

`createMethodGridDisplay` applies the same rule per tile, through
`needsNetworkStep` / `startPayInAsset`.

## Deposit risk is derived, not tabulated

`swapDepositRisk(payInAsset)` asks two questions. Does the address format pin
the chain? Is the asset that chain's native coin? A rail it does not recognize
gets the full alarm. What matters is **whether the address is ambiguous, not
whether the asset is native or a token**:

| Rail | Address | Reachable mistake | Panel |
| --- | --- | --- | --- |
| `ETH_ETH` | `0x…` | chain ambiguous (same string on six EVM chains) | full alarm |
| `USDT_ETH` / `USDC_ETH` | `0x…` | chain + asset ambiguous | full alarm |
| `USDT_TRON` | `T…` | chain pinned; USDT is in every exchange withdrawal dropdown | full alarm |
| `SOL_SOL` | base58 ed25519 | SOL exists on no other chain | quiet |

`ETH_ETH` is a native coin, yet it needs the alarm more than anything else on
the list. A banner shown on every rail gets read on none. The display model
already carries this as `depositRisk` (`"chain_ambiguous" | "asset_only" | "pinned"`)
and picks its own heading. Do not keep a rail list of your own.

QR amount prefill is a different question. That one really does depend on
native coin versus token.

## Deposit QR amount prefill

Only native-coin rails put an amount in the QR:
- `ETH_ETH` emits `ethereum:<address>?value=<wei>`
- `SOL_SOL` emits `solana:<address>?amount=<sol>`

Token rails (`USDT_TRON`, `USDT_ETH`, `USDC_ETH`, and any future ERC-20/TRC-20)
encode the **bare address**. Wallets parse the EIP-681 token-transfer form
inconsistently. A wallet that misreads it shows a broken request, which is
worse than no prefill.

If the checkout cannot convert a `deposit_amount`, it raises. The alternative,
a payment URI with no amount, would let the payer type any amount against a
fixed-rate order. That would be worse.

On token rails the payer types six decimals by hand. Copy `depositAmount`
**bare**, because `"0.032664 SOL"` is not something a wallet amount field
accepts. The model keeps `depositAmount`, `assetLabel`, and `networkLabel`
separate on purpose. `networkWarningEmphasis` is for reading, not copying.

A missing `deposit_memo` is worse than an underpayment. A deposit that arrives
without it may not be creditable, and there is no `refund_required` to act on.

## QR encoding is async

`createQrSvg` and `createQrPayloadSvg` are both async. React types
`dangerouslySetInnerHTML.__html` as `string | TrustedHTML`. `TrustedHTML` is an
empty interface that every object satisfies. So passing the promise straight in
type-checks, and renders the literal text `[object Promise]`.

`createQrSvgController` solves this:
- call `show(invoice)` or `showPayload(payload)` whenever the payload changes
- render whatever `onValue` last handed you
- an encode that finishes after the payload changed is dropped
- call `stop()` on teardown

## `mergeAttemptIntoSnapshot` argument order

The order is `(attempt, snapshot)`, which is the reverse of what the name
suggests. TypeScript catches the arguments in the wrong order either way. The
function folds a started attempt into the running snapshot. That makes the
deposit the active invoice without dropping a still-valid Lightning sibling.

## Refund staging survives polling

The refund address the payer is typing lives in the browser. The server does
not know about it until confirm, so a raw `/swaps/status` answer omits it.
- `stageSwapRefund` posts `/swaps/status` and holds the address.
- `confirmSwapRefund` is the only call that posts `/swaps/refunds`.

If you wire the review button to the confirm call, the confirmation step is
silently skipped.

The controller folds the staged attempt into every snapshot it publishes. It
does this before `onSnapshot` and before the derived state. So a host that
stores what it is handed keeps the field. There is no overlay rule to remember.

Exactly one provider state allows a refund: `refund_required`. At confirm time
the server re-reads the live state and answers `409 CONFLICT` for anything
else. Treat that as a normal outcome.

An overpayment is `refund_required`. The provider returns the whole deposit,
because the payout is a fixed-amount bolt11 and there is nothing to exchange
the surplus into. A deposit that missed a required memo is neither: it needs a
human. `completed` means the **provider** is done. It does not mean settlement.
Settlement is the wallet sweep, proven by payment hash.

`POST /checkouts/prepare` returns the amount and the pay-in catalog, and
**no attempts**. So a checkout rebuilt from the reference alone opens on the
method grid. Selecting the same coin again re-serves a live attempt. After
expiry, though, it creates a new deposit address. The durable handle is the
payment hash, through `POST /swaps/status`. See
[Swap refunds](../guides/swap-refunds.md).

On `refund_required`, `refund_pending`, and `refunded`, the deposit panel
actively misleads the payer. Remove the QR, address, amount, and fee
breakdown. Remove "switch payment method" on `refund_required` only. Once the
state is `refund_pending`, switching method is how the payer can still buy.

`createTransactionDetails` returns no rows while the rail is `checkout_lock`.
That is the deferred placeholder shown before the payer has chosen anything.
Render the caret only when there are rows.

## Wallet suggestions

`@openreceive/provider-data` is a hard dependency of `@openreceive/browser`.
The registry is static data. It does not prove that a provider will complete a
payment, quote a fee, or serve the payer's jurisdiction.

`getPaymentWizardRoutes()` with no arguments returns `btc-lightning`. The
registry also carries `usdt`, `usdc`, `eth`, `xmr`, `ltc`, `trx`, `sol`,
and `xrp`. But those list exchanges that convert an asset *into* a Lightning
payment. On a deposit panel, mid-payment, they would send the payer the wrong
way.

The registry returns about 37 Lightning providers. There is no default preview
limit, because the shipped renderers draw the whole grid on a screen that has
room for it. A fixed-height panel should pass `providerPreviewLimit` and build
"show all" from `display.providerCount`. `OPENRECEIVE_PROVIDER_PREVIEW_LIMIT`
is the number the shipped styles are designed for.

Everything the checkout draws ships inside the JavaScript:
- The payment-method icons are compiled into `@openreceive/browser`
  (`paymentIconSvgs`, generated from `src/assets/icons/*.svg`). The custom
  element draws them inline in its shadow root. `paymentIconUrls` hands the
  same markup to any `<img>` as `data:` URIs. Inline SVG is allowed only there,
  for those first-party strings that the build checks.
- The wallet logos and pay tutorials are `data:image/webp` URIs generated into
  `@openreceive/provider-data` by `tools/package/generate-provider-images.mjs`.
  That script enforces a byte budget, so the bundle cannot grow silently. The
  logos are in the main bundle. The tutorials are in a chunk that
  `loadPayTutorialImages()` imports on first open. Hosts that split code defer
  that download. Single-file builds include it upfront.

Hosts deploy the complete JS/CSS output, including generated chunks. No host
serves an image. So there is no resolver, no base URL, and no module-relative
URL resolution. Earlier versions had several such layers: packaged `file://`
URLs, a resolver function, and a base-URL prop and attribute. Each one worked
around bundlers that cannot resolve a file from an import. Each one also gave
the host one more step to get wrong. For example, setting the base URL also
switched the compiled-in payment icons to files nobody had copied. The one
thing hosts still have to do is allow `data:` in their Content-Security-Policy
`img-src`.

We chose this on purpose. We give up caching images separately, and get a
single versioned delivery path in return. A newly added wallet's logo arrives
with the code that renders it. There is no separately deployed asset tree, and
no server-package version to match. Keep the small icons and logos, which have
a byte budget, loaded eagerly. Keep tutorial data behind a dynamic import for
hosts that split JavaScript. Include it in the standalone file for hosts
without a bundler. Do not add a second way to deliver images.

`npm run test:package-assets` checks the extracted npm packages in Chromium. It
builds them with esbuild (with and without splitting), Vite, and webpack, using
React and custom elements, and it also checks the standalone release archive.
The test:
- decodes every image table
- opens tutorials from a nested URL
- forbids image requests
- checks the caption fallback when a tutorial chunk fails to load

It runs in Docker on every PR.

## Headless surface curation

A symbol is on `/headless` if and only if one of OpenReceive's renderers
imports it by name, or a real headless integration needs it. Never use
`export *`. The renderers and the flagship example compile against exactly
this surface, so both also serve as its regression test.

Neither [Headless checkout](../guides/headless-checkout.md) nor
[Headless surface inventory](headless-surface.md) can drift from the entry
module. Both contain generated blocks, and
`node tools/docs/generate-headless-surface.mjs --check` fails the gate
when either is stale.

The leftovers block in the public guide lists every exported symbol that the
hand-written sections do not name in backticks. A script checks that the list
is complete. Nothing checks that the grouping is right.

`createGuestCheckoutResume` and `createGuestOrderFetcher` live on
`@openreceive/browser`, not `/headless`. The guest-resume controller is host
behaviour: it handles storage and fetching the order. `/headless` carries only
`enterCheckoutResumePath`, which does the History API write itself.

## `openWallet` is `location.assign`

By default it calls `location.assign("lightning:…")` on the **current**
window. If no handler is registered for `lightning:`, the main button next to
the QR does nothing. If one is registered, it takes the payer away from the
page that was about to tell them they had paid. So the drop-in renders a wallet
button only if you pass `components.OpenWalletButton`. Pass `open` to send the
URI somewhere other than the checkout window.

## Session `swap` option is all-or-nothing

`createCheckoutSession` takes `swap` as one option (`CheckoutSwapOptions`). It
holds `selection` (five accessors over state you already hold), `prefix`, and
`fetch`, and optionally `onStarted`. It used to be possible to supply two of the
three. Then `startSwap` returned at the first `undefined`, with no throw, no
`onError`, and no state change. For Lightning-only, omit `swap` entirely.
`startSwap` then reports through `onError` instead of doing nothing.

Pass the prepared snapshot back as `requestCheckout({ previous })`. This keeps
sibling attempts, such as a live swap beside the new bolt11. It also keeps the
catalog when the server is older than contract 0.4.1.
