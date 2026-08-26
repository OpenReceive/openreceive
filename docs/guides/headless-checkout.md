# Headless checkout

There are two supported ways to build an OpenReceive checkout UI:

1. **Drop-in** — `<Checkout>` from `@openreceive/react` (or the custom elements
   from `@openreceive/elements`, and the vue/svelte/angular wrappers on top of
   them). Start here; see [Frontend checkout](frontend-checkout.md).
2. **Headless** — bring your own components and state management and build on
   the engine directly via `@openreceive/browser/headless`. This is the
   supported, semver-guaranteed surface for custom UIs; the
   `examples/hello-fruit/server/rails` app (custom mobx-keystone stores +
   components over the headless engine) is the flagship demo of this style.

`/headless` is also the floor under OpenReceive's own renderers:
`@openreceive/react`, `@openreceive/elements`, and the vue/svelte/angular
wrappers import exactly this surface and nothing private. What a renderer can
do, a headless integration can do; there is no second, undocumented subpath.
Everything not on the list is package-private and free to move.

## One URL: `prefix`

Every call on this surface that talks to the server takes `prefix` — the base
path the shipped router is mounted at (default `/openreceive`) — and derives its
own route from it: `/checkouts`, `/checkouts/prepare`, `/payments/check`,
`/swaps`, `/swaps/quote`, `/swaps/status`, `/swaps/refunds`. There is no
per-route override, and no URL templating. A headless host holds one string.

```ts
const snapshot = await prepareCheckout({ reference, prefix: "/openreceive" });
const refresh = createStatusFetcher({ prefix: "/openreceive", snapshot });
const started = await startSwapRequest({
  fetch: globalThis.fetch,
  prefix: "/openreceive",
  reference,
  payInAsset: "USDT_TRON",
});
```

## The `@openreceive/browser/headless` surface

Checkout lifecycle:

- `prepareCheckout` / `requestCheckout` — the prepare-then-mint calls (also on
  the main entry). Both take `{ reference, prefix }`. The mint response echoes
  `payment_methods`, so the picker keeps its options on its own; pass the
  prepared snapshot back as `requestCheckout({ previous })` to also keep
  sibling attempts (a live swap beside the new bolt11), and to keep the catalog
  against a server older than contract 0.4.1.
- `createCheckoutState`, `CheckoutState`, `CheckoutSnapshot`,
  `CheckoutInvoiceSnapshot` — engine state and snapshots.
- `selectCheckoutDisplayInvoice`, `isReusableLightningInvoice` — invoice
  display selection.
- `deriveStatus` / `Status`, `createStatusFetcher` (`{ prefix, snapshot }`),
  `OPENRECEIVE_DEFAULT_POLL_INTERVAL_MS` — status derivation and polling.
- `createCheckoutStatusModel` / `CheckoutStatusModel` — the payer-facing status
  line. This is a thing you RENDER, not plumbing you wire up. It returns
  `{ phase, waiting, title, detail, countdownPrefix, expires_in_seconds?,
  countdownLabel? }`, and its callers need two facts that are not visible from
  the type:
  - `title` and `detail` are **finished payer-facing copy** — the exact strings
    both shipped renderers print. Render them; do not rewrite them.
  - `phase` is **not** the snapshot's `phase`. A non-terminal phase whose
    countdown has reached zero is reported as `expired`, so the screen turns
    over the moment the clock does. Render the snapshot's raw `phase` instead
    and you show a live checkout over a dead bolt11 until the next poll
    disagrees. Read the model's, never the snapshot's.
- `postJson`, `BrowserRequestError` — the HTTP helper and
  error type the engine's calls share. It takes `{ fetch, prefix, body }`.

Payment methods and wizard model:

- `paymentMethods`, `PaymentMethod`,
  `CheckoutPaymentMethod`.
- `buildMethodGridEntries` / `MethodGridEntry`,
  `createPaymentWizardModel` / `PaymentWizardModel`,
  `createPaymentWizardSelection` /
  `updatePaymentWizardSelection` /
  `PaymentWizardSelection`,
  `resolvePreservedNetworkSelection`.
- `createWizardRouteDisplays` / `WizardProviderDisplay`,
  `getRouteNetworkLabel`, `paymentAccentId`,
  `SwapMethodGroup`.

Swap flows:

- `startSwapRequest` (`{ fetch, prefix, reference, payInAsset }`),
  `normalizeSwapStartInvoice`.
- `createSwapDisplayModel` / `SwapDisplayModel` — the deposit panel as data.
  Read [The deposit values are the payer's to
  reproduce](#the-deposit-values-are-the-payers-to-reproduce) before you render
  it: three of these fields are things the payer has to retype by hand, and the
  model keeps them apart on purpose.
- `swapAssetMatchesRoute`, `swapPickerKey`,
  `formatSwapLimit`, `formatDepositAmount`.
- `swapDepositRisk` / `SwapDepositRisk` — how loud the deposit panel should be
  on this rail, as `"chain_ambiguous" | "asset_only" | "pinned"`. The display
  model already carries it as `depositRisk` and picks its own heading from it;
  the function is there so a custom UI can choose its own chrome without
  re-deriving the asset table. The axis is **address ambiguity, not
  native-vs-token** — `ETH_ETH` is a native coin and needs the alarm most of
  anything on the list, because a `0x…` address is the same string on six
  chains. See [Automated swaps](automated-swaps.md#which-deposits-can-actually-be-mis-sent).
- `mergeAttemptIntoSnapshot` / `mergeAttemptIntoCheckout` — fold a started
  attempt into the running snapshot, so the deposit becomes the active invoice
  without dropping a still-valid Lightning sibling.

Swap refunds. A deposit that arrives outside the provider's limits, or too
late, becomes refundable, and the payer has to give an address on their own
network. Three symbols, and the third is not optional:

- `requestSwapRefund` — POST the address (`{ fetch, prefix, reference,
  invoices, attemptId, refundAddress, confirm }`). `invoices` is **required**:
  the call finds the attempt by `attemptId` inside that array to recover its
  payment hash, and throws `Swap refund requires the original payment hash.`
  when nothing in it carries one. Pass every invoice you hold, not just the
  displayed one. See [Refunds](#refunds) for the flow around it.
- `getSwapRefundFormError` — the validation message for what the payer typed,
  before you let them submit.
- **`overlaySwapRefundStaging` — REQUIRED IF YOU POLL.** The refund address the
  payer is typing lives in your UI, not on the server, so the next
  `/swaps/status` tick overwrites it and the field empties itself mid-flow.
  Overlay the staged value onto every polled snapshot before you render it.
  This reads like one more helper and is not one.

Rendering the attempt — the pieces a custom UI would otherwise pull a second
library in for:

- `createQrSvg` / `createQrPayloadSvg` — the QR the shipped renderers draw. No
  second QR dependency.
- `openWallet` — hand a `lightning:` URI to the payer's wallet. **Touch devices
  only.** The default path is `location.assign` on the CURRENT window: with no
  registered `lightning:` handler the click is inert, and with one it navigates
  the payer off a checkout that is still polling `/payments/check`. The shipped
  `<Checkout>` renders no wallet button for exactly this reason and exposes
  `components.OpenWalletButton` as an opt-in slot instead — on a desktop the QR
  code IS the payment path, and a second CTA beside it is dead. Pass `open` to
  route the URI somewhere that is not the checkout window.
- `getNetworkIcon`, `getSwapOptionIcon`, `getPaymentMethodIcon`,
  `paymentIconUrls` — the packaged asset URLs behind the method grid.
- `AssetUrlResolver` and `paymentIconPaths` — **the escape hatch you need under
  any bundler that is not Vite/Rollup.** The packaged URLs above are resolved
  against `import.meta.url`, which webpack and friends replace at build time
  with the module's own on-disk path — so every icon comes out as a dead
  `file:///…/node_modules/…` URL that also leaks your server's layout. Each
  display builder (`createWizardRouteDisplays`, `createWizardRouteAssetDisplays`,
  and the icon getters above) takes an optional
  `resolveAssetUrl: (packagedPath: string) => string` and hands it the packaged
  PATH instead; `paymentIconPaths` is that key set for this package's own icons,
  and `WizardProviderDisplay.iconPath` / `tutorials[].path` are the keys for the
  provider art. Serve the files yourself and map them. See
  [Provider registry → assets](provider-registry.md#assets-are-files-your-host-serves).

Formatting and labels:

- `formatMsats`, `formatFiatAmount`,
  `formatNetworkSummary`, `formatChooseNetworkHeading`,
  `createLightningInvoiceDecodeUrl`.
- `checkoutLabels` — **every payer-facing string the shipped renderers emit.**
  Read it before you write copy. A custom UI is a third renderer, and these
  strings are the contract that keeps the three saying the same thing; the
  duplication between the React and element renderers is precisely the drift the
  object exists to prevent. The ones a custom UI re-invents first:

  | Label | Value |
  | --- | --- |
  | `copyInvoice` / `copied` | "Copy invoice" / "Copied" |
  | `switchPaymentMethod` | "Switch payment method" — the breadcrumb back-link once a method or swap is already selected |
  | `chooseNetwork` / `selectNetwork` | the network-reveal heading and its options |
  | `continue` | the picker's confirm action |
  | `transactionDetails` | the details panel's summary |

  It also carries `preparingPayment`, `networkSummary`, `chooseAssetNetwork`,
  `wrongCurrencyOrNetworkTitle` / `sendExactAmountTitle`, the `swapUnavailable*`
  family and ~30 more. If you need a string the shipped UI already shows,
  it is in here.

The payer's receipt:

- `createTransactionDetails` / `createTransactionDetailsFromState` /
  `resolveTransactionDetailRows`, `TransactionDetailRow`,
  `TransactionDetailsInput`, `TransactionDetailsSource` — see
  [The receipt is not debug output](#the-receipt-is-not-debug-output).
- `createPaymentDataEntries` / `PaymentDataEntry` / `PaymentDataSource` —
  **deprecated.** The older, plainer builder for the same panel: label/value
  rows with no `copyValue`, no explorer link and no truncation contract, and a
  strict subset of the rows above. The shipped renderers moved their settled
  panel off it. Kept exported so a UI already built on it is not broken; use
  `createTransactionDetails` instead.

Styling tokens (the contract with the shipped `styles.css` — an interface by
nature, so custom UIs reuse the same class names and data attributes):

- `orClasses`, `assetButtonClasses`,
  `networkButtonClasses`, `networkCheckClasses`,
  `networkMobileRevealClasses`,
  `networkSummaryIconClasses`.
- `OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES`, `createCheckoutProviderCopyEvent`.

Element plumbing (tag names, attribute/event constants, element factories)
lives on `@openreceive/elements`, not here: `defineElements`,
`createThemeToggleElement`, `OPENRECEIVE_CHECKOUT_ELEMENT_TAG_NAME`
/ `_ATTRIBUTES` / `_EVENTS`, and the theme-toggle equivalents.

## Progress is a status, not a position

A three-step "Cart → Pay → Done" bar is the default thing a UI developer reaches
for, and it cannot express what this engine reports. Three vocabularies come off
the wire, and the forward path is the minority of all three:

| Type | Values | Of which |
| --- | --- | --- |
| `Status` | 4 | one in-progress, three outcomes, two of them failures |
| `CheckoutPhase` | 6 | `invoice_created`, `verifying`, `settled`, `expired`, `failed`, `cancelled` |
| `SwapProviderState` | 12 | including `refund_required`, `refund_pending`, `refunded`, `attention` |

A stepper has room for exactly one of those per column, and no column for
`expired`, `failed`, `cancelled`, or any of the four refund states. Worse, a bar
indexed off your own stage enum sits lit on "Pay" over an invoice that expired
ten minutes ago, and draws the refund flow — the one place a payer most needs to
be told where they are — as "step 2 of 3".

That is why the shipped renderers draw a **status line plus a backwards
breadcrumb and no forward stepper**. Progress here is a status, not a position:

- render `createCheckoutStatusModel`'s `title` / `detail` (and `countdownLabel`)
  as the status line, reading the MODEL's `phase`, per the bullet above;
- carry backwards movement with `checkoutLabels.switchPaymentMethod`, a
  breadcrumb back-link, not a step-back;
- if you still want a stepper, you own the answer to where `expired`, `failed`,
  `cancelled` and the refund states go. The honest answer is that they are not
  points on a line.

The one `onStep` in the shipped UI is the provider tutorial carousel — a
slideshow of how-to-pay screenshots, which makes no claim about progress.

## The method picker, and what to say about a method you cannot offer

A $1.00 cart can render four greyed tiles. Several of those coins are usually a
dollar or two away, so it is a recoverable cart and not a dead end — but only if
the payer is told the number. Everything needed is on this surface:

- `buildMethodGridEntries` / `MethodGridEntry` builds the grid, and
  `swapGroupLimitOption` picks which entry in a group to quote from: a group's
  unavailability is quoted from its **cheapest entry point**, so "USDT" reports
  the lowest floor of its networks rather than whichever one happens to be
  first.
- `SwapLimitContext` is just `{ amount_msats, fiat }` off the snapshot. That
  pair plus the option is the whole recipe — everything below takes exactly
  those two.
- `swapOptionLimitMessage` — the short **label** for a tile:
  `"Minimum amount $2.43"`.
- `swapOptionLimitSentence` — the same limit as one finished **sentence**:
  `"To pay with SOL, your cart total must be at least $2.43."` The tile-level
  form: a grid that disables a tile has room for a tooltip or a caption and
  nowhere to put four parts. Its third argument, `{ label }`, names the group
  ("USDT") rather than the one network behind it.
- `createSwapUnavailableModel` / `SwapUnavailableModel` — the four-part **pane**
  (`{ title, detail, range, hint }`) for the case where the payer picked the
  asset and navigated to it. This is what the drop-in renders.
- `formatSwapLimit` — the lowest-level form, when you want the figure alone
  (`"$2.43"`) and nothing else. Takes `(context, limitMsats, "ceil" | "floor")`.

All four are built from the same figures with the same ceil/floor rounding, so
a tile, a tooltip and a pane can never quote different numbers. Reach for the
one that matches the shape you are rendering; do not regex the number back out
of a label.

## Network selection: only ask when it is a real question

`payment_methods` groups by `label`, and the groups are **not uniform** — USDT
has three networks today, USDC two, SOL one, ETH one. A two-step picker built
the obvious way therefore asks "Which network are you sending SOL on?" above a
single tile.

Do not do that. **A group with one option has no network question: start the
swap straight from the tile. Only `options.length > 1` earns a second step.**
Both shipped renderers gate on exactly that test, and the custom element goes
further and calls `startSwap` directly from a single-option tile — so a custom
UI that asks anyway looks wrong beside the drop-in.

The reason is not tidiness. The network question exists because the deposit
address is network-specific and a wrong send is unrecoverable — which is
precisely why it must not be asked when it is not a real question. Ask it on
`SOL` and you have taught the payer that the network step is ceremony to click
past, one screen before `USDT`, where it is the whole ballgame.

The helpers that carry the rule:

- `findSwapGridGroup` — the group behind a picker key, and the thing you count
  `options` on.
- `updateSelectedSwapNetworks` — per-coin network selection after a tile is
  picked. It returns the map unchanged for non-swap keys **and for
  single-network groups**, so the rule is already baked in if you route through
  it.
- `wizardNetworkGroupIds` — the `aria-controls` / `aria-labelledby` id pair for
  a group's disclosure panel and heading. One helper so the two ids cannot
  disagree, between the renderers or within one.
- `formatChooseNetworkHeading` — the heading copy for the step, when there is
  one.

## The deposit values are the payer's to reproduce

On `USDT_TRON`, `USDT_ETH`, `USDC_ETH` and any future ERC-20/TRC-20 rail, the
deposit QR encodes the bare address and carries **no amount** (see
[Automated swaps → Deposit QR amount prefill](automated-swaps.md#deposit-qr-amount-prefill)
for why). The consequence is the part that matters to a UI: the payer types six
decimals by hand, and a short send against a fixed-rate order is
`refund_required` — a refund-address form and a round trip.

So `SwapDisplayModel` is not just data to display. Three of its fields are
values the payer must **reproduce exactly**, and each one owes them a labelled
row with a copy button:

| Field | Row |
| --- | --- |
| `depositAddress` | Address |
| `depositMemo` | Memo — when present it is part of the address, not a note. A deposit sent without the destination tag may not be creditable, and it produces no `refund_required` to act on |
| `depositAmount` | Amount |

**Copy `depositAmount` bare** — the number alone, with no asset symbol.
`"0.032664 SOL"` is not something a wallet's amount field accepts. The model
keeps `depositAmount`, `assetLabel` and `networkLabel` as separate fields for
exactly this reason; `networkWarningEmphasis` is the joined display string, and
it is for reading, not for copying.

Both shipped panels do this today — Address, Memo and Amount each get their own
copy row, with the address and the amount also selectable. A custom UI owes the
payer the same.

## Refunds

A deposit that arrives outside the provider's limits, or too late, becomes
refundable, and the payer has to give an address on their own network. This is
the flow the three symbols above sit in.

**Exactly one state allows it: `refund_required`.** The server re-reads live
provider state at confirm time and answers `409 CONFLICT`
`Swap cannot be refunded from provider state <state>.` for anything else, so the
state can and does change under the payer between the two steps. Handle that
409 as a normal outcome, not as an error screen.

**It is a two-step review-then-confirm, and the first step does not touch
`/swaps/refunds` at all.** `confirm: false` posts `/swaps/status` and rides the
typed address back on the returned snapshot so you can show it for
confirmation; only `confirm: true` submits. Authorization and the provider-state
refresh happen on the host, on the confirmed request.

**`overlaySwapRefundStaging` is required if you poll.** The address the payer is
typing lives in your UI, not on the server, so the next `/swaps/status` tick
overwrites it and the field empties itself mid-flow. Overlay the staged value
onto every polled snapshot before you render it.

Validate before you submit with `getSwapRefundFormError(payInAsset, address,
networkLabel)`, which checks the address against the pay-in asset's own format —
these are checksum checks, not length guards, because a false accept sends money
nowhere recoverable.

The provider vocabulary a refund UI reads (`SwapProviderState`, 12 values):

| State | Meaning |
| --- | --- |
| `creating_provider_order`, `awaiting_deposit`, `confirming`, `exchanging`, `paying_invoice` | the forward path |
| `completed` | the PROVIDER is done. **Not settlement** — settlement is the wallet sweep, proven by payment hash |
| `refund_required` → `refund_pending` → `refunded` | the refund path, and the only one a refund can start from |
| `expired`, `failed`, `attention` | terminal or needs a human |

`refund_reason` says why, and is one of `underpaid`, `late_deposit`,
`underpaid_and_late`. The asymmetry nobody guesses: an **overpayment is
`attention`, not a refund** — there is no `refund_required` to act on, and it
needs a human.

The same is true of a missing `deposit_memo`. When the provider supplies one,
it is part of the address: a deposit sent without the destination tag may not be
creditable, and it produces no `refund_required` either. That makes it strictly
worse than an underpayment, which is why the deposit panel renders the memo
beside the address rather than below the fold.

## The receipt is not debug output

After settlement the payer is holding a payment hash and, on a swap, a deposit
txid. That is their entire evidence that they paid. A UI that never shows those
values — or shows them un-copyable — makes the merchant's support inbox the
payer's only recourse in a dispute, which is precisely the dependency Lightning
removes. Render them.

`createTransactionDetails(input)` (and `createTransactionDetailsFromState(state)`
for a `CheckoutState`, or `resolveTransactionDetailRows(source)` when you have
any of the three) builds the whole panel as `TransactionDetailRow`s:

```ts
interface TransactionDetailRow {
  label: string;       // shown
  value: string;       // shown, possibly SHORTENED for display
  copyValue?: string;  // the untruncated string — copy this, never `value`
  href?: string;       // block-explorer link, when the row's value has one
  hrefLabel?: string;
}
```

The rows cover the order and checkout ids, the rail, transaction and workflow
state, the amount in sats and in fiat, the bolt11, the payment hash, settled and
expiry times, and — on a swap — the provider order id, attempt id, deposit
address and memo, deposit and payout transactions, refund address and
transaction, and the fee breakdown. The builder's contract is **public checkout
state only**: it never surfaces NWC or send-payment secrets.

Two rules:

- **`copyValue` is the untruncated value.** A payment hash renders as
  `cccccccc...cccccccc` and copies as all 64 characters. Wire the copy button to
  `row.copyValue ?? row.value`.
- **`href` is opt-in for the invoice.** Explorer links are built from the row's
  own value. The bolt11 gets a decode link only when the host passes
  `decodeLinkUrl`; omitted, the invoice never reaches a third party. That is the
  right default — pass it deliberately or not at all.

Render it **collapsed, in both places**: under the live checkout, and on the
post-settlement receipt or order page. The shipped renderers do exactly this,
and `@openreceive/react`'s `<TransactionDetails>` /
`@openreceive/elements`' `renderTransactionDetailsHtml` are the same panel if
you would rather mount it than build it — including on your own order page,
outside the checkout.

## Symbol inventory

The sections above say what each group is FOR — that grouping is hand-written,
and it is where a symbol earns an explanation. Completeness is machine-checked
separately: everything on the surface that no section above names appears in
the generated block below, so a promoted symbol cannot sit undocumented and a
dropped one cannot linger. The full sorted inventory, with the same guarantee,
is [docs/internal/headless-surface.md](../internal/headless-surface.md).

<!-- BEGIN GENERATED: headless-symbols-uncovered -->
<!-- Generated by tools/docs/generate-headless-surface.mjs from packages/js/browser/src/headless.ts. Promote or drop the symbol there, then rerun the generator; never edit this block by hand. -->

Also on the surface, in no group above (88 symbols) — element
and theme plumbing, wizard/icon helpers, attribute parsers and log types:

- `applyCheckoutElementAttributes`
- `assertDisplayInvoice`
- `BrowserLogContext`
- `BrowserLogger`
- `BrowserLoggerOption`
- `CheckoutComponentProps`
- `CheckoutController`
- `CheckoutControllerOptions`
- `CheckoutElementAttributeOptions`
- `CheckoutElementAttributes`
- `CheckoutElementEventHandlers`
- `CheckoutElementListeners`
- `checkoutElementStyles`
- `CheckoutPropsValidation`
- `CheckoutSession`
- `CheckoutSessionOptions`
- `CheckoutShellElements`
- `CheckoutShellModel`
- `CheckoutShellOptions`
- `CheckoutStatusRefresh`
- `createBlockExplorerUrl`
- `createCheckoutActionEvent`
- `createCheckoutController`
- `createCheckoutElementAttributes`
- `createCheckoutElementListeners`
- `createCheckoutErrorEvent`
- `createCheckoutSession`
- `createCheckoutShell`
- `createCheckoutShellModel`
- `CreateCheckoutShellOptions`
- `createCheckoutSnapshotFromInvoice`
- `createCheckoutStateEvent`
- `createDetailExternalLink`
- `createPaymentWizardController`
- `createStoredThemeModel`
- `createThemeChangeEvent`
- `createThemeModel`
- `createThemeToggleElementAttributes`
- `createTickingValueController`
- `createTransientFeedbackController`
- `deriveCheckoutStateLabels`
- `DetailLinkKind`
- `enterCheckoutResumePath`
- `escapeHtml`
- `formatAmountCaption`
- `formatUnixTime`
- `getExplorerNetwork`
- `getWizardEmptyMessage`
- `OPENRECEIVE_CHECKOUT_DATA_SELECTORS`
- `OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES`
- `OPENRECEIVE_CHECKOUT_ELEMENT_EVENTS`
- `OPENRECEIVE_CHECKOUT_ELEMENT_PART_SELECTORS`
- `OPENRECEIVE_CHECKOUT_ELEMENT_PARTS`
- `OPENRECEIVE_COPY_FEEDBACK_MS`
- `OPENRECEIVE_DEFAULT_PREFIX`
- `OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES`
- `OPENRECEIVE_PAYMENT_WIZARD_SELECTORS`
- `OPENRECEIVE_THEME_STORAGE_KEY`
- `OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES`
- `OPENRECEIVE_THEME_TOGGLE_ELEMENT_EVENTS`
- `OPENRECEIVE_THEME_TOGGLE_ELEMENT_PART_SELECTORS`
- `OPENRECEIVE_THEME_TOGGLE_ELEMENT_PARTS`
- `OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME`
- `parseBooleanAttribute`
- `parseMethodPickerKey`
- `parseOptionalInteger`
- `parsePaymentMethod`
- `parseResolvedTheme`
- `parseThemePreference`
- `PaymentWizardController`
- `QrEncoder`
- `readThemePreference`
- `ResolvedTheme`
- `StoredThemeModelOptions`
- `SwapSelection`
- `syncStoredThemeControls`
- `ThemeModel`
- `ThemeModelOptions`
- `ThemePreference`
- `ThemeToggleElementAttributeOptions`
- `ThemeToggleElementAttributes`
- `toggleStoredThemeControls`
- `TransientFeedbackController`
- `UnixSeconds`
- `validateCheckoutProps`
- `WizardRouteAssetDisplay`
- `WizardRouteDisplay`
- `writeThemePreference`
<!-- END GENERATED: headless-symbols-uncovered -->

## Curation rule

A symbol is on `/headless` if and only if one of OpenReceive's renderers imports it by
name, or a real headless integration (the rails example, these guides) needs
it — never `export *`. The renderers and the flagship example compile against
exactly this surface, so both double as its regression test.

Neither this page nor
[docs/internal/headless-surface.md](../internal/headless-surface.md) can drift
from the entry module: both carry generated blocks, and
`node tools/docs/generate-headless-surface.mjs --check` fails the gate when
either is stale.
