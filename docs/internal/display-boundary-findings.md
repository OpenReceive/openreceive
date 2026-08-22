# Display boundary findings: deferred instances

Working notes for the three known crashes found by the bug-class sweep behind commit
`beb00a0` and deliberately left unfixed — one numbered section each, and no fourth. The
sweep recorded six instances; "The count" at the foot of this document reconciles six
against three and says which of the six went where. Each section is meant to be enough
to pick the item up cold: where it lives, how a server value reaches a throw, how to
reproduce it, what it takes down, and what the fix looks like.

Line numbers are given with the symbol they point at, because they drift. Trust the
symbol.

## The bug class

One shape, repeated:

> A value arrives from a server. It crosses a parse boundary that bounds its **type**
> but not its **range** or **well-formedness**. It then reaches a **throwing formatter
> inside a render path**, where the throw escapes as a render error and takes the whole
> panel with it.

Every part of that matters. The parse boundary is not wrong to be permissive — it is
usually permissive on purpose, so that a field the server got wrong still reaches the
panel whose job is to report what arrived. The formatter is not wrong to throw — it is
usually shared with wire construction or validation, where a bad value is a bug that
must surface. What is wrong is the **join**: a formatter whose throw is correct at a
construction site is never correct at a display site, because the cost there is not one
field, it is the payer's screen — frequently the screen the payer reaches *after*
parting with their money.

## The rule this repo holds

Established in `beb00a0`; the canonical statement is the docstrings in
`packages/js/browser/src/internal/checkout-format.ts`.

**FORMATTERS THROW.** `formatOpenReceiveMsats` (`checkout-format.ts:104`) throws
`RangeError` on an unusable amount, and keeps throwing on purpose — wire construction
and amount validation call it too.

**DISPLAY BOUNDARIES BLANK.** `optionalMsatsLabel` (`:100`) and `optionalUnixTimeLabel`
(`:279`) wrap those formatters and return `undefined` instead. A malformed server value
costs **one label or one row**, never the screen. Callers keep rendering the raw value
next to the blanked label — the `Amount (msats)` and `... (unix seconds)` rows — so
nothing is hidden from whoever has to debug it.

`isDisplayableMsats` (`:79`) and `isDisplayableUnixSeconds` (`:258`) are the shared
predicates. Both are module-private on purpose while the boundaries built on them are
published: a caller reaching for the predicate is about to re-implement the boundary.
That was the half that kept getting forgotten.

`optionalDecimal` (`:33`) is the same pattern for provider decimal strings, and predates
the naming.

Applying the rule to a new instance is three questions:

1. Which formatter throws, and is its throw load-bearing anywhere else? If yes, leave it
   throwing and add a boundary. If nothing constructs or validates through it, the
   formatter itself can degrade — see `formatOpenReceiveUnixTime` (`:293`), which echoes
   its input rather than throwing, and says why in its docstring.
2. Is the predicate expressible once, module-private, next to the formatter?
3. Do the display sites still show the raw value under a relabelled row? Blanking must
   not erase the evidence.

---

## 1. MEDIUM — `encodeURIComponent` throws `URIError` on a lone surrogate (two call sites)

**File / symbol:** two call sites in one file.
`packages/js/browser/src/internal/checkout-links.ts:46`, inside
`createOpenReceiveBlockExplorerUrl`, and `:82` inside
`createOpenReceiveLightningInvoiceDecodeUrl`.

They are TWO SITES AND ONE ITEM, and saying so is what makes this document's arithmetic
add up: they share the throwing formatter, they take the same one-line predicate, and a
fix that lands at one and not the other leaves the bug live. "The count" therefore
scores them as one instance — the same way it scores each of the two fixed HIGHs as one
instance, though each of those spanned several sites too.

### Chain

1. A swap status poll returns a JSON body. `mergeSwapStatusIntoInvoice`
   (`checkout-transport.ts:337`) copies provider strings onto the invoice's swap
   snapshot at `checkout-transport.ts:359`:

   ```ts
   if (typeof status[key] === "string") merged[key] = status[key];
   ```

   That bounds the **type** and nothing else. `JSON.parse` produces a lone surrogate
   from the perfectly legal escape `\ud800`, so `typeof === "string"` is satisfied by a
   string that is not well-formed UTF-16.

2. `createOpenReceiveTransactionDetails` builds each row through its local `push`
   (`checkout-details.ts:61`), which calls `createOpenReceiveDetailExternalLink`
   (`checkout-details.ts:64`) for **every** detail row.

3. For a linkable label, `createOpenReceiveDetailExternalLink` (`checkout-links.ts:88`)
   dispatches to `createOpenReceiveBlockExplorerUrl`, which reaches
   `const encoded = encodeURIComponent(value);` at `:46` and throws
   `URIError: URI malformed`.

### Reachable fields — narrower than it first looks

The throw needs the row's label to be in the link allowlist (`checkout-links.ts:104-111`)
**and** the network to resolve to `ETH` / `SOL` / `TRON`. Measured:

| field | label | result |
| --- | --- | --- |
| `deposit_address` | Deposit address | `URIError` |
| `deposit_tx_id` | Deposit transaction | `URIError` |
| `refund_address` | Refund address | `URIError` |
| `refund_tx_id` | Refund transaction | `URIError` |
| `payout_tx_id` | Lightning payout | **no throw** — label is not in the allowlist, so `kind` is `undefined` and the function returns before `:46` |
| any of the above with `pay_in_asset: "BTC_LN"` | — | **no throw** — `getOpenReceiveExplorerNetwork` returns `undefined` at `:45` |

The bolt11 path is separate and also reachable: `invoice` plus a host-configured
`decodeLinkUrl` throws at `checkout-links.ts:82`. It is off by default (the host must
name a decoder), so it is the lower-traffic half.

Correcting the original write-up: `payout_tx_id` is **not** an instance here. It *is* an
instance of item 2 below, for a different reason.

### Reproduction

```js
import { createOpenReceiveTransactionDetails }
  from "packages/js/browser/src/internal/checkout-details.ts";

// exactly what the parse boundary produces from a legal \ud800 escape
const parsed = JSON.parse('{"provider_state":"confirming","deposit_tx_id":"9f\\ud800c1"}');
// typeof parsed.deposit_tx_id === "string", parsed.deposit_tx_id.isWellFormed() === false

createOpenReceiveTransactionDetails({
  invoice_id: "inv_1", rail: "swap",
  transaction_state: "pending", workflow_state: "invoice_created",
  swap: {
    provider: "fixedfloat", pay_in_asset: "USDT_ETH",
    deposit_address: "0xabc", deposit_amount: "12.5",
    provider_state: parsed.provider_state, provider_expires_at: 1800000000,
    deposit_tx_id: parsed.deposit_tx_id,
  },
});
// URIError: URI malformed
```

### Blast radius

`createOpenReceiveDetailExternalLink` routes every detail row, so the throw escapes
whichever renderer asked for the rows:

- React `<TransactionDetails>` (`packages/js/react/src/transaction-details.ts:26`).
- React `renderSwapDepositPanel` (`packages/js/react/src/swap.ts:172`) on the settled
  branch, which builds details at `swap.ts:283`.
- Elements `renderTransactionDetailsHtml`
  (`packages/js/elements/src/transaction-details.ts:21`), and therefore
  `createTransactionDetailsElement` (`:55`) and `renderElementTransactionDetailsHtml`
  (`packages/js/elements/src/render-swap-panel.ts:351`).

A settled swap with a malformed `deposit_tx_id` loses the entire panel — including the
"you have been paid" content — over a cosmetic explorer link.

### Fix

`encodeURIComponent` is the throwing formatter and its throw is correct: a URL built
from a malformed string would be a broken URL. So this wants a boundary, not a softened
formatter.

Add the boundary in `checkout-links.ts` next to the sites that use it — same shape as
`optionalMsatsLabel`, a module-private predicate plus the callers that consult it:

```ts
/** THE well-formedness rule for a value that will be percent-encoded. */
function isEncodableLinkValue(value: string): boolean {
  return value.isWellFormed();
}
```

Then `createOpenReceiveBlockExplorerUrl` returns `undefined` for a non-encodable value,
exactly as it already does for an unknown network at `:45`, and
`createOpenReceiveLightningInvoiceDecodeUrl` does the same at `:82`. Callers already
handle `undefined` — `push` at `checkout-details.ts:70` spreads no `href` — so the row
still renders with its raw value and simply loses its link. That is the rule's outcome:
one link, not one screen.

**Implementation gotcha, verified.** `String.prototype.isWellFormed` / `toWellFormed`
are ES2024. Node 22 has them (the engine floor is `>=22` in the root `package.json` and
in `packages/js/browser/package.json`), but the root `tsconfig.json` sets
`"lib": ["ES2022", "DOM"]`, so the call does not typecheck today:

```
error TS2550: Property 'isWellFormed' does not exist on type 'string'.
  Do you need to change your target library? Try changing the 'lib' compiler option to 'es2024' or later.
```

Bumping `lib` to `ES2024` fixes it and is repo-wide, so it is a decision, not a
detail — that is a large part of why this item was deferred. The alternatives that need
no bump: a regex for unpaired surrogates
(`/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/`), or
`try { encodeURIComponent(value) } catch { return undefined }`. The `try` is the
smallest change and the least clever; `isWellFormed` is the one that reads as a rule.

---

## 2. MEDIUM — `copyOptionalSwapFields` copies wire values with no type check at all

**File / symbol:** `packages/js/browser/src/internal/swap-http.ts:295`, inside
`copyOptionalSwapFields` (`:274`).

```ts
if (swap[key] !== undefined) output[key] = swap[key];
```

No `typeof` anywhere in the loop, over fifteen keys: `deposit_memo`, `deposit_tx_id`,
`payout_tx_id`, `refund_tx_id`, `refund_reason`, `refund_amount`, `attention`,
`attempt_id`, `provider_order_id`, `refund_address`, `refund_nonce`,
`refund_nonce_expires_at`, `attention_reason`, `deposit_received_amount`, `fee`.

### Chain

1. `normalizeSwapStartInvoice` (`swap-http.ts:63`) is the parse boundary for a swap
   start (`startOpenReceiveSwapRequest`, `:122`) and a swap refund (`:164`). It is
   strict about the fields it names — `provider`, `pay_in_asset`, `deposit_address`,
   `deposit_amount`, `provider_state`, `provider_expires_at` all go through
   `nonEmptyString` or a `typeof === "number"` check and throw the payload away if they
   fail — and then spreads `...copyOptionalSwapFields(swap)` at `:97` with none of that
   rigor.
2. The result is a `CheckoutInvoiceSnapshot`, which every layer above treats as already
   parsed. `CheckoutInvoiceSwapSnapshot` (`checkout-types.ts:127`) declares
   `deposit_tx_id?: string`. The type says string; the value is whatever the server sent.
3. On render, `push` (`checkout-details.ts:61`) hands the value to
   `createOpenReceiveDetailExternalLink`, whose **first statement** is
   `const value = options.value.trim();` (`checkout-links.ts:95`) — before the label
   check at `:97`. That is why every field here crashes regardless of whether its label
   is linkable, and why `payout_tx_id` is an instance of this item though it was not an
   instance of item 1.

### Reproduction

Feed `normalizeSwapStartInvoice` a well-formed swap-start body with one field of the
wrong type, then build detail rows from the snapshot. Every row below **parses clean**
and **throws on render**:

| injected value | survives parse as | render throw |
| --- | --- | --- |
| `deposit_tx_id: 991234` | `991234` | `TypeError: options.value.trim is not a function` |
| `refund_address: 42` | `42` | `TypeError: options.value.trim is not a function` |
| `payout_tx_id: ["a"]` | `["a"]` | `TypeError: options.value.trim is not a function` |
| `attempt_id: {}` | `{}` | `TypeError: options.value.trim is not a function` |
| `provider_order_id: true` | `true` | `TypeError: options.value.trim is not a function` |
| `deposit_memo: 7` | `7` | `TypeError: options.value.trim is not a function` |
| `refund_reason: null` | `null` | `TypeError: Cannot read properties of null (reading 'trim')` |
| `refund_amount: 5` | `5` | `TypeError: amount.includes is not a function` |
| `deposit_received_amount: 5` | `5` | `TypeError: amount.includes is not a function` |

The last two throw **earlier and elsewhere**: `checkout-details.ts:127` and `:134` call
`formatOpenReceiveDepositAmount`, which reaches `amount.includes(".")` at
`checkout-format.ts:22`. (The regex `.test()` before it coerces, so it is `includes`
that throws.) Worth knowing, because a fix that only hardens `checkout-links.ts` leaves
these two live.

`fee` is a crash vector too, but only through the fallback branch. When
`createOpenReceiveSwapFeeBreakdown` succeeds nothing breaks; when it returns `undefined`
— e.g. `pay_in_fiat` is not a parseable decimal — `checkout-details.ts:154` pushes
`swap.fee.currency` raw:

- `fee: { currency: 840, pay_in_fiat: "x", payout_fiat: "y" }` → `TypeError: options.value.trim is not a function`
- `fee: { currency: "USD", pay_in_fiat: 12.5, payout_fiat: "12.00" }` → same

`fee: "n/a"`, `fee: {}`, `refund_nonce_expires_at: "soon"` and `attention: "yes"` do
**not** throw on this path. They are still wrong values sitting in a parsed snapshot.

### Blast radius

Same three renderers as item 1, plus everything else that reads
`CheckoutInvoiceSnapshot.swap`. Worse than item 1 in one respect: item 1 needs a
malformed string, this one needs only a wrong type, which is the far more ordinary
server bug. It fires on the **first** render after a swap start or a refund
confirmation — before any polling — so the payer sees it at the moment they are being
told where to send money.

### Fix

Give `copyOptionalSwapFields` a per-field type table and drop anything that does not
match, mirroring what `mergeSwapStatusIntoInvoice` already does at
`checkout-transport.ts:359`.

It cannot be a flat `typeof === "string"` loop — the key list is not homogeneous.
Against `CheckoutInvoiceSwapSnapshot` (`checkout-types.ts:127-148`):

- **string:** `attempt_id`, `provider_order_id`, `deposit_memo`, `deposit_tx_id`,
  `payout_tx_id`, `refund_address`, `refund_nonce`, `refund_tx_id`, `attention_reason`,
  `refund_reason`, `deposit_received_amount`, `refund_amount`
- **boolean:** `attention`
- **number:** `refund_nonce_expires_at`
- **object with three string members:** `fee` (`currency`, `pay_in_fiat`,
  `payout_fiat`) — needs a nested check, per the `fee` results above

Drop-on-mismatch rather than throw-the-payload-away is the right call for these, and is
the same call the sibling boundary made. These are all optional decorations; a swap
start that is otherwise valid should still produce a usable payment screen. The strict
required fields at `swap-http.ts:68-76` already throw, which is where "this payload
cannot describe a swap" belongs. See the `swapCheckoutAmountMsats` docstring at
`swap-http.ts:239-264` for the repo's written form of that distinction — *rejected at
the parse boundary, blanked at the display boundary*.

---

## Items 1 and 2 share a root — fix them as one change

The two swap parse boundaries disagree about how much they validate, **for the same
fields**:

| | `mergeSwapStatusIntoInvoice` (status poll) | `copyOptionalSwapFields` (swap start / refund) |
| --- | --- | --- |
| where | `checkout-transport.ts:337-372` | `swap-http.ts:274-297` |
| string fields | `typeof === "string"` at `:359` | **nothing** at `:295` |
| `provider_state` | `nonEmptyString` | copied by the caller with a cast |
| `provider_expires_at` | `optionalSafeInteger` | `typeof === "number"` in the caller |
| `attention` | `typeof === "boolean"` at `:361` | untyped |
| covers | 9 string fields + `attention` | 15 fields, none typed |
| misses | `attempt_id`, `provider_order_id`, `deposit_memo`, `refund_nonce_expires_at`, `fee` | — |
| well-formedness | no | no |

Neither is complete. The poll boundary checks types but not well-formedness, which is
item 1. The start boundary checks neither, which is item 2. And their key lists differ,
so a field validated on one path is unvalidated on the other for the whole lifetime of
the same swap.

**This is one change, not two.** The two lists should become a single shared field-type
table — one module-private declaration naming each optional swap field and its expected
type, with both boundaries filtering through it. That kills item 2 outright, makes item
1 a matter of adding one predicate in one place instead of two, and removes the standing
hazard that the next field added to the wire gets validated on one path and not the
other. Anyone picking up either item should scope it as this.

The well-formedness predicate from item 1 still belongs in `checkout-links.ts`, next to
`encodeURIComponent`, not in the shared table: it is a rule about what a *URL* can hold,
not about what the wire may send. A lone surrogate in a `refund_reason` that is never
linked is ugly but harmless, and blanking it at the parse boundary would erase evidence
the panel exists to report.

---

## 3. LOW — `isHelloFruitDemoOrder` bounds the container, not the fields

**File / symbol:** `examples/hello-fruit/shared/demo-order.ts:42`, the checks at
`:48-50`.

```ts
Array.isArray(record.items) &&
typeof record.total_amount === "object" &&
record.total_amount !== null
```

`items` is "an array" of anything. `total_amount` is "an object" — its `currency` and
`value` are never inspected. The guard's return type is
`value is HelloFruitDemoOrder` (`:31-40`), which declares both fully typed, so every
consumer downstream is type-checked against a promise the guard does not keep.

### Chain

1. A demo client fetches an order and gates on the guard —
   `demo-shop-app.tsx:365`, `demo-delivery-client.ts:41`, `ShopWorkspace.ts:137` and
   `:245`, `actionCable.ts:39`, `static-html-small-api/src/client/main.ts:130` and
   `:474`, `demo-checkout-resume.ts:20`.
2. Render calls `formatHelloFruitFiat` (`demo-formatting.ts:19`), which reads
   `fiat.value` / `fiat.currency` at `:20` and passes them to `padHelloFruitFiatValue`,
   which calls `currency.toUpperCase()` at `:29` and `value.split(".")` at `:31`.

### Reproduction

Every row below **passes the guard** (`isHelloFruitDemoOrder` returns `true`) and then
throws on render:

| order shape | throw |
| --- | --- |
| `total_amount: {}` | `TypeError: Cannot read properties of undefined (reading 'toUpperCase')` |
| `total_amount: { currency: "USD", value: 12 }` | `TypeError: value.split is not a function or its return value is not iterable` |
| `total_amount: { currency: 840, value: "12.00" }` | `TypeError: currency.toUpperCase is not a function` |
| `items: [{}]` (no `line_amount`) | `TypeError: Cannot read properties of undefined (reading 'value')` |
| `items: ["x"]` | `TypeError: Cannot read properties of undefined (reading 'value')` |

The two `items` cases throw at `demo-formatting.ts:20`, reading `fiat.value` off
`undefined` — not inside `padHelloFruitFiatValue`.

### Blast radius

Four render sites, all of which crash the order view:

- `examples/hello-fruit/shared/demo-shop-app.tsx:544` (`order.total_amount`) and `:555`
  (`item.line_amount`)
- `examples/hello-fruit/server/rails/app/javascript/src/app/components/OrderPanel.tsx:21`
- `examples/hello-fruit/server/static-html-small-api/src/client/main.ts:389`

LOW because it is demo code and because the server producing these orders is the demo's
own. Worth fixing anyway: the demos are what integrators copy, so a guard that lies
about its return type teaches the wrong pattern. It is also the one instance a reader
can reproduce without a provider fixture.

### Fix

Two halves, and the second is the one that matches the rule.

**Tighten the guard** so its return type is honest. Add
`isHelloFruitFiatAmount(value): value is HelloFruitFiatAmount` checking
`typeof currency === "string" && typeof value === "string"`, apply it to `total_amount`,
and check each element of `items` for `product_id` / `name` / `sticker` / `quantity` /
`unit_amount` / `line_amount`. That moves the failure to the fetch boundary, where the
demos already have a "could not load order" path.

**Add the display boundary**, because a tightened guard alone still lets a bad value
reach a throwing formatter wherever it is called without one:

```ts
export function optionalHelloFruitFiatLabel(
  fiat: HelloFruitFiatAmount | undefined,
): string | undefined
```

returning `undefined` when `fiat?.currency` or `fiat.value` is not a string, with
`formatHelloFruitFiat` left throwing — it is called from `formatHelloFruitDisplayPrice`
(`demo-pricing.ts:103`) on catalog amounts the demo constructs itself, where a bad value
is a demo bug that should surface. The render sites then skip the amount and keep the
row, the same trade `optionalMsatsLabel` makes.

The demo already holds the matching pair one layer up, for rates rather than orders:
`parseHelloFruitBtcFiatRates` (`demo-pricing.ts:34`) keeps a malformed payload out of
state, and `toHelloFruitDisplayAmount` (`:89`) falls back to the USD catalog amount for
anything it cannot convert. This item is the same pair, unbuilt, for the order body.

---

## 4. Found by the round-3 verifier, open

Three more, all proven with probes against a real element under happy-dom.

**`invoice` + `decode-link-url` — MEDIUM, and the worst shape still live.** A lone
surrogate in the bolt11 throws `URIError` out of `encodeURIComponent` in
`createOpenReceiveLightningInvoiceDecodeUrl`, leaving an EMPTY shadow root and dispatching
NO error event — the outcome the `invoice-id` guard was written to eliminate, on a sibling
attribute. It only fires when `decode-link-url` is configured:

    A: lone-surrogate invoice, no decode-link-url   -> no throw, 4374 bytes rendered
    B: lone-surrogate invoice + decode-link-url     -> URIError, shadow root EMPTY, no error event
    C: clean invoice + decode-link-url (control)    -> no throw, 4571 bytes

This is item 1 reaching the element rail. Fixing item 1 fixes it.

**Create mode after prepare — LOW.** With `invoice-id` set, no `invoice`, and prepare
landed (`deferredReady`), `createCheckoutState` throws `TypeError: OpenReceive checkout
requires a display Lightning invoice.` out of render; the create-error path's own
re-render throws again and escapes as an unhandled rejection. Pre-existing. The
`invoice-id` guard deliberately does not cover it — see the comment at its call site.

**`poll-interval-ms` — LOW, and correct as-is.** The one attribute of 21 that still throws
on hostile input, but out of `connectedCallback`, never out of `render()`: the element
renders fully and polling is silently disabled. It is host-authored (no server field feeds
it anywhere in the repo), so a typo SHOULD be loud. Recorded because the enumeration asked
for it, not because it needs changing.

**A limit worth stating.** The `expires-at` deadline horizon keeps the element rendering,
but cannot repair `status`: `createCheckoutElementAttributes` derives that from the same
`invoice.expires_at`, so a genuinely-expired deadline sent in milliseconds is written as
`status="pending"` before any reader sees it. Bounding the unit at the wire boundary is
the only fix that recovers the truth.

---

## 5. Prefix-handling edges, open

Two survivors of the prefix-only migration (G5). Neither is a crash; both are a value being
accepted where it should be questioned.

**`prepareCheckout` accepts options it silently drops — LOW.** It ships
`prepareCheckout(options: RequestCheckoutOptions)`, the same type `requestCheckout` takes, so
`memo` and `metadata` type-check on a prepare call. The body posts only
`JSON.stringify({ order_id: request.orderId })`, so both are dropped without a word.
`docs/guides/api-reference.md` documents the narrower `{ orderId, prefix, fetch?, headers? }`,
which is what the function honours — the doc is right and the type is too wide. The fix is a
narrower options type for prepare, not a doc change.

**An empty `prefix` attribute root-mounts — LOW, and arguably correct.**
`<openreceive-checkout order-id="x" prefix>` — the ordinary way to write a boolean-looking
attribute — gives `getAttribute("prefix") === ""`, and `?? OPENRECEIVE_DEFAULT_PREFIX` does not
fire on an empty string. `""` is a legal prefix by design ("mounted at the root", routes.ts, and
pinned in tests/browser-checkout-controller.test.mjs), so the element root-mounts instead of
falling back to `/openreceive`. Whether that is a bug depends on whether a bare `prefix`
attribute should mean "root" or "unset"; it currently means root, silently. Worth deciding
deliberately and then saying so at `resolvePollPrefix` and `currentPrefix`, which both use the
`??` form.

---

## Already fixed, and where

The pattern is being applied consistently, not ad hoc.

**`beb00a0` — Track G3-G4: amounts and timestamps.**

- `isDisplayableMsats` + `optionalMsatsLabel` introduced (`checkout-format.ts:79`,
  `:100`). The `Number.isSafeInteger(...) && ... >= 0` pair had been written out at three
  sites, and two display sites in `checkout-details.ts` never had it at all.
- `isDisplayableUnixSeconds` + `optionalUnixTimeLabel` (`:258`, `:279`). The upper bound
  was the forgotten half: `formatOpenReceiveUnixTime` guarded finite-and-positive but
  not magnitude, and two display sites called `new Date(...)` unguarded, so a `paid_at`
  of `1e13` — sent in milliseconds instead of seconds — took down the whole settled
  screen with `RangeError: Invalid time value`.
- `formatOpenReceiveUnixTime` (`:293`) now echoes its input rather than throwing, with a
  docstring saying why it diverges from the amount rule: nothing constructs or validates
  through it, so a throw could only ever reach a display site.
- `addTimestampRow` (`checkout-details.ts:42`) re-shows an unrenderable timestamp raw
  under a `... (unix seconds)` label; the amount rows do the same with `Amount (msats)`
  (`:88-89`). Blanking never erases the evidence.
- `checkout-transport.ts:268-281` records the matching decision on the parse side: that
  boundary bounds a timestamp's type and deliberately admits an out-of-range `paid_at`,
  because the damage is already contained at the display boundary.

**This wave.**

- *Curated surface.* `optionalMsatsLabel` and `optionalUnixTimeLabel` were
  package-private, which left a demo holding a bare msats number no safe option to reach
  for — the shape of bug the pair exists to prevent. They now ship from the
  `@openreceive/browser/internal` barrel next to the formatters they wrap
  (`internal/checkout.ts:12-32`) and from `headless.ts:67-93`, which states the rule
  where a headless integration meets it, and both are recorded in
  `tools/validate/public-api.snapshot.json`. The predicates stayed module-private: the
  two halves moved in opposite directions on purpose.
- *Expires-at attribute.* `readElementExpiresAt`
  (`packages/js/elements/src/dom-helpers.ts:134`) replaces the strict
  `parseOpenReceiveOptionalInteger` that `define-elements.ts` used for `expires-at`.
  `expires-at` carries server data — `String(invoice.expires_at)`, bounded only by a
  type check on the way in — and `render()` reads it with nothing wrapping `render()`,
  so a throw blanked the whole payment screen. `readElementAmountMsats` (`:74`) had
  already been fixed the same way; `expires-at` was left behind because the ruling was
  assumed rather than checked per attribute. It is now checked per attribute, and the
  docstring records all three: `amount-msats` and `expires-at` read leniently,
  `poll-interval-ms` stays strict because `createCheckoutElementAttributes` only ever
  writes it from the host's own `options.pollIntervalMs`, so a bad value there is a typo
  that must be heard.

  The lenient parse was not the whole fix, and the rest of it is the part worth copying.
  Where `amount-msats` flows on to `optionalMsatsLabel`, which blanks it, `expires-at`
  flows into `expires_in_seconds`, which no boundary judges — it is merely floored at
  zero — so passing everything through would have traded a crash for a lie. **A deadline
  needs TWO bounds, and this is the instance that proves the label bound alone is not
  one of them.**

  `optionalUnixTimeLabel` supplies the first: `-1` is not renderable, and left alone it
  would have read as "expired at the dawn of time" and blanked the QR and the amount off
  the screen the payer came to pay from. It does **not** supply the second. Its question
  is renderability — finite, above zero, inside the ECMAScript `Date` range — and that
  range runs to 8.64e12 seconds, while today's moment expressed in MILLISECONDS is
  1.787e12. A millisecond `expires_at` is therefore comfortably renderable, sailed
  through the label bound, and measured a countdown of `29759354970:54`. So
  `MAX_DEADLINE_HORIZON_SECONDS` (`:101`) asks the deadline question the label bound
  cannot: one year ahead of now, four orders of magnitude past any honest checkout
  expiry and three short of a millisecond timestamp. Only the FUTURE side is bounded —
  a past deadline is the expired screen's whole input, and no unit inflation can land
  there, because multiplying a positive epoch by 1000 only moves it further out.

  `isDisplayableUnixSeconds` (`checkout-format.ts:258`) now carries the matching
  docstring, so the next caller reads "renderability, and NOT a unit check" at the rule
  itself rather than rediscovering it. Dropping a value costs the countdown ROW and
  cannot hide a real expiry, which the `status` attribute carries separately. Three
  tests in `tests/element-lifecycle.test.mjs`: "a hostile expires-at costs the countdown,
  not the element", "an expires-at already in the past still reaches the expired screen",
  "a legitimate expires-at still drives the countdown".
- *Invoice-id attribute.* `parseElementInvoiceId`
  (`packages/js/elements/src/views.ts:127`) is the third server-written attribute the
  ruling above has to cover, and the one where blanking is the WRONG answer.
  `createCheckoutElementAttributes` writes it straight from `invoice.invoice_id`, so a
  server answering `""` put an empty string in the attribute, which reached
  `createCheckoutSnapshotFromInvoice`, whose `requiredString` threw inside `render()`.
  Nothing wraps `render()`, so the shadow root stayed EMPTY: no invoice, no error, no
  signal — the worst outcome in this document, because the payer sees nothing at all to
  report.

  A blank `invoice-id` is not a bad label, it is NO IDENTITY: the element cannot seed a
  state, cannot build the snapshot the poll controller needs, and so can never tell the
  payer their money arrived. So this one does not blank a row, it says so — `render()`
  (`define-elements.ts:394`) puts up `renderCheckoutCreateErrorHtml` with
  `UNIDENTIFIED_INVOICE_MESSAGE` (`:83`), which names the attribute because the fix is
  always in the host's data. `renderCheckoutCreateErrorHtml` took a `retry` option
  (`render-checkout.ts:163`) to make that honest: a prepare failure is re-runnable and
  keeps its button, an unusable attribute is not — `applyCheckoutElementAttributes` only
  ever SETS attributes, so a retry could not clear the bad one — and passes
  `retry: false`. `currentCheckoutSnapshot` (`define-elements.ts:636`) applies the same
  test so the poll controller stops instead of throwing out of `connectedCallback`.
  Whitespace-only ids are rejected by the same test, because `nonEmptyString` does not
  trim and `" "` would otherwise become a junk id copied on into `checkout_id` and
  `order_id`; a usable id is returned RAW, since trimming would mint an id matching
  nothing the server sent. Covered by "a hostile invoice-id costs the payment screen,
  not the shadow root" in `tests/element-lifecycle.test.mjs`.
- *Demo rates guard.* `parseHelloFruitBtcFiatRates` (`demo-pricing.ts:34`) is now THE
  parse boundary for a `GET /rates` body, shared by every demo client, replacing a cast
  that bounded the type and nothing else. It drops individual unusable currencies rather
  than failing the whole map, and returns `undefined` — the "rates not loaded" value
  every caller already handles — when nothing survives. `toHelloFruitDisplayAmount`
  (`:89`) is the display half: a deliberately unfiltered `catch` falling back to the USD
  catalog amount, because conversion throws at least three ways and a boundary that
  enumerates error types is a boundary that leaks the next one. Its throwing sibling
  `convertHelloFruitUsdAmount` (`:111`) is what the host uses for order math.
  `tests/hello-fruit-display-pricing.test.mjs` drives the shop over hostile `/rates`
  bodies and asserts the fallback, not a blank screen.

---

## The count

The sweep behind `beb00a0` recorded **six** instances, and this document used to say four
of them were open. Four never matched the three sections above: the only arithmetic that
produced it counted §1 twice, once per call site — which contradicts §1's own "fix them
as one change", and sent anyone reading cold hunting for a fourth section that was never
written.

Six reconciles against three like this. The one correction §1 records against the
original write-up is `payout_tx_id`: it was written down as an instance of the
`encodeURIComponent` crash and it is not one, because its label is not in the link
allowlist, so the function returns before `:46` is reached. It is an instance of §2
instead, where it is already counted. Six minus that duplicate leaves **five distinct
instances**:

| instance | state |
| --- | --- |
| HIGH — msat amounts reaching `formatOpenReceiveMsats` unguarded | fixed at `beb00a0` |
| HIGH — unix timestamps reaching `new Date(...)` unguarded | fixed at `beb00a0` |
| MEDIUM — `encodeURIComponent` on a lone surrogate (§1, two call sites) | **open** |
| MEDIUM — `copyOptionalSwapFields` copies with no type check (§2) | **open** |
| LOW — `isHelloFruitDemoOrder` bounds the container only (§3) | **open** |

**Two fixed, three open, three sections.** §1's two call sites are two *sites*, not two
instances — the same reading that makes each HIGH one instance despite each having
touched several sites — so "Items 1 and 2 share a root, fix them as one change" and the
open count now agree. §1 and §2 are further one *change* between them, which is what
that section argues; they stay two instances because they are two distinct crashes with
two distinct causes.

Two further instances turned up this wave from **outside** the sweep, and both are
fixed and recorded above: the `expires-at` attribute and the `invoice-id` attribute.
Both were `@openreceive/elements` letting a server-written attribute reach a
strict parser with nothing wrapping `render()` to catch the throw —
`parseOpenReceiveOptionalInteger` for `expires-at`, `requiredString` inside
`createCheckoutSnapshotFromInvoice` for `invoice-id`. That is one root, and the reason
`dom-helpers.ts` now rules on strictness PER ATTRIBUTE instead of once: the next
attribute added to the element gets the same question asked of it. The other two entries under "This wave" are not crashes the sweep found — the
curated surface and the demo rates guard are the pattern being extended to a surface gap
and to a parse boundary that had only a cast — so they do not move this count either.

Running total, then: **five from the sweep** (two fixed, three open, one duplicate
struck) and **two more found and fixed since**. Three numbered sections above, three open
items, and no fourth section to hunt for.
