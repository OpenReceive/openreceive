# Changelog

## Unreleased

### Publishing trusts green CI

`npm run release:publish` no longer re-runs `npm run test:ci` when the `CI` and
`Release Dry Run` workflows are both green on the exact commit being published.
The 0.4.0 release ran the suite twice back to back on the same commit — once in
the tag's dry run, once locally — for no extra evidence. To make the pair a
faithful stand-in, `release.yml` gained the four `test:ci` steps that only the
weekly Demos lane used to run (`check:demo-containers`, the Rails example's
catalog check, `build:demo`, `scan:client-bundles`), and `check:workflows` pins
them. Without a green pair (no `gh`, a missing, failed or in-progress run, a
dirty worktree) the suite runs locally as before; `--skip-tests` still skips it
unconditionally.

## 0.4.0 - 2026-09-02

### Payment icons ship inside the JavaScript

The eleven payment-method icons (`btc`, `crypto`, `eth`, `lightning`, `ltc`,
`sol`, `trx`, `usdc`, `usdt`, `xmr`, `xrp`) are now compiled into
`@openreceive/browser` — about 7 KB of SVG text generated from
`src/assets/icons/*.svg` by `npm run generate:payment-icons` (checked in CI).
No host has to copy, serve, or resolve an icon file any more, under any
bundler: no `import.meta.url` games, no copy plugin, no loader, no
`assetBaseUrl` for these. The custom element draws them inline in its shadow
root (`role="img"` with the tile's label); everything that carries a URL —
`@openreceive/react`, the display models, `getPaymentMethodIcon` /
`getNetworkIcon` / `getSwapOptionIcon` — gets the same icons as
percent-encoded `data:image/svg+xml` URIs.

New on `@openreceive/browser/headless`: `paymentIconSvgs` (the markup),
`PaymentIconId`, the `getPaymentMethodIconId` / `getNetworkIconId` /
`getSwapOptionIconId` twins of the URL getters, and
`WizardRouteAssetDisplay.iconId` — the key a headless renderer needs to draw
an icon inline the way the element does.

**Behaviour change:** the VALUES of `paymentIconUrls` (and of every icon
getter called without a resolver) change from file URLs to `data:` URIs.
Anything string-matching them for `assets/icons/…` breaks. A host resolver
or `assetBaseUrl` still wins over the packaged value, exactly as before, and
`dist/assets/icons/*.svg` plus the `./assets/*` export keep shipping, so an
existing copy-and-serve setup keeps working — it is now only needed as the
escape hatch for a CSP `img-src` without `data:`. Inline SVG is confined to
the element's own shadow-root renderer and to these build-gated first-party
strings (the generator refuses `<script>`, `on*=` handlers,
`<foreignObject>`, `<style>`, `<image>` and external `href`s).

`@openreceive/provider-data`'s wallet logos and pay tutorials are unchanged:
still files, still served through `assetBaseUrl` / `resolveAssetUrl`. The
demos' `copy-openreceive-payment-icons-plugin.ts` is renamed
`copy-openreceive-provider-assets-plugin.ts` and copies only those.

### Release notes

All four Buy a Button examples (`examples/buttons/server/node-express`,
`static-html-small-api`, `nextjs-fullstack`, `rails`) were rebuilt against the
0.4.0 workspace packages through `npm run build:demo` in the release gate. The
Vite and webpack examples no longer copy `@openreceive/browser`'s icon
directory; only `@openreceive/provider-data`'s images are copied.

The live wallet smoke (`npm run test:live`) was NOT run for this release: it
needs a funded NWC connection.

## 0.3.3 - 2026-09-02

### OpenReceive ships as agent skills

Two skills in the open SKILL.md format now travel with the library:
`integrate-openreceive` (stack detection, the three server objects, the
`authorize`/`amountFor`/`onPaid` contract, 409 semantics, the secret boundary,
scaffolding, and testing against a fake wallet — with the full per-stack agent
directions as references) and `debug-openreceive-payment` (doctor-first
triage: boot failures, request-time 403/404/409, settlement timing, swap
refunds, each symptom with its fix). They install from the repo
(`npx skills add OpenReceive/openreceive`, or Claude Code
`/plugin marketplace add OpenReceive/openreceive` via the new
`.claude-plugin/marketplace.json`), are discovered from the `.agents/skills/`
mirror, and ship inside every npm package and gem, so an agent working in an
app that already installed OpenReceive finds them with no network.
`npm run generate:skills` keeps the mirrors byte-identical (checked in CI),
and the release checklist now requires the skills to describe the released
API.

The site contract moves to v3 for the same audience: openreceive.org now
serves `/llms.txt` (generated here from the docs manifest), the normative
OpenAPI file verbatim at `/openapi.yaml`, an `/agents` page, and llms.txt v2
discovery tags (`rel="describedby"`, markdown alternates) — so a browsing
agent can find the whole documentation surface from any page.

### Error messages state the fix and link the doc

Every integrator-facing setup error now says what to do about itself and
links the guide that owns the answer — the boot/mount "requires amountFor /
onPaid / authorize / host" family, the composed-options error, the
rate-limiting conflicts, and the reconcile-gate requirement, in both engines.
The 403 for a denied reference now names the authorize hook and links the
authorization guide. Ruby reaches parity with the JS NWC messages: missing,
invalid, and spend-capable `NWC_URI` failures carry the same receive-only
framing and the get-a-code URL (the long-dormant `NWC_CODE_HELP_URL` constant
finally earns its keep), and the spend override is spelled `=true` in both
engines.

A missing migration also stops surfacing as a raw driver error. When the
`openreceive_meta` probe finds the table absent, both engines now raise a
configuration error naming the exact fix — `npx openreceive scaffold
payments --orm <yours>` on Node, `bin/rails generate openreceive:install`
then `db:migrate` on Rails — instead of leaking `no such table` from the
first query. Any other probe failure (connection refused, permissions) keeps
the old silent tolerance, and a healed database is retried, not remembered
as broken.

### `openreceive doctor` proves the integration, not just the env

The doctor used to stop at parsing `NWC_URI`. It now probes the wallet over
the relay — the same preflight boot runs — and reports receive-only or the
exact refusal; `--db <sqlite file | postgres:// | mysql://>` confirms the
`openreceive_payments` + `openreceive_meta` migration actually ran, and
`--url http://localhost:3000` confirms the routes answer on the running app
(recognized by the router's own JSON 404, which no framework fallback
produces). Every failing line states its own fix and links the guide that
owns it. The default run still touches no database, and `--offline` keeps the
old fully-offline behavior; `debug-report` stays exit-0 and redacted.

### Checkout children compose instead of replacing the payment UI

Passing anything as `<Checkout>` children — even the one-line order summary
the docs recommend — silently replaced the QR, the method tiles, and the
whole payment flow, so a first store's checkout could ship as a description
with no way to pay. Children now render above the shipped payment UI, in the
same position as the custom element's `order` slot, exactly as the docs
always said they did. A host that wants its own checkout builds on
`useCheckout` or `@openreceive/browser/headless`, not on `children`.

### The host can lock the checkout theme

`<Checkout theme="dark" | "light" | "system">` locks the theme: it wins over
the payer's stored preference (`localStorage["openreceive.theme"]`) and any
ancestor `ThemeScope`, and hides the toggle, so a checkout embedded in a page
that is always dark can never come up as a white card. `ThemeScope` and
`useTheme` accept the same `theme` option. The custom element's `theme`
attribute already behaved this way; the element wrappers do not forward it
yet (docs/internal/wrapper-parity.md tracks the gap).

`themeToggle={false}` now hides the control but still stamps `data-theme` —
hiding the toggle no longer renders an unstyled checkout.

The theme toggle is labeled by the action ("switch to dark mode"), not the
current state: a checkout stuck light on a dark page used to announce
"light mode" at the payer.

### Release notes

All four Buy a Button examples (`examples/buttons/server/node-express`,
`static-html-small-api`, `nextjs-fullstack`, `rails`) were rebuilt against the
0.3.3 workspace packages through `npm run build:demo` in the release gate.

The live wallet smoke (`npm run test:live`) was NOT run for this release: it
needs a funded NWC connection.

This is a PATCH bump: nothing left the public API. The doctor flags, the
`DoctorWalletClient` seam, and the skills shipped inside every package are
additive; the checkout-children change makes the component do what its docs
always said; error-message rewrites keep every pinned wire message and code.

## 0.3.2 - 2026-08-29

### An overpaid swap deposit is a refund, not a support ticket

A payer who sent more than `deposit_amount` landed on `attention` — terminal,
no form, "This payment needs support review." The provider does not treat it
that way: lightning-swap opens `refund_required` on `MORE` and takes a full
`choice=REFUND` for it, exactly as it does for `LESS` and `EXPIRED`. The
client was the only thing calling it an incident, and the payer's money sat
behind a sentence with no next step.

`MORE` / `OVER` / `OVERPAID` now map to `refund_required` in both engines, so
the deposit comes back through the same two-step form as every other
emergency. The refund is the WHOLE deposit — the payout is a fixed-amount
bolt11, so there is nothing to exchange a surplus into and `choice=EXCHANGE`
is not a path this client takes. The order stays unpaid and the payer can pay
again afterwards.

`refund_reason` gains `overpaid` and `overpaid_and_late` beside the three that
were there, with payer-facing copy for both. `LIMIT`, which the provider pairs
with `LESS`/`MORE` when a deposit falls outside the pair's limits, names no
reason of its own — it says nothing the payer can act on beyond the amount.
`attention` still holds what genuinely needs a human: `choice=EXCHANGE`, a
provider status we do not recognize, and the states OpenReceive itself sets.

Attempts already sitting in `attention` heal on their next status read, which
is the next time the payer opens the checkout.

### The attention screen says what to do

Both renderers printed the same sentence twice — once as the heading detail,
once as the warning banner underneath it — and then hid the ids behind a
"Payment details" caret. The banner now carries the next step, the amounts
sent and required sit under it, and the deposit transaction and provider order
render open: on a screen whose whole remaining job is quoting an id to a
human, a disclosure triangle is the wrong shape. The demo shops stop rendering
a payable QR under an `attention` status for the same reason.

### A payer can get back to a deposit that is already in flight

A stablecoin deposit has no account behind it and sends no email. The order's
reference is the whole of the payer's claim on it, and `POST /checkouts/prepare`
answers with the amount and the pay-in catalog and NO attempts — so a checkout
rebuilt from a reference alone opened on the payment-method grid. That is the
wrong screen for someone who was told to bookmark a refund.

`resumePaymentHash` (attribute `resume-payment-hash`) is a create-mode prop on
the React, element, Vue, Svelte and Angular checkouts: pass the payment hash
your application stored beside the order and the deposit — or its refund form —
comes back as the payer left it. **A hash the server will not serve is
ignored**, because a stale note in host storage is not a reason to put an error
in front of a payer who can still start a fresh payment; they land on the method
grid exactly as they would have.

The hash and not the asset, deliberately: `POST /swaps/status` addresses one
attempt and applies no reuse test, so it still answers for a deposit that
stopped being payable hours ago, while re-selecting the asset re-serves the
committed attempt only until it expires and then mints a second address.

Four additive names on `@openreceive/browser` (and `/headless`) for hosts
driving their own UI: `requestSwapStatus` reads one attempt by hash and rejects
with a `status`-carrying error; `resumeSwapAttempt` is the forgiving wrapper the
renderers share, folding the attempt into a prepared snapshot and returning the
snapshot unchanged on any failure; `currentCheckoutUrl` is the one definition of
"its URL" that the two refund screens copy; `formatMethodNetworkDetail` joins
network labels for a method tile. `SwapDisplayModel` gains `resumable`, the
boolean `refundReturnLabel` was already chosen from, so a UI can render the copy
button that sentence names without string-matching the label.

### The guides say less

Thirteen guides were rewritten against what the packages actually export, and
the set shrank by roughly 1,800 lines while gaining a page. `swap-refunds.md`
is new and is the one that was missing: when `refund_required` happens, which
`refund_reason` means what, and — the part every stack got wrong — that a refund
form is only a promise if the payer can reach it again after closing the tab.
`headless-checkout.md`, `storage.md`, `security.md` and `checkout-ux.md` lost
the most; three internal notes (`architecture.md`, `checkout-design.md`,
`scope-lock.md`) now hold the reasoning that was scattered through them.

### Every demo stack runs with no wallet, and every order has a URL

The checkout lives at `/checkout/:reference` on all four Buy a Button stacks,
which serve the SPA there, put the reference in the address bar the moment the
order exists, and take a pasted one back in from the catalog. The two custom-UI
stacks reopen the attempt with `resumePaymentHash`; the two that mount the
packaged checkout let the payer re-pick their coin.

`DEMO_WALLET=testkit` now boots the Rails stack too —
`examples/buttons/server/rails/lib/button_shop/testkit/` is a port of
`packages/js/testkit` down to the fixtures, so one Playwright suite drives all
four with the same assertions. It fakes the wallet, the swap provider and the
price feed, and nothing else: the engine, the hooks, the migrations and Postgres
are the production paths. The `/__testkit` route is declared unconditionally and
404s unconditionally without the variable, which its own test asserts in an
environment that does not set it, and which `npm run check:demo-containers`
enforces against every compose file.

All four stacks — `node-express`, `static-html-small-api`, `nextjs-fullstack`
and `rails` — were rebuilt against the 0.3.2 packages, and the Playwright suite
runs against `node-express`. Of the gems, only `openreceive-server` changed;
`openreceive` and `openreceive-rails` are byte-identical to 0.3.1 and ship to
keep the one-version-for-everything rule.

Two release gates that were lying are fixed. `release:prepare` now refreshes the
Rails demo's `Gemfile.lock` alongside `package-lock.json` — the v0.3.1 tag's CI
died at `bundle install` with exit 16 because the three VERSION constants moved
and a lockfile pinning them by `path` did not, and local `test:ci` never sees it
because nothing here sets frozen mode. And `Release Dry Run`, which had never
passed on either tag it ever ran for, now builds the packages before smoking
them: `@openreceive/angular` resolves `@openreceive/elements/wrapper-shared` to
a `.d.ts` that exists only once elements is built, and a fresh checkout with no
build step cannot. `ci.yml` hid it by running `npm test` — and so `pretest:js` —
first.

The live wallet smoke (`npm run test:live`) was NOT run for this release: it
needs a funded NWC connection.

This is a PATCH bump: nothing left the public API. `resumePaymentHash` and the
four new browser exports are additive, and the swap-status mapping change moves
attempts out of a terminal state into a recoverable one.

## 0.3.1 - 2026-08-28

Three changes where a component or an engine was guessing about the host, and
answering wrongly in the safe-looking direction: a swap panel telling payers to
bookmark a page that would not bring them back, a console warning that fired at
correct integrations, and a Rails app serving checkouts through the generated
allow-all placeholder without ever saying so. Around them, the demo is a new
shop on four stacks, and CI is running again.

### The swap refund-return warning stops guessing

`SwapDisplayModel.refundReturnLabel` picks one of two warnings, and the wrong
one strands money: a payer who is told to come back to a page that has no route
to it cannot reach a swap deposit's refund. The component was inferring the
answer from `syncUrl` / `routeReference`, which only knows about URLs the
component itself writes.

`resumable` is now an explicit prop on `<Checkout>` and `PaymentWizard` — React,
Vue, Svelte, Angular, `@openreceive/browser` and the custom elements. Unset, it
is still inferred from `syncUrl` / `routeReference`; on the React wizard it
defaults to false, so the safe copy is what a host gets by saying nothing. Set
it when the host owns a per-order route the component cannot see, which is most
snapshot-mode apps.

### Packaged asset URLs resolve when they are read

`@openreceive/provider-data`'s icon and tutorial tables were built eagerly with
`Object.fromEntries`, so `assetUrl` — and its `file://` warning — ran at import
time, before any host resolver could be consulted. A host doing exactly the
right thing, serving the packaged `dist/assets` trees itself and passing an
`AssetUrlResolver` everywhere, was told on the console that its icons "cannot
load" about icons that loaded fine. That inverts the warning: nobody reading
their own console could tell a correct integration from a broken one.

The new `lazyAssetUrlTable` export builds the same shape — own, enumerable,
frozen, `undefined` for a missing key — with getters, so a packaged URL resolves
when something actually reads it. The warning becomes evidence again.

### Rails says out loud what the generated initializer left in place

`config.authorize` from `openreceive:install` allows every request, treating
possession of the reference as the authorization. That is a fine five-minute
demo and a bad production posture, and nothing distinguished the two.

- **`OpenReceive::ALLOW_ALL_AUTHORIZE` is a named constant**, for the same reason
  `LOGGING_ON_PAID` is: the engine can detect it at boot by identity and warn
  that anyone holding an order id can mint invoices, poll status and request
  refunds for it.
- **`bin/rails openreceive:doctor` is step 0 of the agent directions as one
  command.** It reports credential PRESENCE only — every line is `set` or
  `unset`, no secret is printed or partially shown — plus whether `configure`
  ran, which hooks are missing or still placeholders, where the engine is
  mounted, and a best-effort wallet preflight that reports rather than raises.
  "Look for `NWC_URI` in this app's server environment" has a different answer
  on every host shape, and in a containerised app grepping the repo finds the
  name and proves nothing about the value. This asks the process.

### CI is on again, and it had been off for three releases

Repository-level CI had been disabled since 2026-08-23, so 0.2.4, 0.3.0 and the
PR #1 merge all landed ungated. Switching it back on surfaced three failures,
none of them new: the Rails example's `Gemfile.lock` carried `arm64-darwin`
alone, so bundler exited 16 on `x86_64-linux` before a test ran; the ruby-engine
suite leaned on an `ActiveRecord::Base.stub` that minitest 6 moved out to a
separate gem; and one core test raced an 8s budget waiting out a real 1800ms
timer, which `installFastTimers` — exported since it was written and never
called — now clamps.

### Buy a Button replaces Hello Fruit, on four stacks instead of one

The reference shop is `examples/buttons/`, and it exists in four hosts that sell
the same catalog: `node-express` (3000), `static-html-small-api` (3001),
`nextjs-fullstack` (3002) and `rails` (3003). Hello Fruit is deleted — 80 files
and its whole shared tree.

- **The stacks share a shop, not a checkout.** `shared/server-node` is one
  persistence layer behind all three Node hosts, and the interesting seam is
  `renderCheckout`: the same order reaches a React mount, a vanilla
  `@openreceive/elements` mount, and the Next.js app router, and the shop code
  around it does not change. `client/` and `client-vanilla/` never import each
  other, which is why the static-html workspace carries no `@mantine/*` or
  `mobx*`.
- **Settlement arrives differently per host, on purpose.** Rails pushes over
  ActionCable; the Node stacks poll. The shared stores expose push seams they
  know nothing about the implementation of, which is the point.
- **The Playwright suite runs against `node-express`.** All eight specs:
  four framework tabs through a full Lightning checkout, both swap paths, the
  remint regression, and `persistence.spec.ts` in place of `resume.spec.ts`.
- **Two stale references only surfaced when their target vanished.** The Rails
  demo's Dockerfile copied a Hello Fruit shared tree it never needed, and the
  live NWC smoke read `product.invoice_expiry_seconds` from a `product.json`
  that never carried that key, so `expiry` went out undefined on every live run.
  It now prices the cheapest button from `shop-catalog.json` and passes the
  engine's own 600s default.
- **`check-demo-containers` had a rule that was wrong, not merely stale.** It
  forbade compose volumes outright. The intent — the engine must never carry a
  datastore of its own — is enforced by `forbidRuntimePersistence`; the blanket
  ban also forbade the HOST keeping its own database, without which a demo
  stops demonstrating "survives a restart" on the first `up --build`. Named
  `*-data` volumes are allowed; bind mounts are still rejected.

### The release tool bumps the examples again

Deleting Hello Fruit took `examples/hello-fruit/server` out of
`npm-release.mjs`'s workspace roots and put nothing back. The four buttons
examples are root workspaces, so `release:prepare` left their `@openreceive/*`
pins on the old version and the lockfile refresh went to the registry for
`@openreceive/testkit` — a package that is private by construction and has
never been published. Caught cutting this release.

### Agent directions say how host tables sit next to the library

Both payloads told agents OpenReceive never owns orders, then pointed them at
cloning the repository. An agent working in an existing app does not have that
repo, and copying a demo's `ShopOrder` / signed-cookie visitor over the tables
already there is the failure the buttons demo exists to prevent. The directions
now spell the combination recipe: this app's order id is the `reference`,
products price the order, users authorize it, the order is unpaid or paid, and
the library's payment rows are not joined from host models. The inlined
quickstarts' `onPaid` / `on_paid` are the guarded `UPDATE … WHERE state =
awaiting_payment`. Node's extra: pass this app's `db` handle, use the `query`
the settlement transaction hands you, and do not invent a `PaymentRepository`.

### The docs the agent directions point at are fetchable now

The reading list at the end of both agent-directions payloads named page URLs —
`https://openreceive.org/guides/authorization`. openreceive.org renders guides in
the browser, so fetching one returned an application shell with an empty
`<div id="root">` and none of the guide in it. Every link in that list was a
200 with no words behind it, and an agent cannot tell that from a blocked
network: the failure the site contract exists to prevent, arriving as a success.

Every page the site renders from a source here is now also published as raw
markdown at the same URL with `.md` appended, and the directions link that:

```
https://openreceive.org/guides/authorization.md
https://openreceive.org/guides.md
https://openreceive.org/api_docs.md
```

- **`docs/site-contract.json` is `contract_version: 2`.** Every `publish[]` entry
  rendered from a source here gains `markdown_path` beside `path`. The bump is
  deliberate rather than an additive field: the payloads shipped alongside it
  link `markdown_path`, so a site that ignored it would 404 the whole reading
  list. `docs/internal/site-build.md` has the obligations.
- **The inlined quickstart's sibling links point at `.md` too.** They are
  followed by whatever the payload was pasted into, which still has no browser.
- **`npm run check:docs` checks the twins.** A payload may link
  `/guides/<slug>.md` for a public slug, and `/guides.md` or `/api_docs.md`; a
  `.md` on any other site-owned page fails the gate, because nothing generates
  one.

All four Buy a Button stacks — `node-express`, `static-html-small-api`,
`nextjs-fullstack` and `rails` — were rebuilt against the 0.3.1 packages, and
the Playwright suite runs against `node-express`. `openreceive` (the core gem)
is byte-identical to 0.3.0 and ships to keep the one-version-for-everything
rule; `openreceive-rails` carries the doctor task and the allow-all warning.

The live wallet smoke (`npm run test:live`) was NOT run for this release: it
needs a funded NWC connection. Note that the smoke script itself changed here —
it had been reading `product.invoice_expiry_seconds` from a `product.json` that
never carried that key, so `expiry` went out undefined on every live run, and it
now prices the cheapest button from `shop-catalog.json`. That correction is
therefore unexercised against a real wallet.

This is a PATCH bump: nothing left the public API. `resumable` and
`lazyAssetUrlTable` are additive, and both are optional.

## 0.3.0 - 2026-08-26

Seven changes that all answer the same question: what does an integrator have to
KNOW that the API could have known for them? Each one moves a rule out of prose
and into a type, a default, or an object that owns it. Nothing on the wire
changed except one optional response field.

### The swap refund staging is the engine's problem now

`requestSwapRefund({ confirm: false })` fabricated the staged refund address
client-side and handed it back as a return value. Nothing wrote it into the
snapshot pipeline, so the next `/swaps/status` tick answered without it and the
refund form emptied under the payer mid-review — unless the integration
remembered to fold every polled snapshot through `overlaySwapRefundStaging`
first. That was a documented MUST, a silent failure mode, and no type error.

`CheckoutController` now owns it:

```ts
const staged = await controller.stageSwapRefund({ attemptId, refundAddress });
// …the payer reviews; polling continues; the address stays put…
await controller.confirmSwapRefund({ attemptId, refundAddress });
```

- **`stageSwapRefund` / `confirmSwapRefund` / `clearSwapRefundStaging`** are on
  `CheckoutController` (and on React's `useCheckout` result). The two verbs
  replace one `confirm: boolean` — a flag that picked between `POST /swaps/status`
  and `POST /swaps/refunds` was two operations wearing one name. The two steps
  are still two steps.
- `CheckoutWatcher` holds the staged attempt and folds it into **every** snapshot
  it publishes, before `onSnapshot` and before the derived state. A host that
  stores what it is handed keeps the address the payer is typing.
- **`overlaySwapRefundStaging` is gone from `@openreceive/browser/headless`.**
  Nothing needs it: the watcher applies it, and `selectCurrentSwapInvoice` — new
  on the surface, and previously a near-identical private copy in each shipped
  renderer — applies it for a UI carrying its own started attempt.
- **`requestSwapRefund` takes `paymentHash`**, not `invoices` + `attemptId`. The
  route takes a hash; resolving an attempt id to one is the job of whoever holds
  the snapshot, and the controller does it. The documented throw
  `Swap refund requires the original payment hash.` is gone with the parameter.
- `CheckoutControllerOptions.polling: false` withholds the status fetcher without
  withholding the mount, so a checkout that deliberately does not poll can still
  stage a refund.

### The network question is data, not a rule you remember

Payment methods group by label, and the groups are not the same size: USDT is on
three networks, SOL on one. Asking "which network?" above a single tile teaches
the payer that the network step is ceremony to click past — one screen before
USDT, where a wrong send is unrecoverable. The rule lived in nineteen call sites
and in two near-identical ~15-line blocks per renderer.

- **`resolveWizardSelection({ pickerKey, previousKey, entries, selectedNetworks })`**
  answers what a tile click MEANS as a discriminated `WizardSelection`:
  `start_swap`, `choose_network` (carrying the group, the heading, the
  `aria-controls`/`aria-labelledby` pair and the updated network map),
  `select_method`, or `none`. A single-network group comes back as `start_swap`,
  so the ceremony mistake is now unrepresentable.
- **`createMethodGridDisplay`** gives the method grid the display model it was
  the only pane to lack, carrying `needsNetworkStep` / `startPayInAsset`,
  `limitMessage` quoted from the group's cheapest entry point, the accent, the id
  pair and the Continue button's finished label.
- `findSwapGridGroup`, `updateSelectedSwapNetworks`, `formatChooseNetworkHeading`,
  `wizardNetworkGroupIds`, `swapGroupLimitOption` and
  `resolvePreservedNetworkSelection` left the surface: both renderers stopped
  importing them, which is exactly what the curation rule says should happen.
- **`SwapDisplayModel.copyRows`** carries the Address / Memo / bare-Amount rows as
  data (`{ label, value, copyValue?, selectable }`). Both deposit panels render
  it instead of hand-writing the same three calls.

### `assetBaseUrl`: the asset seam a wrapper can reach

`resolveAssetUrl` is a function, and a function cannot cross an HTML attribute —
so under Vue, Svelte and Angular, which all call `defineElements()` with no
options against a first-write-wins registry, there was no way to move the
provider icons off the packaged URLs at all. Under webpack those come out as dead
`file://` links that also publish the server's directory layout.

- **`assetBaseUrl`** is a shared wrapper prop and an **`asset-base-url`** attribute
  on `<openreceive-checkout>`. Point it at wherever you serve the packages'
  `dist/assets` trees; every packaged key is joined to it directly.
- `createAssetBaseUrlResolver(base)` is the one-line adapter, exported for a
  headless host.
- An explicit `resolveAssetUrl` still wins, and setting both warns once.
- `WizardRouteAssetDisplay` gained `iconPath` — parity with
  `WizardProviderDisplay`, so a host serving the files itself has the key.
- The api-reference claim that every `<Checkout>` prop is shared with the
  wrappers was false and now is not.

### Show the payer what they are buying

The shipped checkout renders the total and never the order — it cannot, because
OpenReceive owns no line items. A stock integration is a QR and `$1.00`.

- `amountFor` / `config.amount_for` may return an optional **`description`**
  beside the price. It rides the prepare and create responses (never a request
  body — the payer does not write the copy next to the amount) and both drop-ins
  render it above the amount, on every screen. One display string, deliberately:
  a line-item schema would make OpenReceive own the order.
- The custom element gained a **`slot="order"`**, the equivalent of React's
  render-prop `children`, projected through the shadow root so it survives every
  re-render.
- Contract: `PrepareCheckoutResponse.description` and
  `CreateCheckoutResponse.description` (a sibling of `checkout`, so the swap
  contract is untouched), with golden vectors in both engines.

### `getPaymentWizardRoutes()` answers the question a checkout is asking

It returned `[]` with no arguments. `btc-lightning` is the one route that belongs
under a Lightning invoice, so that is now the default — while an unknown asset or
route, and the routeless fiat assets, still answer `[]`. The default never stands
in for a route you asked for and did not get.

### The flagship headless demo stopped teaching the hard glue

Hello Fruit's Rails variant hand-rolled a poll loop whose own comment admitted it
"mirrors CheckoutWatcher's rules": in-flight guard, failure counter, Retry-After
backoff, a per-tick status fetcher. Agents copy the demo. `CheckoutFlow` now
drives `createCheckoutController` and keeps only what a store layer is for, and
its swap refund is two method calls.

### Agent directions are a prompt, and they are generated

[`docs/agents/node.md`](docs/agents/node.md) and
[`docs/agents/rails.md`](docs/agents/rails.md) are the instructions to hand a
coding agent integrating OpenReceive — and the payload behind the site's "Copy
agent directions" button, which is the constraint that shapes them. Someone
pastes them into Cursor, Claude or Codex, often on a small model, alongside
their own application code.

So they are **self-contained**: Step 0 (check the environment before writing
code), the non-negotiables no API call can state for itself, and the stack's
quickstart inlined in full. An agent with no network, a blocked github.com, or
no fetch tool at all can finish the integration from the paste alone. Nothing in
them resolves against a repository, because the reader does not have one.

They are also **built, not maintained**:
`tools/docs/generate-agent-directions.mjs` assembles each payload from
`docs/agents/src/<stack>.md` plus the quickstart, rewriting the guide's sibling
links to site URLs, and fails the gate when a payload is stale, when a link
points anywhere the site does not publish, or when the paste grows past 24 KB
(~6k tokens) — the budget that keeps it absorbable in one prompt. Both payloads
were ~30 KB before the checkout-UX rules moved out; that is the growth the gate
exists to catch. `npm run check:docs` runs all of it in CI.

### `docs/guides/checkout-ux.md`, and a contract for openreceive.org

The payer-facing rules that used to live in the agent directions — no progress
stepper, ask "which network?" only where there is a question, a copy row for
every value the payer must retype, wallet suggestions that say they are
suggestions, the receipt as evidence rather than debug output — are now
[Checkout UX](docs/guides/checkout-ux.md), one guide, linked from the frontend
and headless pages. They are rules the shipped renderers already obey, so they
belong where someone replacing those renderers will look, not in a prompt every
integrator pays for.

[`docs/site-contract.json`](docs/site-contract.json) is the single file the
openreceive.org repository reads per release: every URL the site must serve,
mapped to the markdown that renders it, plus the copy-button payloads with their
byte sizes, the pages the site owns, and the contributor docs it must never
publish. Generated from `docs/manifest.json`, so the links inside a payload
cannot promise a page the site does not have.
[`docs/internal/site-build.md`](docs/internal/site-build.md) explains it. The
docs index now covers `docs/agents/`, so a file there cannot ship unlisted.

### Dropped the "self-custodial" claim

OpenReceive holds no key and exposes no send API, but the custody of the funds
belongs to whatever NWC service the merchant connected — which may well be a
custodial one. Calling the library self-custodial promised a property only the
merchant's wallet choice can supply. The README, `AGENTS.md`, both agent-direction
payloads and the Checkout UX guide now say what is actually true: the merchant
picks the NWC service, and running one on their own hardware is one of the
options.

### Removed: the `PaymentData` family

`createPaymentDataEntries`, `PaymentDataEntry`, `PaymentDataSource`, React's
`<PaymentData>`, `orClasses.paymentData*` and `checkoutLabels.viewPaymentData`
are deleted. Deprecated in 0.2.4 with zero shipped callers; both renderers'
settled panels already render `createTransactionDetails`, whose rows are a strict
superset and carry `copyValue` and explorer links. Use `<TransactionDetails>`.

Examples were rebuilt against the 0.3.0 packages. Every package changed this
release: the browser, elements, React and wrapper packages carry the new
surface, `@openreceive/http` carries the description on the prepare and create
responses, and `openreceive-server` and `openreceive-rails` carry its Ruby half.
The live wallet smoke (`npm run test:live`) was NOT run for this release: it
needs a funded NWC connection, and nothing here touches the wallet call path —
the invoice, settlement and refund routes are byte-identical in behavior.

This is a MINOR bump rather than a patch because three names left the public
API: `overlaySwapRefundStaging`, `requestSwapRefund`'s `invoices` + `attemptId`
parameters, and the `PaymentData` family. Pre-1.0, a breaking contract change is
a minor per the release rules.

## 0.2.4 - 2026-08-26

Twelve findings from building a real store on the packages: one shipped bug, one
inconsistency between two panels, three small API additions, and the guides that
let all of them happen. Nothing on the wire changed — the HTTP routes, the mint,
the swap lifecycle and the refund two-step are untouched.

### Packaged images were dead `file://` links outside Vite

The provider icons and pay-tutorial screenshots resolve against
`import.meta.url`. Webpack — and anything else that replaces that expression at
build time with the module's own on-disk URL — turned every one of them into
`file:///app/node_modules/@openreceive/…`, which no browser loads and which
publishes the server's directory layout into a public asset. The files are not
emitted either, and cannot be: webpack's asset detection needs a string literal
and both maps build their paths inside a `.map()`. It failed silently: blank
images, no request, no error.

- **A diagnostic.** `warnOnFileAssetUrl` logs one `console.warn` naming the
  packaged path the first time a packaged asset resolves to `file:` in a
  document. Node and SSR are excluded — `import.meta.url` IS a file URL there and
  nothing is being painted.
- **A supported seam.** `AssetUrlResolver` — `(packagedPath: string) => string`
  — is accepted by every display builder in `@openreceive/browser/headless`, by
  `<Checkout>`/`PaymentWizard` in `@openreceive/react` (`resolveAssetUrl`), and
  by `defineElements` in `@openreceive/elements`. Serve the files yourself and
  map them by the registry's own keys.
- **The keys are published.** `WizardProviderDisplay.iconPath` carries the
  packaged path next to the resolved `icon`, so the display layer is
  self-sufficient instead of sending you back to `providerRegistry`;
  `paymentIconPaths` is the same key set for this package's own icons.
- **The guide says so.** `docs/guides/provider-registry.md` no longer says these
  "resolve to local assets", which read as reassurance. It says they are files
  your host has to serve, that the packaged resolution only works for a
  Vite/Rollup chunk, and that blank icons mean grepping the bundle for `file://`.

### The deposit warning follows the risk, instead of firing on every rail

Every `pay_in_asset` got the same red "Wrong currency or network = lost funds"
banner, including `SOL_SOL` — where the address is a base58 ed25519 key that
exists on no other chain and SOL exists on no other chain either. A banner shown
on every rail is read on none, and the rails where it is load-bearing (USDT on
four networks, ETH on six) are the ones that pay for the erosion.

- **`swapDepositRisk(payInAsset)` / `SwapDepositRisk`** classify a rail as
  `"chain_ambiguous" | "asset_only" | "pinned"`, and `SwapDisplayModel` carries
  the answer as `depositRisk`. The axis is address ambiguity, **not**
  native-vs-token: `ETH_ETH` is a native coin and needs the alarm most of
  anything on the list, because a `0x…` address is byte-identical on six chains.
- **Derived, not tabulated.** It asks whether the address format pins the chain
  and whether the asset is that chain's native coin, so a rail added tomorrow is
  classified without an edit — and an unrecognized one falls through to the full
  alarm rather than inheriting the quiet heading.
- **Both renderers follow it.** A `pinned` rail gets the same block with
  `checkoutLabels.sendExactAmountTitle`, no red, no warning triangle and no
  `role="alert"`, plus `data-or-deposit-risk` for your own CSS. It still states
  the exact amount and still says to pay with one method only — an SPL token
  sent to a Solana address still will not credit the order.
- The per-rail table is now the test, in `tests/react-swap.test.mjs`.

### The payer's receipt is the same panel everywhere

A payer who paid by swap saw the deposit txid with a copy button and an explorer
link, one screen before settling. A payer who paid over Lightning ended on a
64-character payment hash they could not copy with a click. Both builders'
JSDoc called itself the post-settlement panel; the richer one was used
pre-settlement and the plainer one after.

- **The settled panel is now `TransactionDetails`** in both renderers — copy
  buttons, explorer links, and truncation with the full `copyValue` behind it.
  No `decodeLinkUrl` is passed, so the bolt11 still never reaches a third party.
- `createPaymentDataEntries` and React's `<PaymentData>` are **deprecated** and
  still exported: their rows are a strict subset. Nothing breaks.

### Three additions for custom UIs

- **`swapOptionLimitSentence(option, context, { label })`** — the limit on a
  disabled tile as one finished sentence ("To pay with SOL, your cart total must
  be at least $2.43."). A grid that disables a tile has room for a tooltip and
  nowhere to put `createSwapUnavailableModel`'s four parts, and every custom UI
  was otherwise going to write this string itself, differently.
- **`AssetUrlResolver` / `paymentIconPaths`** — above.
- **`swapDepositRisk` / `SwapDepositRisk`** — above.

### Guides

The pattern behind most of the above: the shipped renderers already did the
right thing, and the guide an integrator is handed either stayed silent about it
or said the opposite.

- **`openWallet` is documented as touch-only**, in the headless guide, the
  frontend guide, the API reference and its own JSDoc — with the mechanism
  (`location.assign` on the current window, over a still-polling checkout) and
  the reason `<Checkout>` ships no wallet button. The Material UI recipe drew it
  as the primary action next to a de-emphasised Copy; it now leads with Copy and
  keeps the wallet button behind a touch check.
- **`checkoutLabels` gets a section**, not a bare name in a list of nine. It is
  every payer-facing string the shipped renderers emit, and a custom UI is a
  third renderer.
- **A refunds section**, which did not exist anywhere in the guide tree: the one
  state a refund is possible from, the 409 when it changes under the payer, the
  two-step where `confirm: false` does not touch `/swaps/refunds` at all, the
  twelve provider states, `refund_reason`, and the asymmetry that an
  overpayment is `attention` and not a refund. The `requestSwapRefund` parameter
  list was also missing its required `invoices` argument — code written from the
  guide alone threw at runtime on the payer's first refund.
- **"Progress is a status, not a position"** — why the shipped renderers draw a
  status line and a breadcrumb and no stepper, with the counts (4 `Status`, 6
  `CheckoutPhase`, 12 `SwapProviderState`, mostly outcomes), and the fact that
  `createCheckoutStatusModel` reports a zero-countdown non-terminal phase as
  `expired` so you must read the model's `phase` and never the snapshot's.
- **A method-picker section** promoting the five symbols that explain a disabled
  tile out of the machine-generated "uncovered" block.
- **`<Checkout>`'s `children` render prop is public**, and was previously
  mentioned only in `docs/internal/wrapper-parity.md`. It is the slot for order
  context, which the shipped checkout otherwise never shows — it renders the
  amount, never the order.
- **`<TransactionDetails>` is documented**, including that it mounts on your own
  order page outside `<Checkout>`.
- **`update_all` fires no callbacks**, said out loud in the Rails quickstart,
  with the row-lock alternative for an app that pushes settlement over Action
  Cable. Framed as a choice — conditional `UPDATE` when a job drains the flag,
  row lock plus `update!` when something has to fire on commit — because both
  are idempotent and the axis between them was never named.
- **A network-selection section**, stating as a requirement what both renderers
  already gate on: a group with one option has no network question, so start the
  swap from the tile and let only `options.length > 1` earn a second step.
  Asking anyway on SOL teaches the payer that the network step is ceremony, one
  screen before USDT, where a wrong send is unrecoverable.
  `findSwapGridGroup`, `updateSelectedSwapNetworks` and `wizardNetworkGroupIds`
  move out of the "uncovered" block into it.
- **The deposit values are the payer's to reproduce.** On a token rail the QR
  carries no amount, so the payer types six decimals by hand and a short send
  becomes `refund_required`. `SwapDisplayModel`'s `depositAddress`,
  `depositMemo` and `depositAmount` each owe the payer a labelled row with a
  copy button, and the amount is copied **bare** — `0.032664 SOL` is not
  something a wallet's amount field accepts, which is why the model keeps the
  number and the labels apart.

Examples were rebuilt against the 0.2.4 packages. Only the browser-side
packages changed — `@openreceive/browser`, `@openreceive/elements`,
`@openreceive/react` and `@openreceive/provider-data`; `core`, `node`, the HTTP
adapters and all three gems are byte-identical to 0.2.3 and release in lockstep
only. The live wallet smoke (`npm run test:live`) was NOT run for this release:
it needs a funded NWC connection, and nothing here touches the wallet call path.

The public API surface gained seven names and removed none — five on
`@openreceive/browser/headless` (`swapDepositRisk`, `SwapDepositRisk`,
`swapOptionLimitSentence`, `AssetUrlResolver`, `paymentIconPaths`) and two on
`@openreceive/provider-data` (`warnOnFileAssetUrl`, `AssetUrlResolver`) — so the
diff in `tools/validate/public-api.snapshot.json` is additive throughout.

## 0.2.3 - 2026-08-25

One fix, on the wire: `POST /checkouts` now echoes `payment_methods`.

### The pay-in catalog survives a mint for every client, not just the JS one

0.2.2 fixed the dropped catalog client-side, with `requestCheckout({ previous })`.
That closed it for `@openreceive/browser` callers — the great majority — and
left it open for everyone else. `/checkouts/prepare` and `/payments/check` both
echoed the catalog; `/checkouts` alone did not, so a native mobile client, a
server-to-server integration, or an SDK in another language still hit the
original failure — mint Bitcoin, lose the method list, picker comes back empty —
with no `previous` helper to reach for and nothing in the response to hint at
it. The wire is the contract for those callers, so the catalog belongs on it.

- **HTTP contract 0.4.0 → 0.4.1** (additive response field).
  `CreateCheckoutResponse` requires `payment_methods` alongside `checkout`,
  mirroring `PrepareCheckoutResponse`.
- **Both engines echo it**, amount-aware against the minted attempt's own
  invoice amount, on the re-fetch path as well as the mint path.
- **It costs no extra provider call.** The Node handler serves the echo from
  the same warm per-amount cache `payments/check` already used, so the mint
  warms the catalog and the first status poll reuses it — one provider walk
  between them, asserted in the suite.
- **`@openreceive/browser` reads it** as a sibling of `checkout`, so a mint
  carries the catalog with no `previous` at all.

`requestCheckout({ previous })` is unchanged and still worth passing: it is the
snapshot-**continuity** mechanism, carrying sibling attempts (a live swap beside
the newly minted bolt11) that the mint response knows nothing about, and it
still rescues the catalog from a server older than 0.4.1. What changed is that
the client-side merge is now an optimisation rather than a requirement — which
is what the 0.2.2 notes should have been able to say.

Pinned in both engines: the shared golden vector carries the new key, so an
extra or missing field in either engine fails the run, and a non-empty-catalog
test on each side asserts the echo is amount-aware.

Examples were rebuilt against the 0.2.3 packages. The live wallet smoke
(`npm run test:live`) was NOT run for this release: it needs a funded NWC
connection, and nothing here touches the wallet call path.

## 0.2.2 - 2026-08-25

Fixes for defects found building a real shop against `openreceive-rails` 0.2.1
and `@openreceive/browser` 0.2.1. Four of them stopped a stock Rails
integration outright, in the order an integrator hits them.

### Rails: the quickstart works end to end again

- **The generated migration would not load.** `openreceive:install` wrote
  `class CreateOpenreceiveTables`, but the engine registers an `OpenReceive`
  acronym inflection, so Rails resolved the file name to
  `CreateOpenReceiveTables` and the quickstart's second command died with
  `NameError: uninitialized constant CreateOpenReceiveTables`. Every install
  hit it. The template now declares the class Rails looks for, and a new
  generator test registers that acronym and actually RUNS `db:migrate` against
  in-memory SQLite — asserting the file was created is what missed it.
- **`openreceive-rails` now depends on `nwc-ruby`.** Building the client from
  `NWC_URI` is the engine's DEFAULT path and the only one the quickstart
  describes, so with the single gem the quickstart names, the app booted and
  the first checkout 500'd with `Install nwc-ruby or configure nwc_client.`
  The "deliberately not a hard dependency" rationale still holds for
  `openreceive-server` — a Rack host injects its own client — and it keeps the
  omission; the engine is the exception that comment already named.
  `config.nwc_client` remains the supported override. CI installs the gem and
  a new test drives the real client through the boot preflight path: every
  other Ruby test uses a hand-written fake, which is how the suite stayed green
  against a gem nobody installed.
- **`assets:precompile` no longer fails the image build.** That is a production
  boot by `RAILS_ENV`, but it runs before any wallet secret is mounted — the
  shape of Rails' own generated Dockerfile — so the eager preflight failed the
  BUILD long before the deploy it exists to protect, and the only lever was a
  flag the host had to invent. The engine now detects an asset build (Rails'
  `SECRET_KEY_BASE_DUMMY`, or an `assets:precompile`/`clean`/`clobber` rake
  invocation), skips the preflight, and logs one line saying so. New
  `config.eager_preflight = false` is the explicit lever for any other
  secretless boot; it disables the BOOT check only. A real production boot with
  no `NWC_URI` still fails closed.
- The generated migration's `payment_hash` check constraint reads as ordinary
  Ruby: the adapter branch is hoisted to a local above the call instead of
  being spliced into the middle of the argument list.

### Browser

- **`requestCheckout` takes `previous`.** `POST /checkouts` answers with the
  minted bolt11 alone, not the warmed `payment_methods` catalog, so a headless
  host building its snapshot from that response ERASED the method list its
  picker renders from: the payer selected Bitcoin, changed their mind, and the
  swap options were gone until the next poll. Pass the prepared snapshot and
  the mint is folded into it, keeping the catalog and any sibling attempt. The
  shipped renderers already did this internally and are unchanged.
- **`now` options are unix SECONDS, and say so.** `deriveStatus`,
  `createSwapDisplayModel`, `createCheckoutState` and friends compare `now`
  against `expires_at`; passing `Date.now()` made every invoice read as
  permanently expired with no error and no warning. They are typed
  `UnixSeconds` (exported), documented, and a milliseconds value now throws a
  `RangeError` at the call that made the mistake rather than silently expiring
  the checkout.

Not a defect, checked: the browser package already forwards the page's
`<meta name="csrf-token">` as `X-CSRF-Token` on every body-bearing request, so
`@openreceive/elements` inherits a Rails host's `protect_from_forgery` with no
wiring. Verified in the published 0.2.1 tarball; the host page must render
`csrf_meta_tags`.

### Docs

- The headless guide claimed its curated symbol list could not drift from the
  entry module, and it had: six swap symbols were named while
  `requestSwapRefund`, `getSwapRefundFormError`, `createQrSvg` and `openWallet`
  were not, and `overlaySwapRefundStaging` — which MUST be called if you poll,
  or the next `/swaps/status` tick wipes the payer's staged refund address —
  was absent entirely. Those now have prose, and
  `tools/docs/generate-headless-surface.mjs` fills a generated block with every
  symbol no hand-written section names, so the claim is true and `--check`
  enforces it.
- `requestCheckout({ previous })`, `config.eager_preflight`, the asset-build
  skip, and the `nwc-ruby` dependency are documented in the API reference,
  deploying guide, and Rails quickstart.

Examples were rebuilt against the 0.2.2 packages. The live wallet smoke
(`npm run test:live`) was NOT run for this release: it needs a funded NWC
connection, and nothing here touches the wallet call path.

## 0.2.1 - 2026-08-24

First test publish to NPM and RubyGems

### Second audit sweep

A second full-repo audit fixed 24 correctness bugs, removed 22 trust-model
violations, closed 7 wrapper-parity gaps, and finished the `order_id` →
`reference` rename. The behavior changes worth knowing:

- **Settlement.** A notified `payment_received` now checks pendingness BY HASH
  (`payments.findPendingAttempt`) instead of membership in the oldest-200
  batch, so a notified settlement no longer waits for a backlog to drain.
  A reconcile result that reports `settled` with no `paidAt` is reported as a
  failure instead of skipped silently, and the request-path reconcile pass now
  runs AFTER the body's cheap refusals so an anonymous garbage POST cannot
  claim the gate. Rails exempts unauthenticated `GET /rates` from the pass,
  matching the JS handler.
- **Wallet scans.** A `list_transactions` page whose rows are all unusable now
  fails the scan in both engines rather than reading as an empty wallet — an
  empty-looking scan at expiry+grace closes unpaid attempts. Within a page, a
  row whose PRESENT fields cannot be read (a non-hex `payment_hash`, an
  unparsable amount) is skipped and counted; absent fields still mean absent.
- **Invoice expiry.** A wallet that clamps expiry no longer fails every
  checkout: the ledger stores the wallet's own `expires_at` and logs
  `checkout.invoice_expiry.adjusted`. A caller-supplied `expirySeconds` (only
  the swap path sets one) stays a hard floor, and only when the wallet comes
  in short.
- **Swaps.** Provider transport failures on `/swaps`, `/swaps/status` and
  `/swaps/refunds` map to 502/503 instead of a generic 500. A provider order
  without an expiry fails the create rather than inventing a 10-minute window,
  and a provider amount that is present-but-unparsable throws instead of
  vanishing. When every configured provider fails its catalog fetch, methods
  report `provider_unreachable`, not `provider_unconfigured`. A 429 backoff no
  longer resets when the weight window rolls.
- **Checkout UI.** `startSwap` now quotes before it starts, in the SHARED
  session, so React and the custom element behave identically — an
  out-of-range amount is an accepted-range panel in both, built from one
  `createSwapUnavailableModel`. Expired-mid-swap keeps the wizard in both. The
  refund review gate is explicitly client-side: `refund_nonce` and
  `refund_nonce_expires_at` are gone from the browser wire types (the server
  never sent them), and `SwapDisplayModel` carries `refundAllowed: boolean`.
  A swap deposit QR that cannot encode its amount now throws instead of
  silently degrading to an amount-less payment URI.
- **Renames.** Option types match their factories (`CreateHostOptions`,
  `CreateStackOptions`, `CreateHttpHandlerOptions`, `DefineElementsOptions`,
  …). `@openreceive/browser` exports `createLightningUri` / `createQrSvg` /
  `createQrPngDataUrl` under those names on both entry points, and no longer
  exports the internal `readJsonResponse`. The adapter packages no longer
  re-export the 14 generated `Wire*` body types (still on
  `@openreceive/http`). Ad-hoc app-route console loggers are
  `createAppConsoleLogger` / `createAppBrowserConsoleLogger`, so `Host` names
  only the persistence object.
- **New.** `createStack` takes `onBootFailure`, and a failed boot answers
  `503 WALLET_UNAVAILABLE` in the error contract instead of rethrowing the raw
  cause. `payInAssetNetwork` in `@openreceive/core` owns the
  `pay_in_asset` → network split that four call sites re-derived.

### ORM handles wrap in one call: `knexDb`, `prismaDb`, `typeOrmDb`, `sequelizeDb`

- `@openreceive/http` ships a named `SqlAdapter` factory per ORM whose handle
  `createSqlPayments` cannot accept directly. The parameter types are
  structural (no ORM dependency); `dialect` stays a required argument. The
  guide's copy-paste recipes are gone — and the shipped `prismaDb` fixes a bug
  the Prisma recipe carried: only `^select` statements ran through
  `$queryRawUnsafe`, so an `UPDATE … RETURNING` fulfillment claim (the
  guide's own `onPaid` example) lost its rows and never fulfilled.
- `sequelizeDb` closes the last gap: Sequelize was a first-class scaffold flag
  whose only documented wiring was "open a second `pg` Pool to the same
  database, or hand-roll an adapter". It binds parameters through Sequelize's
  `bind` option and threads the managed transaction into every statement
  inside it — Sequelize carries the transaction on the same instance, so a
  hand-rolled adapter that missed that ran settlement outside the transaction.
- The scaffold's wiring guide no longer prints hand-rolled `SqlAdapter`
  snippets for Prisma/Knex/TypeORM/Sequelize; each section is now the shipped
  factory in one line.
- `npm run test:orms` proves the factories against the real ORMs: knex,
  typeorm, and prisma (7, via its better-sqlite3 driver adapter) each drive
  the payments repository — commit, write-once settlement, reconcile-gate
  CAS — on sqlite. Weekly `orm-adapters` job in `demos.yml`; the ORMs are
  devDependencies only. The no-database-driver gate now checks the root
  workspace manifest on its runtime dependencies (package and example
  manifests stay strict in full) so the lane's sqlite driver can exist at
  dev time.

### The browser's swap requests no longer throw `Illegal invocation`

- Every swap route call (`/swaps`, `/swaps/quote`, `/swaps/status`,
  `/swaps/refunds`) invoked the caller's fetch as a method of its options
  object, rebinding `this` — and `window.fetch`, the default, throws
  `Illegal invocation` for any `this` but the window. The swap flow was
  broken in real browsers across all four wrappers; the e2e swap specs catch
  it now. Checkout and status requests always bare-called a local and were
  unaffected.

### Cross-site requests are refused by the handler; the Rails engine inherits `protect_from_forgery`

- Every body-bearing route now answers `415` for a body that is not
  `application/json` and `403` for a request the browser labels
  `Sec-Fetch-Site: cross-site`, in both engines and before `authorize` runs. A
  cross-site form cannot set a JSON content type, a cross-origin `fetch` that
  does is CORS-preflighted (never answered), and the `Sec-Fetch-Site` gate
  covers the remaining `no-cors` forgery. Golden vectors `11` and `12` pin
  both refusals; vectors may now declare extra request `headers`.
- `OpenReceive::ApplicationController` no longer calls
  `skip_forgery_protection`: the host's `protect_from_forgery` applies to the
  engine's routes as it does to the host's own, and a failed check is the
  shared `403` instead of an opaque `500`. The browser client sends
  `X-CSRF-Token` from `<meta name="csrf-token">` on every request when the
  page renders one (`csrf_meta_tags`), from one shared `requestHeaders`
  helper; a host `headers` value still wins. The Rails demo drops its
  `:null_session` override and runs Rails' default.

### `reference`, not `order_id`: the host's order is not part of the story

- The grouping key OpenReceive stores is now called `reference` everywhere —
  the `openreceive_payments` column, every HTTP request and response body,
  the browser snapshots, the `<Checkout reference>` prop (`route-reference`
  for the element wrappers), `AuthorizeResource.reference`, and the
  settlement passed to `onPaid` / `config.on_paid` (`PaymentSettlement`,
  formerly `OrderSettlement`). It is a string the host chooses — its order
  id, one per payable thing and never reused — that OpenReceive groups
  attempts under and fulfills at most once. Rails hosts recreate the engine tables
  (`bin/rails db:reset` on a development database).
- `loadOrder` + `amountForOrder` collapsed into one hook: `amountFor(reference)`
  returns the trusted price or `null` for a 404 (Rails: `config.amount_for`,
  `nil`). The host is consulted only where a price is minted or quoted; status
  polls and refunds are answered from OpenReceive's own rows. This also fixes
  the Rails engine selecting attempts by the loaded object's `.id` rather than
  the id it was given, which broke hosts whose lookup key was not their
  primary key.
- `openreceive:install` no longer takes `--order-model`; the generated
  initializer names no model. `authorize` defaults to possession of the
  reference and `config.amount_for` is left for you to write (the engine
  refuses to serve checkouts until it is set).
- The fulfillment note rendered into every scaffolded migration, the Rails
  initializer, and the wiring guide now says only what OpenReceive guarantees
  about `onPaid` and what the host must guarantee. Its "optional foreign key"
  recipe is gone, as is every "OpenReceive never reads, locks, or joins your
  order table" paragraph in the docs and source — there is no relationship to
  explain. `npx openreceive scaffold payments` rejects the long-removed
  `--order-model`/`--order-table`/`--order-id-type`/`--skip-foreign-key` flags
  as plain unknown options.

### One subpath under the UI: `@openreceive/browser/headless`

- `@openreceive/browser/internal` is gone. It was public API with a
  discouraging name — 130 values and 46 types that `@openreceive/react`,
  `@openreceive/elements`, and the wrappers imported and nothing documented.
  Those names now live on `./headless`, the one curated, documented surface
  the renderers and headless integrations share; 15 names only tests used are
  no longer exported. `npm run check:example-imports` had nothing left to
  reject and is removed.
- `docs/internal/display-boundary-findings.md` was deleted. Its
  display-boundary rule (formatters throw, display boundaries blank) is
  superseded by the AGENTS.md trust model: our own server, the configured NWC
  wallet, and the configured swap provider are trusted, and a throw in a
  checkout panel is our own API surfacing, not a display-boundary bug class to
  defend against.

### The OpenReceive prefix is gone; the import path is the namespace

- 415 exported and internal names drop the `OpenReceive` / `openReceive`
  prefix: `createOpenReceiveHttpHandler` → `createHttpHandler`,
  `createOpenReceiveHost` → `createHost`, `createOpenReceiveStack` →
  `createStack`, `OpenReceiveHttpError` → `HttpError`,
  `OpenReceiveServiceError` → `ServiceError`, `OpenReceiveDecimalError` →
  `DecimalError`, `openReceiveCheckoutLabels` → `checkoutLabels`,
  `formatOpenReceiveMsats` → `formatMsats`, `OpenReceiveWire*` → `Wire*`, and
  so on, one rule throughout. Kept, each for a reason: `OPENRECEIVE_*`
  constants (they read as config keys) and the custom-element tag names;
  `OpenReceive`, `createOpenReceive`, and `OpenReceiveError` (OpenReceive is
  the noun there, and `Error` is taken); the three mounts `openReceiveExpress`,
  `openReceiveFastify`, `openReceiveNextHandlers`; and `markOpenReceivePaidOnce`
  / `createOpenReceiveCheckoutElementAttributes`, which sit beside an
  unprefixed sibling that means something else. Where the bare name was
  already taken the rename picks a clearer one: `openReceiveRoutes` →
  `checkoutRoutes`, `reconcileOpenReceivePayments` → `reconcileHostPayments`,
  `openReceiveClientIp` → `resolveClientIp`.
- `status` is `deriveStatus` (its only in-tree caller already renamed it on
  import), and `OpenReceiveFiatAmount` — a currency-tagged decimal that is
  fiat OR BTC/SAT — is `MoneyAmount`.

### Fewer exports: what nothing outside the package reaches for

- 51 names leave the public surface because no guide, example, smoke check,
  or other package named them — only tests, which now read the source
  modules directly. `@openreceive/node` lists its public types explicitly
  instead of `export type *`, so its service-internal types
  (`NodeOptions`, `OpenReceiveServiceContext`, `ResolvedCreateAmount`,
  `NormalizedCreateCheckoutRequest`) stay internal. Gone, by package:
  - core: the price-feed tuning constants (`OPENRECEIVE_PRICE_FEED_*`,
    `OPENRECEIVE_*_PRICE_FEED_URL`, `OPENRECEIVE_INVOICE_QUOTE_TTL_SECONDS`,
    `OPENRECEIVE_STATIC_BTC_FIAT_RATES`) — `spec/data/rates/price-sources.json`
    is their contract; the `*_URL_ENV` names stay.
  - node: `normalizeNwcWalletError`, `summarizeWalletCapabilities`, the LSC
    env helpers (`parseLscUri`, `readLscConnectionsFromEnvironment`,
    `createLscSwapProvidersFromEnvironment`, `LSC_ENV_NAMES`,
    `LSC_URI_PROTOCOL`), the log-level helpers and
    `createOpenReceiveConsoleLogger`, `requireNwcFromEnvironment`,
    `SPEND_CAPABILITY_WARNING_DELAY_MS`, `isOpenReceiveSwapTerminalState`.
  - http: `resolveSqlAdapter`, `openReceivePaymentInsert`,
    `openReceiveClientIpBucket`, `OPENRECEIVE_DEFAULT_IP_RATE_LIMIT_PER_HOUR`,
    `OPENRECEIVE_ATTEMPT_REUSE_BUFFER_SECONDS`.
  - browser: the console-logger level helpers and
    `createOpenReceiveBrowserConsoleLogger`.
  - elements: `renderCheckoutCreatingHtml`, `renderOpenReceivePaymentWizardHtml`,
    `wireTransactionDetailsCopy`, `OpenReceiveElementsSwapOption`.
  - react: `useCheckoutResume` and its option/result types (unused,
    undocumented); `CheckoutEventHandlers`.
  - provider-data: `listCryptoRoutes`, `getCryptoRoute`,
    `listDisqualifiedProviders` (no caller anywhere).

### `checkPayment` is gone; `reconcilePayments` is the only wallet-history read

- `service.checkPayment`, `@openreceive/core`'s `checkPayment`, and Ruby
  `Service#check_payment` were a one-hash wrapper around the same
  `list_transactions` walk `reconcilePayments` already runs. The mounted
  `POST /payments/check` route never called them. Check one invoice with
  `reconcilePayments({ attempts: [{ paymentHash, createdAt }] })`. A truncated
  walk omits that hash (retry next pass) instead of throwing
  `WALLET_UNAVAILABLE`.

### The all-in-one options say which mode they are

- `createOpenReceiveStack` and the adapters' all-in-one form take
  `wallet: { nwc } | { service }` and `storage: { db, onPaid, tableName? } |
{ payments, onPaid }` instead of five optional, mutually-constrained
  top-level keys. `onPaid`'s parameter type follows the storage branch, the
  "exactly one of nwc or service" runtime check is gone (the type says so),
  and the cast that once landed a custom repository in db mode is gone with
  it.

### The spec's own response shapes are closed

- `PaymentMethod`, `FiatQuote`, and `PaymentDetails` are named, closed
  component schemas; `PrepareCheckoutResponse`, `Checkout`, and
  `PaymentCheck` reference them instead of `additionalProperties: true`.
  `Swap` and `SwapCheckout` compose an open `SwapBase` and close themselves
  with `unevaluatedProperties: false` (OpenAPI 3.1 is JSON Schema 2020-12),
  replacing the hand-copied field list. The generated wire types follow
  (`OpenReceiveWirePaymentMethod`, `OpenReceiveWireFiatQuote`,
  `OpenReceiveWirePaymentDetails`; every wire type is now closed).

### One status vocabulary; one error vocabulary per layer

- `TransactionSettlementStatus` (`pending | settled | expired | failed`) is
  the base every status extends: `PaymentStatus` adds `not_found`,
  `OpenReceiveAttemptStatus` adds `attention`, the browser's `Status` is
  exactly the base. The relationship is now in the types, not only the prose.
  `TransactionSettlementDetection` is readonly like everything else.
- The host's `authorize()` returning `false` is `403 FORBIDDEN` (was
  `UNAUTHORIZED`, which in NIP-47 means the key has no wallet). The HTTP
  error vocabulary drops `INSUFFICIENT_BALANCE` and `PAYMENT_FAILED` — a
  receive-only library can never send them — and a wallet's own `FORBIDDEN`
  still normalizes to `RESTRICTED`. Both engines and the vectors move
  together; Ruby's `UnauthorizedError` is `ForbiddenError`.

### Maintenance

- `swap.providers` is `swap.provider` + `swap.failoverProviders`: the name
  now says what the code always did — failovers are consulted only when the
  primary throws, never to fill assets it omits.
- `prepareCheckout` takes `PrepareCheckoutOptions` (order id, prefix, fetch,
  headers): the type no longer accepts a `memo` it silently dropped.
- The spend-capability warning no longer pauses boot (the 5-second delay
  defaults to 0; nothing in the repo constructs a wallet client from a
  terminal, so there was no CLI site to keep it). The stack's boot-failure
  line logs the error message, not the object and its raw cause.
- `@openreceive/http` describes itself as framework-neutral over Web
  Request/Response and built on the Node runtime. `openReceivePaymentsIndexName`
  measures identifiers with `.length` (they are ASCII by construction) and
  keeps the digest that makes truncated names unique.

- `fixedfloat.ts` (1,134 lines, nine jobs) is six modules along the seams
  its siblings already used — transport, currencies, orders, quote, field
  readers, and the provider assembly. Move-only: the conformance vectors
  prove it.
- The hand-rolled Keccak-256 in the Ruby gem now has known-answer tests
  (NIST/Keccak digests and the EIP-55 specification addresses).

### `openreceive` is the CLI; the library is `@openreceive/*`

- The unscoped `openreceive` package no longer re-exports the library. It
  ships the `openreceive` command only (`npx openreceive scaffold payments`,
  `npx openreceive doctor`), forwarding to `@openreceive/node/cli`. Its 23
  `openreceive/*` subpaths are gone: import the scoped package you installed
  (`@openreceive/express`, `@openreceive/react`, …). One package per install,
  one package per import, and 646 fewer symbols in the public-API snapshot.

### Compatibility ranges are ranges that run

- `@getalby/sdk` `^8` (was `^7`; v8's one breaking change is requiring Node
  22, already this repo's floor). `@openreceive/next` declares
  `next ^14 || ^15 || ^16` (13 dropped; the adapter uses Web
  Request/Response only). `openreceive-rails` requires Rails `>= 8.0` (7.1
  and 7.2 are past security support and were never run here; 8.1 is what CI
  runs).

### Wallet preflight proves receive-only from the connection's own list

- Receive-only is proved from NIP-47 `get_info.methods` — what this
  connection may call — rather than the kind-13194 info event, which
  advertises the wallet service at large. A receive-only connection on a
  service that also serves spend-capable apps now boots; a connection whose
  own list carries `pay_invoice` is still refused. The event still supplies
  encryption modes, and stands in for the method list only when the client
  exposes no `get_info` (logged as `nwc.info_event.methods_fallback`). Ruby
  already read `get_info` first; both engines now agree.
- `AlbyNwcReceiveClient.close()` waits for an in-flight client construction,
  closes the relay client exactly once, and makes later calls reject.

### Naming: camelCase TypeScript, `Checkout` everywhere

- Server-side TypeScript surfaces are all camelCase now: the `authorize`
  resource carries `orderId`/`paymentHash`, and the rate quote carries
  `btcFiatPrice`/`amountSats`/`amountMsats`/`asOf`/`expiresAt`. The wire
  itself stays snake_case.
- The minted invoice is `Checkout` at every layer: the service type `Checkout`
  (was `CheckoutInvoice`), the generated wire body type `WireCheckout` (was
  `OpenReceiveWireCheckout`; from the OpenAPI document, shipped by
  `@openreceive/http`), and the browser's client-held snapshot type
  `CheckoutSnapshot`.
- The advanced rate-limit hook option is `rateLimitHook` (was `rateLimit`), so
  it reads as what it is and composes with the boolean `rateLimiting`.

### `onPaid` in both host modes (`onSettlement` removed)

- The settlement hook is `onPaid` in BOTH host modes; `onSettlement` no longer
  exists. db mode receives `PaymentSettlement` (was
  `OpenReceiveOrderSettlement`: `reference`, was `orderId`, plus the
  transactional `query`); custom-repository mode receives `SettlementEvent`
  (was `OpenReceiveSettlementEvent`: `paymentHash`/`paidAt`/`details`), with
  write-once still enforced by the library.

### Curated exports and the public-api gate

- `@openreceive/express`, `@openreceive/fastify`, and `@openreceive/next`
  re-export only the curated `@openreceive/http` surface: handler/stack
  factories, the error surface, the notification worker, and the
  options/context/hook types. The generated `Wire*` body types (was
  `OpenReceiveWire*`) and the host-integration internals — the SQL payment
  repository, the reconcile gate, `createHost` (was `createOpenReceiveHost`),
  the rate-limit helpers — live only on `@openreceive/http` (and
  `openreceive/http`).
- The UI wrappers export only the wrapper factories plus props/theme types,
  and `@openreceive/core` no longer exports internal formatting helpers
  (`satsToFiatValue`, `formatBtcFromSats`, …).
- A new `npm run check:public-api` gate pins every public surface in CI.
- `trustProxyIpHeader` (opt-in proxy-set client-IP header for `rateLimiting`)
  now exists on all three adapters.

### Scan topology

- Every scan entry point — the opportunistic request-path pass, the
  notification worker's periodic pass, and `startReconciler` (was
  `startOpenReceiveReconciler`) — claims the durable `openreceive_meta`
  reconcile gate, so all of them share the one NWC scan budget.
  Unauthenticated `GET /rates` never triggers a scan.
- `payments/check` serves `payment_methods` from a 60-second per-amount warm
  cache instead of one provider call per poll.
- Superseded rows are excluded from live-attempt matching, and the 409 create
  conflict no longer leaks the live/supersede vocabulary on the wire ("An
  unpaid checkout for this payment method is already in progress for this
  order.").

### `prefix` is the only URL the browser takes

- `prefix` — the base path the shipped router is mounted at — is now the
  single URL input of `@openreceive/browser`, `@openreceive/react`,
  `@openreceive/elements` and the Vue/Svelte/Angular wrappers. All seven
  routes are derived from it (`/checkouts`, `/checkouts/prepare`,
  `/payments/check`, `/swaps`, `/swaps/quote`, `/swaps/status`,
  `/swaps/refunds`), so create and settle can no longer point at different
  mounts.
- Removed: `checkoutUrl` (both the string and the `(orderId) => string`
  callback) on `prepareCheckout`/`requestCheckout` — pass `prefix`, which is
  now required, not optional.
- Removed: `{orderId}` / `{order_id}` templating in checkout URLs. The order
  id travels in the request body, as it already did for every other route.
- Removed: the `orderUrl` prop (React `<Checkout>`, `useCheckout`,
  `PaymentWizard`) and the matching `order-url` element attribute — pass
  `prefix` instead.
- Removed: `orderUrl={false}` as the polling switch. Use `polling={false}`
  (`polling="false"` on the element), which was already the documented knob.
  Behaviour note: `orderUrl={false}` also cut the payment wizard off from
  `/swaps*`, so it silently disabled swaps; `polling={false}` stops status
  polling only and leaves the swap flow working.

### Frontend

- The fiat/country wing and the crypto method tile are removed: the payment
  method union is `"bitcoin"`, and the swap flow is unchanged behind it.
- `@openreceive/elements` and `@openreceive/react` ship self-contained
  compiled `styles.css` files — a plain `<link rel="stylesheet">` works.
- React snapshot mode polls through the default `/openreceive` prefix like
  create mode; `polling` and `poll-interval-ms` (`pollIntervalMs`) knobs exist
  on the element and every wrapper.

### Schema

- `openreceive_payments` gains a locally clocked `inserted_at` column and
  CHECK constraints, and the install migrations seed the shared
  `schema_version` row in `openreceive_meta`. The per-IP rate-limit budget
  counts on `inserted_at` with a `(client_ip, inserted_at)` index in both
  engines (vector: `rate-limit-window.json`).

### Ruby engine parity

- Truncation-safe reconcile: a wallet-history walk cut short (page cap, pass
  deadline, or a wallet that ignores `offset`) omits undecided hashes instead
  of reporting `not_found`, so a truncated scan can never close a paid attempt
  — pinned by the new cross-language `wallet-scan-truncation.json` vector
  family. Each pass takes the oldest 200 pending attempts
  (`RECONCILE_BATCH_SIZE`).
- Schema-version refusal: the engine refuses to operate a database whose
  stored `schema_version` is newer than the library.
- The generated Rails migration supports MySQL alongside PostgreSQL and
  SQLite.
- Production boot builds the service (and its wallet preflight) eagerly, so a
  bad deploy fails closed instead of surfacing checkout-time 500s. The
  initializer template defaults `config.on_paid` to
  `OpenReceive::LOGGING_ON_PAID`, and the engine warns at every boot until it
  is replaced.
- `rake test` works from each gem directory, and the Ruby suites use glob
  test discovery.

### CI

- Per-push `rails-example` job; `check:public-api` runs per push; wrapper type
  checks (`vue-tsc`, `svelte-check`) and real wrapper mount tests.

### Release

- `npm run release:gem:build` works on prerelease versions. RubyGems rewrites
  an npm-style prerelease through `Gem::Version` (`0.2.0-alpha.0` becomes
  `0.2.0.pre.alpha.0`), so the release script no longer guesses the artifact
  filename from the workspace version — it normalizes through Ruby, builds
  straight into the output directory with `gem build --output`, and compares
  that same normalized version against rubygems.org when checking whether a
  version is already published.

## 0.1.1 - 2026-08-18

OpenReceive is pre-release and has no compatibility or migration commitments.

Version semantics: JS packages and Ruby gems share the workspace version
(0.1.1). The OpenAPI (`spec/openapi`, 0.4.x) and AsyncAPI (0.2.x) documents
version the wire contracts independently, and `docs/manifest.json` versions the
docs index; none of these three track the package release number.

### Opportunistic reconcile (no default long-running process)

- Settlement of abandoned checkouts now piggybacks on OpenReceive API calls:
  every mounted route (JS handler dispatch; Rails engine `around_action`) first
  runs one reconcile pass gated by the restored durable `openreceive_meta`
  key/value/rev table (CAS claim, `transaction_scan_gate`, minimum 2 seconds
  between real wallet scans, stretched 2/6/12s by pending-invoice age). Every
  worker sharing the host database races on the one gate row, so rapid calls
  collapse to one `list_transactions` scan per interval — the gate is the NWC
  scan budget. The awaited pass is time/page bounded (9s timeout, capped
  pages); a failed or timed-out scan warns, never fails the user's request,
  and leaves `claimed_at` so a broken wallet cannot stampede.
- `openreceive_meta` ships in `openReceivePaymentsSchemaSql`, every scaffold
  ORM template, and the Rails install migration — same host database as
  `openreceive_payments`. One migration creates both tables everywhere, and it
  is now named for what it does: `openreceive:install` writes
  `db/migrate/*_create_openreceive_tables.rb` (`CreateOpenreceiveTables`, with
  `--skip-migration` replacing `--skip-payment-migration`), and the JS scaffold
  emits a per-ORM migration: knex `db/migrations/*_create_openreceive_tables.mjs`,
  sequelize and typeorm `*-create-openreceive-tables.{cjs,ts}`, drizzle
  `src/db/openreceive-tables.ts`, prisma `prisma/schema.openreceive.prisma`.
  Custom repositories must implement
  `claimReconcileGate({ now, intervalSeconds })` or pass
  `opportunisticReconcile: false` (Rails: `config.opportunistic_reconcile`);
  construction throws otherwise, like `rateLimiting`.
- `reconcileOpenReceivePayments` / `OpenReceive.reconcile!` now return the
  pass's per-hash check results. `POST /payments/check` consumes the
  request-level pass instead of running its own per-invoice wallet walk: the
  gate winner serves status/`paid_at`/`details` straight from the pass; on
  `gate_busy` (or a hash outside the pending set) the host row serves
  status/`paid_at` with `details` omitted, and row `attention` reads as
  `pending` on the wire. Exactly one gate claim per request.
- No web process starts a settlement timer anymore: `createOpenReceiveStack`
  lost the `reconciler` option, the demos lost their reconciler
  loops/Procfile entries, and the quickstarts no longer tell hosts to schedule
  `OpenReceive::ReconcileJob`. The one optional worker does both listen and
  reconcile: JS `startOpenReceiveNotificationWorker({ service, host })`
  (wired from a host script; there is deliberately no host-aware CLI), Rails
  `bin/rails openreceive:notifications` (now with a built-in periodic pass).
  `startOpenReceiveReconciler`, `ReconcileJob`, and `openreceive:reconcile`
  remain exported one-shot/loop primitives.

### Headless browser surface (`@openreceive/browser/headless`)

- New public, semver-guaranteed subpath for integrations that bring their own
  UI: the checkout lifecycle (state machine, status model, poll fetcher),
  payment-method/wizard models, swap display models, formatters, labels, and
  the styling tokens that are the contract with the shipped stylesheet —
  curated symbol-by-symbol (never `export *`), seeded from what the flagship
  custom-UI rails example actually needs. `CheckoutState` (type) is promoted
  to the main entry; element plumbing (`createOpenReceiveThemeToggleElement`,
  checkout/theme-toggle tag, attribute, and event constants) moved to
  `@openreceive/elements`.
- No file under `examples/` imports any `@openreceive/*/internal` subpath
  anymore; `npm run check:example-imports` (wired into `test:ci:release`)
  fails CI if one comes back. `/internal` remains wrapper-only plumbing with
  no stability guarantee, and the new
  [headless checkout guide](docs/guides/headless-checkout.md) documents the
  two supported integration styles.

### Ruby engine parity

- The Ruby core gem gains the built-in price feed (`OpenReceive::Rates`): a
  static provider and the cached live feed with primary/fallback failover,
  60-second caching, fail-closed windows, and the shared 46-currency list,
  drift-checked against `spec/data/rates/price-sources.json`. The Rails engine
  and Ruby Service default to it when the host injects no provider, matching
  `createOpenReceive`.
- The Ruby server gem gains the production FixedFloat swap provider (signed
  API client, quote/create/status/refund, rates-index math, limits caching,
  weight budgets, primary/backup failover) plus swap-address validation in the
  core gem. Providers auto-build from `LSC_URI_PRIMARY`/`LSC_URI_BACKUP`
  exactly like the Node engine, and `payment_methods` are amount-aware in both
  engines.
- Security: Ruby `payments/check` now whitelists the same public transaction
  fields as the Node engine; the preimage and full invoice never reach the
  payer. A new http-golden vector pins the settled check body in both engines.
- Wire parity: known-path/wrong-method returns 405, unrecognized persistence
  failures return 503 `INTERNAL` retryable, a host-resolved order without an
  amount returns 500, payer input is validated before host hooks run, and the
  rate limiter buckets IPv6 clients by /64 (with IPv4-mapped unwrap) in both
  engines. The OpenAPI document now declares 405/500 on every route.

### Packaging and release

- npm: every public package now carries `publishConfig.access: "public"`, a
  `prepack` build, and full registry metadata (description, keywords, author,
  bugs, engines, sideEffects). The umbrella package no longer exports
  `openreceive/testkit` (the testkit is internal), and the package graph
  validator now rejects public packages with private peer dependencies.
- RubyGems: the gems build again (the core gemspec no longer loads the full
  library), release in lockstep with the workspace version (synced by
  `release:prepare`, enforced by `check:release`), and ship LICENSE and
  per-gem CHANGELOGs. Each gem dir gains a Gemfile and Rakefile; new
  `release:gem:plan/build/publish` scripts and a CI `gem build` on Ruby
  3.2/3.4 cover the RubyGems track, and `release:stamp` dates changelog
  headings at release time.

### Rate limiting

- Opt-in per-IP invoice rate limiting (`rateLimiting` in JS,
  `config.rate_limiting` in Rails): caps invoice creation per client IP per
  rolling hour, counted from the `openreceive_payments` rows the host already
  stores. Counting is repository-backed only (no in-memory fallback) and the
  limit applies only when a new attempt would be minted — re-fetching an
  already-committed attempt is never throttled.
- Schema change: `openreceive_payments` gains a nullable `client_ip` column
  with a `(client_ip, updated_at)` index (Rails: `(client_ip, created_at)` —
  its `created_at` is locally clocked). Over-limit requests return
  `429 RATE_LIMITED` with `retryable: true` and a `Retry-After` header, in
  both engines.

### Library-owned payment attempts

- OpenReceive now owns the `openreceive_payments` logic inside the host's
  existing database. The host passes a database handle (pg Pool/Client,
  `node:sqlite`, better-sqlite3, or a custom `{dialect, query, transaction}`
  adapter); the library owns the schema, per-order commit locking, write-once
  settlement, and the reconciliation state machine. It still never owns orders,
  users, prices, or fulfillment, and never requires a separate database or
  Redis.
- Simplified host contract: `authorize` plus
  `createOpenReceiveHost({ db, loadOrder, amountForOrder, onPaid })`. `onPaid`
  runs inside the settlement transaction, only for the order's first settled
  attempt, with a transactional `query` for the order update or an outbox row.
- Rails mirrors this: an engine-owned `OpenReceivePayment` model,
  `openreceive:install` emitting migration + simplified initializer
  (`authorize`, `load_order`, `amount_for_order`, `on_paid`) + route mount, and
  a shipped `OpenReceive::ReconcileJob` / `openreceive:reconcile` rake task.
- A custom `OpenReceivePaymentRepository` remains as a documented advanced
  escape hatch, not the quickstart.
- `npx openreceive scaffold payments` now emits only a migration/schema file
  for the chosen ORM plus a wiring guide — no more generated repositories,
  mark-paid logic, or host stubs. `openReceivePaymentsSchemaSql(dialect)`
  returns the canonical DDL.

### Attempt state machine and settlement

- Every attempt carries `status`
  (`pending | settled | expired | failed | attention`) plus `status_reason`.
- Only `pending` attempts are reconciled, keeping the batched
  `list_transactions` scan window bounded to roughly the active invoice window;
  expired rows are no longer reconciled forever, and per-invoice lookups are
  still never used.
- Closing an unpaid attempt requires a successful wallet scan at or after
  expiry plus the 900-second grace
  (`OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS`); a local clock alone never
  closes a row. Vectors: `spec/test-vectors/attempt-reconciliation.json`.
- `attention` now requires the wallet's explicit in-flight claim (transaction
  `state`/`transaction_state` of `pending` or `accepted`) after expiry plus
  grace; a post-grace transaction with no finality signal closes as `expired`
  (`no_finality_after_expiry`) instead of flagging every abandoned checkout on
  wallets that never set NIP-47 state fields.
- Settled rows are never overwritten; a duplicate sibling settlement is
  recorded with `status_reason = 'duplicate_settlement'` and never fulfills
  twice. An order has one live payment session with at most one live attempt
  per rail/asset; the host only ever sees unpaid or paid.
- Preimages alone are not settlement authority; every settlement path applies
  the same finality rule (`settled_at` or a settled transaction state).
- Checkout creation now fails closed when the wallet does not honor the
  requested invoice expiry (beyond a small tolerance), so an attempt's
  reconciliation window always matches its real payable window.
- Opt-in NWC-02 notification listeners: Node
  `startOpenReceiveNotificationListener({ service, host })` (over the new
  `service.subscribeWalletNotifications`) and the Rails
  `openreceive:notifications` rake task. NWC notifications are authenticated
  wallet data: a settled `payment_received` payload settles the matching
  pending attempt directly over that channel — under the same finality rule as
  scans (`settled_at` or a settled transaction state; never a preimage alone)
  — with no redundant wallet scan for that invoice. A payload without a
  finality signal or with an unknown payment hash only wakes a bounded
  reconciliation scan, and the poll loop remains the safety net for
  notifications missed while offline. Direct settlement assumes the NWC client
  binds notification decryption to the connection's wallet pubkey (the bundled
  SDK does).
- Removed: `listUnsettledAttempts`, `OpenReceiveHostRepository`, and the
  generated payments-repository/mark-paid/host-stub files.

### Wallet preflight

- NWC preflight now fails closed when the wallet advertises spend methods such
  as `pay_invoice`. Booting anyway requires the explicit
  `allowSpendCapableWallet: true` / `config.allow_spend_capable_wallet` /
  `OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=true` override.

### HTTP and security

- Mounted routes implement `spec/openapi/openreceive-http.v1.yaml`.
- The host authorizes each request and resolves prices from host-owned order
  data; payer-supplied amounts are rejected.
- OpenReceive mints no authentication, recovery, or refund tokens.
- Receive-only NWC and swap-provider credentials remain server-only and are
  excluded from public APIs and logs.

### Developer experience

- The Node quickstart has one service, one host integration, and one framework
  adapter — and no reconciliation startup call: settlement rides the mounted
  routes through the durable gate.
- Removed superseded API aliases, historical response-shape normalization, and
  repository scratch documents.

### Release posture

- Hosted demo deployment templates and public demo deployment docs remain
  outside this public repository.
- The deterministic internal testkit remains private and non-payable.
- Release gates retain package, cross-language, secret, and bundle checks plus
  workflow safety validation.
