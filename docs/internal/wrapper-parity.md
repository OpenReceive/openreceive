# Wrapper Parity

The four framework wrappers wrap the same checkout. This page is the table they
must conform to: one concept, one name, one default, everywhere.
`tests/wrapper-parity.test.mjs` checks the shipped source against it.

- `@openreceive/react` renders the checkout itself in React.
- `@openreceive/vue`, `@openreceive/svelte`, `@openreceive/angular` mount the
  `<openreceive-checkout>` custom element through the shared binding in
  `packages/js/elements/src/wrapper-shared.ts`.

Naming rule: the element wrappers' names and defaults are the reference, and
React matches them. React has extra props only where React can do something the
element cannot: component slots, class-name slots, and render-prop children.

## Props

| Prop | Default | React | Vue / Svelte / Angular | Mode |
| --- | --- | --- | --- | --- |
| `checkout` | – | yes | yes | snapshot |
| `reference` | – | yes | yes | create |
| `prefix` | `/openreceive` | yes | yes | both |
| `csrfHeader` | `X-CSRF-Token` | yes | yes | both |
| `paymentWizard` | `true` | yes | yes | both |
| `decodeLinkUrl` | – (no decode link) | yes | yes | both |
| `themeToggle` | `true` | yes | yes | both |
| `defaultTheme` | `system` | yes | yes | both |
| `storageKey` | `openreceive.theme` | yes | yes | both |
| `metadata` | – | yes | yes | **create only** |
| `syncUrl` | `false` | yes | yes | **create only** |
| `resumePathPrefix` | `/checkout` | yes | yes | **create only** |
| `routeReference` | – | yes | yes | **create only** |
| `resumePaymentHash` | – | yes | yes | **create only** |
| `resumable` | inferred from `syncUrl` / `routeReference` | yes | yes | both |
| `polling` / `pollIntervalMs` | on / engine default | yes | via `options` | both |
| `createFetch` | `globalThis.fetch` | yes | element-owned | create |
| `qrEncoder`, `logger` | – | yes | element-owned | both |
| `components`, `classNames`, `children` | – | yes | not representable | both |
| `theme` (host lock) | – (stored preference applies) | yes (React-only prop) | element `theme` attribute; wrappers don't forward it yet | both |
| `options` | `{}` | – (props are flat) | yes (escape hatch for the rest of `CheckoutShellOptions`) | both |

`prefix` is the ONLY URL prop, in all four wrappers (G5). One function,
`checkoutRoutes` (`packages/js/browser/src/internal/routes.ts`), derives every
route from it: create, prepare, payment-check, and the four swap routes. So a
checkout cannot be created against one mount and settled against another.

There used to be five more ways to say the same thing, and all of them are
gone:
- `checkoutUrl` (string or `(orderId) => string`)
- `{orderId}` / `{order_id}` templating
- an `orderUrl` prop / `order-url` attribute, which was really the mounted
  `/payments/check` route

Those names are historical. They describe syntax removed before the
`order_id` → `reference` rename, so we deliberately do NOT rename them here.

To turn polling off, pass `polling={false}` (React) or `polling="false"` (the
element). To drop swaps, pass `paymentWizard={false}`.

`csrfHeader` is the header NAME under which the checkout sends the value of the
page's `<meta name="csrf-token">`. It is sent on every request the checkout
makes: create, prepare, the status poll, and the swap routes. The meta tag name
is fixed, and the host renders the token into it. Only the header name varies
by framework:
- the default, `X-CSRF-Token`, is what Rails and Laravel read
- Django's CsrfViewMiddleware reads `X-CSRFToken`
- WordPress REST reads `X-WP-Nonce`

On the element it is the `csrf-header` attribute, and the wrappers forward the
prop onto it. A host `headers` entry for the same name still wins.

There is no image prop in any wrapper. Everything the checkout draws ships
inside the JavaScript: payment icons, wallet logos, and pay tutorials. So the
base-URL / resolver props that used to be in this table are gone from every
wrapper
([Provider registry](../guides/provider-registry.md#assets)).

On the element itself, the polling settings are the `polling` /
`poll-interval-ms` attributes. `polling="false"` renders the snapshot, countdown
included, without ever POSTing `/payments/check`. That matches React's
`polling` prop. `poll-interval-ms` sets the interval. The element wrappers pass
them through the `options` escape hatch onto exactly those attributes.

Mode rules:

- Exactly one of `checkout` (snapshot) or `reference` (create) is required.
  - If you pass neither, the wrapper raises one clear error that names the
    framework and the missing prop, instead of the shared factory's bare
    `TypeError`.
  - All four wrappers call the same `validateCheckoutProps`. That includes
    React, which acts on the result in `<Checkout>` itself.
  - Where the error appears depends on how each framework handles props. Vue
    validates inside its `computed` shell binding, and Svelte inside its
    reactive statement, so the throw comes out of that read. Angular validates
    in `ngOnChanges`: once per input change, never once per change-detection
    pass.
  - A `reference` of `""` counts as absent and is rejected the same way.
- The create-only props do nothing in snapshot mode. Each wrapper warns once when
  one is passed with a `checkout` present.
- In React, `themeToggle: false` hides the packaged toggle, but the checkout
  still stamps `data-theme`. Hiding the control must not unstyle the widget.
  - Only an ancestor `ThemeScope` takes over the stamp. The scope already owns
    `data-openreceive-theme` and renders a page toggle.
  - The checkout under a scope still mirrors the resolved `data-theme` on its
    own root. The shipped stylesheet is scoped to `data-openreceive-root` and
    paints the palette from that root, never from an ancestor outside it.
  - Every light-DOM root the packages render carries `data-openreceive-root`:
    the React `<Checkout>` and `<ThemeToggle>`, and the wrapper shell
    `<section>` (`rootAttributes`, unconditionally).
  - React's `theme` prop locks the theme outright. It wins over the stored
    preference and any scope, and it hides the toggle.
  - The element wrappers still tie both the toggle and the stamp to
    `themeToggle` (`ownTheme` in `createCheckoutShellModel`). This is a parity
    gap to close once the wrappers forward the `theme` prop.

## Where the prop list lives

The props are declared once, in
`packages/js/browser/src/internal/checkout-props.ts` (`CheckoutComponentProps`).
The browser package is the base layer that React and the element wrappers
share. `@openreceive/elements` builds the wrapper version and re-exports it.
That version is `WrapperCheckoutComponentProps`: the shared props, plus the
element's event handlers, plus the `options` escape hatch.

| Package | How it gets the props |
| --- | --- |
| `@openreceive/react` | derived: `CheckoutProps extends CheckoutComponentProps` plus the React-only slots |
| `@openreceive/vue` | derived: `defineProps<WrapperCheckoutComponentProps>()`, with `withDefaults` for the defaults a type cannot carry |
| `@openreceive/svelte` | restated: `export let` (and `let { … } = $props()` under runes) is a declaration, not a type — every prop name has to be written |
| `@openreceive/angular` | restated: `@Input()` is a decorator on a declared field; a type cannot generate fields |

Those two frameworks force the restatements. It is not neglect. That is the
whole reason `tests/wrapper-parity.test.mjs` still exists. It holds the Svelte
and Angular lists to the table above. It also holds React and Vue to *deriving*
the props, so they do not quietly grow a fourth copy.

Because Vue derives its props, the shipped SFC imports its `defineProps` type.
So the consuming toolchain must resolve types across packages.
`@vue/compiler-sfc` does that with TypeScript's resolver. That is why
`@openreceive/vue` declares `typescript` as an OPTIONAL peer. A JavaScript-only
Vue app needs nothing. A TypeScript app is told what resolves the imported prop
type. A type that cannot be resolved is a loud compile error, never a silently
dropped prop.

## Where the create-mode flow lives

The deferred Lightning mint and the swap start have ONE implementation, in
`packages/js/browser/src/internal/checkout-session.ts`
(`createCheckoutSession`). React and the custom element each wrap that
session. None of the decision logic is written twice.

| Host | How it wraps the session |
| --- | --- |
| `@openreceive/elements` | `createElementCheckoutSession` keeps the element-only duties (prepare-once bookkeeping, the "these attributes are ours" guard) and delegates the mint and the swap start |
| `@openreceive/react` | `useCheckoutSession` holds one session per component: `CheckoutCreate` wires the mint (it owns the snapshot), `PaymentWizard` wires the swap (it owns the pay-in selection), and `onRequestLightning` connects them |

Only two things differ per host, and each host injects them as callbacks.
They are the real difference between a custom element and a React tree:

- **Publishing.** `onSnapshot` (a new Lightning snapshot) and `onSwapStarted` (a
  freshly started swap attempt). The element writes attributes it owns, rebuilds
  its shadow tree and re-keys the poll controller. React calls `setState` and
  hands the attempt up to whichever component owns the snapshot.
- **Error surfacing.** `onError`, plus the `wizardError` / `swapStartError`
  strings the session holds for whichever host renders them inline.

### The quote step

`startSwap` QUOTES the pay-in asset before it starts (`POST /swaps/quote`). It
starts only when the quote confirms the amount is in range. This logic lives in
the shared session, not in either wrapper. React used to quote in its own
`useCallback` while the element started directly. So the same out-of-range
amount showed an accepted-range panel in React and a generic swap-start error in
the element.

An unavailable quote lands in `session.swapQuotes[payInAsset]`. Both hosts
render it through one model, `createSwapUnavailableModel` in
`@openreceive/browser`, with the same title, detail, accepted range and hint.
React renders it as `renderSwapUnavailable`. The element renders it as
`renderElementSwapUnavailableHtml`. Neither owns the copy.

The session has six fields.
- Two of them block duplicate requests: `mintingLightning` and
  `startingSwapAsset`. Both are read in return-early conditions, and both cover
  only the time while the request is in flight.
- After a request completes, state that outlives the request guards against a
  repeat. `ensureLightning` reuses a bolt11 that still has time left.
  `startSwap` shows an asset's deposit instructions again instead of starting a
  second attempt.
- The other four fields decide nothing about requests. `wizardError` and
  `swapStartError` are the payer-facing strings the catch paths set.
  `lightningRequested` is a render flag. `swapQuotes` is the quote cache above.

Both renderers hide the Lightning pane while the method grid is showing.
Switching payment method keeps the live bolt11 for reuse. Selecting Bitcoin
again restores the same invoice without another create request. Vue, Svelte,
and Angular inherit this behavior from the custom element.

Both renderers must pass all four gates, tested in
`tests/element-lifecycle.test.mjs` and `tests/react-checkout-behavior.test.mjs`:
- In flight: a second Bitcoin selection during a mint POSTs `/checkouts` once.
- In flight: a second swap start POSTs `/swaps` once.
- Already completed: selecting Bitcoin again after the mint has landed POSTs
  nothing at all.
- Already completed: selecting a swap asset again, when the payer already holds
  its deposit address, POSTs nothing either.

React's wizard has its own gate in front of that last one: its auto-start effect
skips an asset it can already see an attempt for. So React's DOM test covers
the two together. A separate session probe ("the session refuses a second start
for an asset it already holds instructions for") covers the shared branch on
its own.

## Events

Every wrapper exposes all seven as first-class props. React passes framework
values. The element wrappers pass the DOM `CustomEvent` for the named element
event.

| Handler | Element event | React payload |
| --- | --- | --- |
| `onCopy` | `openreceive-copy` | `()` |
| `onOpenWallet` | `openreceive-open-wallet` [^open-wallet] | `(uri: string)` |
| `onState` | `openreceive-state` | `(state: CheckoutState)` |
| `onSettled` | `openreceive-settled` | `()` |
| `onProviderCopy` | `openreceive-provider-copy` | `(providerId: string)` |
| `onStartOver` | `openreceive-start-over` | `()` |
| `onError` | `openreceive-error` | `(error: unknown)` |

`onSettled` is a UI hint. Fulfillment runs from the backend settlement hook.

[^open-wallet]: Fires only from UI the host supplies. No shipped renderer draws
    an open-wallet control. React's is the opt-in `OpenWalletButton` slot, and
    the element has no built-in one. So a host that wants this event renders its
    own control and calls `openWallet`, or, on the element, dispatches the event
    itself. The element used to have a click handler for a `part="open"`
    button that no renderer produced. We deleted it rather than leave a promise
    the element could not keep.

## Server rendering

No wrapper reads `localStorage` or `matchMedia` during its first render. The
server and the first client render take the theme from `defaultTheme`. The
stored preference is applied after mount. React does this with
`useSyncExternalStore`. The element wrappers pass `deferThemeResolution` to the
shared shell binding until they are mounted. A `storage` the host supplies is
read on the server too, because that is the documented way to server-render a
chosen theme.

## Hook surface (React only)

`useCheckout` drives an existing snapshot and takes no create options. Create
mode belongs to `<Checkout>`. It accepts `checkout`, `clipboard`, `open`, `logger`,
`refreshStatus`, `prefix`, `csrfHeader`, `polling`, `pollIntervalMs`, and the `onCopy`,
`onOpenWallet`, `onState`, `onSettled`, `onError` handlers.
