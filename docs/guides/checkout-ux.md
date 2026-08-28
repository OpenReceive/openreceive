# Checkout UX

The shipped renderers — React's `<Checkout>` and the `<openreceive-checkout>`
custom element — already obey every rule on this page. It is written for the
integration that builds its own UI on `@openreceive/browser/headless`, and for
anyone deciding how much of the shipped checkout to keep or replace.

Each rule names the helper that already encodes it. That is the point: these are
not rules to re-derive in your own components, they are rules the packages hold
for you, and the failure mode is a UI that quietly disagrees with the one the
payer would have got for free.

## Do not draw a progress stepper across the checkout

Progress here is a STATUS, not a position on a line. Three vocabularies come off
the wire and the forward path is the minority of all three: `Status` is four
values (`pending`, `settled`, `expired`, `failed`) — one in-progress, three
outcomes; `CheckoutPhase` is six (`invoice_created`, `verifying`, `settled`,
`expired`, `failed`, `cancelled`); `SwapProviderState` is twelve, including
`refund_required`, `refund_pending`, `refunded` and `attention`. A stepper has a
slot for exactly one of those per column, and there is nowhere on a
Cart → Pay → Done bar to put an expired invoice, a failed swap, or a refund in
review.

Render `createCheckoutStatusModel` instead — `{ phase, waiting, title, detail,
countdownPrefix, expires_in_seconds?, countdownLabel? }`, no ordinal anywhere.
`title` and `detail` are FINISHED payer-facing copy, the same strings both
shipped renderers print; do not rewrite them. Read the MODEL's `phase`, never
the snapshot's: a non-terminal phase whose countdown has reached zero is
reported as `expired`, so the screen turns over the moment the clock does
instead of claiming a live invoice over a dead bolt11 until the next poll
disagrees. Backwards movement is a breadcrumb, not a step back.

Neither shipped renderer draws a stepper. That is a deliberate choice about a
state model that is mostly outcomes, not an omission for you to fill in.

## Show the payer what they are buying, not just an amount

The shipped checkout renders the total and never the order — it cannot, because
OpenReceive never owns your line items — so a stock integration is a QR, "$1.00",
and no sign of what the dollar is for. That is a conversion problem you inherit
by default.

The one-line fix is on the server: return an optional `description` beside the
price from `amountFor` (`config.amount_for` in Rails), and both drop-ins render
it above the amount on every screen. It is ONE display string, deliberately — a
line-item schema would make OpenReceive own the order. For anything richer the
host supplies markup: React's `<Checkout>` takes a render-prop `children`
receiving the live model, and the custom element projects `slot="order"`
children into its shadow root. A headless UI owns the whole screen and has no
excuse at all.

## Ask "which network?" only when there is a question to ask

Payment methods group by `label`, and the groups are NOT the same size: USDT is
on three networks, USDC two, SOL and ETH exactly one. A single-network asset has
no question to ask, so start its swap straight from the tile.

The question exists ONLY because the deposit address is network-specific and a
wrong send is unrecoverable, which is exactly why it must not be asked when it
is not a real question: ask it on SOL and you have taught the payer that the
network step is ceremony to click past, one screen before USDT, where it is the
whole ballgame.

You do not have to enforce this yourself — call `resolveWizardSelection` and
branch on `kind`. A one-network group comes back as `start_swap`, never
`choose_network`, so the mistake is unrepresentable; `choose_network` carries
the group, the heading, the aria id pair and the updated `selectedAssetByGroup`.
That map is **keyed by group key (`USDT`) and valued by the chosen option's
`pay_in_asset` (`USDT_TRON`)** — not by its `network_label`, which is the
obvious wrong write, type-checks, and simply leaves the tile unselected with no
error anywhere. `createMethodGridDisplay` takes the same map and carries the
same rule per tile as `needsNetworkStep` / `startPayInAsset`.

## An unavailable method must say why, in the payer's own currency

A greyed tile reading "unavailable" or "out of range" does not tell the payer
whether to add one dollar to the cart or give up, and the number that answers
that is already in the response you drew the tile from.

`createMethodGridDisplay` puts it on the tile as `limitMessage` ("Minimum amount
$2.71"), quoted from the group's cheapest entry point — the lowest bar the payer
could clear, not whichever network happened to be first.

## Every value the payer has to reproduce gets a copy row

Deposit address, memo/destination tag, AND the deposit amount. The amount is the
one that gets left out, and it is the one that costs money: on token rails
(USDT_TRON, USDT_ETH, USDC_ETH) the QR encodes the bare address and carries NO
amount, so the payer types `0.032664` by hand off your screen, and a wrong amount
against a fixed-rate swap order is an underpayment — which means
`refund_required`, a refund address form, and a payer who has to come back. A
badge or a sentence is not a copy affordance.

Render `display.copyRows` from `createSwapDisplayModel`: the rows are already
labelled, already ordered, and the amount is already BARE — it pastes into a
wallet's amount field, where "0.032664 SOL" is not a number.

A missing `deposit_memo` is worse than an underpayment, because a deposit that
arrives without it may not be creditable and there is no `refund_required` to act
on; it is a row like the others, never prose inside a warning banner.

## Scope the network warning to the rails where it is true

Render `swap.networkWarningTitle` and `swap.networkWarning` as the model gives
them. It scopes the "wrong currency or network = lost funds" alarm to the rails
where it is TRUE: the risk comes from the deposit ADDRESS failing to pin the
chain, so ETH_ETH, USDT_ETH, USDC_ETH and USDT_TRON get the full alarm, and
SOL_SOL — where a base58 ed25519 address is Solana-only — gets a plain "Send
exactly …" line instead of a red banner.

Do not hard-code one banner for every asset, and do not re-derive the rail table:
`depositRisk` is on the model. This is the same reasoning as the network picker —
ceremony where there is no question to ask teaches the payer to skip the screens
where there is.

## Put the provider suggestions under the Lightning invoice

A payer looking at a bolt11 and a QR is being asked to already own a Lightning
wallet; the registry answers "I have Cash App / Strike / Kraken — can I pay with
that?" and it is already installed. `@openreceive/provider-data` is a HARD
dependency of `@openreceive/browser`, so installing any UI package installs the
registry, its provider icons and its step-by-step pay tutorials with it.

Do not curate your own list of wallets and do not hand-build the rows:
`getPaymentWizardRoutes()` fed to `createWizardRouteDisplays` returns finished
`WizardProviderDisplay` rows — `{ id, name, kind, url, icon, iconPath, tutorials,
copyLabel, copiedLabel, openLabel }`, in the registry's rank order, with
`checkoutLabels` copy in them. A provider WITH `tutorials` opens the walkthrough
modal and one without is a plain link, both under the same `openLabel`. The
walkthrough's own first step is "copy the invoice", so it belongs to a live
invoice and must close when the payer changes payment method.

Three constraints:

**Show a few, not all of them.** The registry answers ~37 providers for
Lightning. Rendered in full under the invoice they push the QR off a
fixed-height panel — the desktop payment path. Pass `providerPreviewLimit` to
`createWizardRouteDisplays` (`OPENRECEIVE_PROVIDER_PREVIEW_LIMIT` is the number
the shipped styles are drawn against) and build a "show all" affordance from
`display.providerCount`, which is the untruncated total. There is no default
limit, because the shipped renderers draw the whole grid on a screen that has
room for it.

**Lightning only, and the default is already right.** `getPaymentWizardRoutes()`
with no arguments returns `btc-lightning`, the one route whose providers pay a
Lightning invoice directly. The registry also carries `usdt`, `usdc`, `eth`,
`xmr`, `ltc`, `trx`, `sol` and `xrp`, but those list exchanges that convert an
asset INTO a Lightning payment — a different path from the deposit address your
swap provider already quoted, and a mid-payment misdirection on a deposit panel.
Do not pass another route on a checkout.

**You host the images, and it is one string.** The packaged URLs resolve against
`import.meta.url`, which only works under Vite/Rollup; every other bundler yields
dead `file://` links that also publish your server's directory layout. Serve the
packages' `dist/assets` trees and point at them with the `assetBaseUrl` prop
(React and the Vue/Svelte/Angular wrappers) or the `asset-base-url` attribute on
`<openreceive-checkout>`. A server-rendered host can put
`node_modules/@openreceive/provider-data/dist/assets` and
`node_modules/@openreceive/browser/dist/assets` under one served root — the
merged tree is exactly the layout the attribute expects. `resolveAssetUrl` is the
function form, for a custom mapping — it cannot cross an HTML attribute, so it is
React-and-`defineElements` only. Grep your built bundle for `file://` before you
ship.

**Say they are suggestions.** The registry is static data and does not prove a
provider will complete a payment, quote a fee, or serve the payer's jurisdiction.
Present the list as a starting point, not an endorsement, and keep "any wallet
that pays a Lightning invoice works" on the screen.

## No "Open wallet" button on a desktop checkout

`openWallet` is `location.assign("lightning:…")` on the CURRENT window, and that
window is a live checkout polling for settlement: with no registered handler it
is a dead primary CTA sitting next to the QR that IS the desktop path, and with
one it walks the payer off the page that was about to tell them they had paid.

The drop-in agrees, and its own types say so: `<Checkout>` renders a wallet
button ONLY if you pass `components.OpenWalletButton`. Reach for it on touch
devices, where a `lightning:` URI hands off to a real wallet app, and let the QR
plus "Copy invoice" carry the desktop.

## Name the payment method in payer-facing controls

The back-link out of a chosen method has to say which of the coin, the network
and the cart is about to change. The package ships the string —
`checkoutLabels.switchPaymentMethod`, alongside `copyInvoice`, `copied`,
`chooseNetwork` and the rest. A headless UI that invents its own copy drifts from
the drop-in renderers for no reason: read `checkoutLabels` first, and only write a
string it does not have.

## Show the whole transaction record, collapsed behind a caret

The package builds it for you: `createTransactionDetails({ reference,
checkout_id, ...displayInvoice })` — or `createTransactionDetailsFromState(state)`
if you hold a `CheckoutState` — returns `{ label, value, copyValue?, href? }` rows
covering order and checkout ids, rail, amount in sats AND fiat, the bolt11, the
payment hash, settled/expires times, and every swap field the provider reported
(provider order id, deposit address and memo, deposit and payout transactions,
refund address, fee breakdown). `copyValue` is the untruncated string behind a
shortened display value, and `href` is a block-explorer or bolt11-decode link
where one applies.

Title it with `checkoutLabels.transactionDetails`, keep it collapsed by default,
and render it in TWO places: on the live checkout, and on the receipt or order
page AFTER settlement.

One exception, and the builder owns it: while the rail is `checkout_lock` — the
deferred placeholder a prepared checkout carries before the payer has chosen
anything — it returns NO rows. There is no transaction to describe yet, and
"both places" taken literally opens a "Transaction details" caret over a record
of nothing on the very first screen. Render the caret only when the rows are
non-empty, which is the check every caller already makes.

This is not developer debug output. A Bitcoin payment leaves the payer holding a
payment hash and a deposit txid, and those are the only evidence they have that
they paid you. A UI that never shows them makes your support inbox the payer's
sole recourse in a dispute. The rows are public checkout state by construction —
the builder never touches NWC or LSC secrets — so showing them leaks nothing.
Both shipped settled panels render this builder; rolling your own only drifts
from it.

## The refund screens

Because the wallet is receive-only, there is no merchant-initiated refund of a
settled Lightning payment. Swap refunds — a payer reclaiming a deposit that never
converted — are the only refund OpenReceive performs, and they are a two-step
review→confirm whose first step touches no refund route.
`controller.stageSwapRefund({ attemptId, refundAddress })` holds the address for
review; `confirmSwapRefund(...)` is the only call that submits it. Wiring the
review button to the confirm call silently skips the confirmation the payer
thinks they still owe.

Validate what the payer typed with `getSwapRefundFormError(payInAsset, address,
networkLabel)` before you let them submit — checksum checks, not length guards.
A refund is possible from exactly one provider state, `refund_required`, and the
server re-reads live state at confirm time: handle the `409 CONFLICT` as a normal
outcome, not an error screen. The whole flow, the twelve provider states, and the
overpayment/missing-memo asymmetry are in
[Headless checkout → Refunds](headless-checkout.md#refunds).

**A refund screen the payer cannot return to is the failure this section cannot
prevent on its own.** The deposit is already sent and the refund is a second
visit — often after the payer has gone to fetch an address from another wallet.
If your checkout lives at one route with no per-order path, closing the tab
takes the order id with it and the deposit is unreachable through the UI.
Nothing above stops that, because it is a routing decision, not a UI one.

Tell the model which you have: `createSwapDisplayModel(invoice, { resumable })`,
and render `display.refundReturnLabel` instead of picking a `checkoutLabels`
string yourself. Resumable, it says to bookmark the page; not resumable, it says
not to close the tab — telling a payer to bookmark a page that will not bring
them back is worse than saying nothing. The drop-ins infer it from `syncUrl` /
`routeReference` and take a `resumable` prop for a route they cannot see.

A resumable URL is the first of three layers, and on its own it returns the
payer to a method grid rather than to their refund: `/checkouts/prepare` carries
no attempts, so the attempt has to be restored too.
[Swap refunds](swap-refunds.md) is the whole route back, and the page to read
before you enable swaps.

**The refund screen replaces the deposit panel; it is not a form underneath
one.** On `refund_required`, `refund_pending` and `refunded`, take away the QR,
the address, the amount and the fee breakdown — a payer reading "send 15.01 USDT
to this address" beside a notice that their last send is being refunded sends
twice — and take away "switch payment method" on `refund_required`, where it
would dismiss the very attempt being refunded.

## Where these rules live in code

- [Frontend checkout](frontend-checkout.md) — the drop-ins that already obey them
- [Headless checkout](headless-checkout.md) — the display models named above
- [Automated swaps](automated-swaps.md) — the deposit panel and provider states
- [Swap refunds](swap-refunds.md) — the refund flow end to end, and the route back to it
- [Provider registry](provider-registry.md) — the wallet suggestions and their assets
