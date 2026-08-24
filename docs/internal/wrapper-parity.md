# Wrapper Parity

The four framework wrappers wrap the same checkout. This page is the conformance
table they are held to: one concept, one name, one default, everywhere.
`tests/wrapper-parity.test.mjs` enforces it against the shipped source.

- `@openreceive/react` renders the checkout itself in React.
- `@openreceive/vue`, `@openreceive/svelte`, `@openreceive/angular` mount the
  `<openreceive-checkout>` custom element through the shared binding in
  `packages/js/elements/src/wrapper-shared.ts`.

Naming rule: the element wrappers' names and defaults are canonical, and React
matches them. React keeps extra props only where React can do something the
element cannot (component slots, class-name slots, render-prop children).

## Props

| Prop | Default | React | Vue / Svelte / Angular | Mode |
| --- | --- | --- | --- | --- |
| `checkout` | – | yes | yes | snapshot |
| `reference` | – | yes | yes | create |
| `prefix` | `/openreceive` | yes | yes | both |
| `paymentWizard` | `true` | yes | yes | both |
| `decodeLinkUrl` | – (no decode link) | yes | yes | both |
| `themeToggle` | `true` | yes | yes | both |
| `defaultTheme` | `system` | yes | yes | both |
| `storageKey` | `openreceive.theme` | yes | yes | both |
| `metadata` | – | yes | yes | **create only** |
| `syncUrl` | `false` | yes | yes | **create only** |
| `resumePathPrefix` | `/checkout` | yes | yes | **create only** |
| `routeReference` | – | yes | yes | **create only** |
| `polling` / `pollIntervalMs` | on / engine default | yes | via `options` | both |
| `createFetch` | `globalThis.fetch` | yes | element-owned | create |
| `qrEncoder`, `logger` | – | yes | element-owned | both |
| `components`, `classNames`, `children` | – | yes | not representable | both |
| `options` | `{}` | – (props are flat) | yes (escape hatch for the rest of `CheckoutShellOptions`) | both |

`prefix` is the ONLY URL prop, in all four wrappers (G5). The create, prepare,
payment-check and four swap routes are all derived from it by one function
(`checkoutRoutes`, `packages/js/browser/src/internal/routes.ts`), so a
checkout cannot be created against one mount and settled against another. There
used to be five more ways to say the same thing — `checkoutUrl` (string or
`(orderId) => string`), `{orderId}` / `{order_id}` templating, and an `orderUrl`
prop / `order-url` attribute that was really the mounted `/payments/check`
route — and all of them are gone. (Those names are historical: they describe
removed syntax from before the `order_id` → `reference` rename, so they are
deliberately NOT renamed here.) To turn polling off, pass `polling={false}`
(React) or `polling="false"` (the element); to drop swaps, pass
`paymentWizard={false}`.

On the element itself the polling knobs are the `polling` / `poll-interval-ms`
attributes: `polling="false"` renders the snapshot (countdown included)
without ever POSTing `/payments/check`, matching React's `polling` prop;
`poll-interval-ms` tunes the interval. The element wrappers thread them
through the `options` escape hatch onto exactly those attributes.

Mode rules:

- Exactly one of `checkout` (snapshot) or `reference` (create) is required. Passing
  neither raises one clear boundary error naming the framework and the missing prop —
  not the shared factory's bare `TypeError`. All four call the same
  `validateCheckoutProps`, React included (it dispatches on the result in
  `<Checkout>` itself). Where it surfaces follows each framework's prop plumbing: Vue
  validates inside its `computed` shell binding and Svelte inside its reactive
  statement, so the throw does come out of that read; Angular validates in
  `ngOnChanges` — once per input change, never once per change-detection pass. A
  `reference` of `""` counts as absent and is rejected the same way.
- The create-only props do nothing in snapshot mode. Each wrapper warns once when
  one is passed with a `checkout` present.
- `themeToggle: false` means the host owns theming: no package toggle is rendered
  and no `data-theme` is stamped. React additionally treats an ancestor
  `ThemeScope` as the owner, because the scope already renders a page toggle.

## Where the prop list lives

One declaration, in `packages/js/browser/src/internal/checkout-props.ts`
(`CheckoutComponentProps`). The browser package is the floor React and
the element wrappers share; `@openreceive/elements` composes the wrapper flavour
(`WrapperCheckoutComponentProps` = the shared props + the element's
event handlers + the `options` escape hatch) and re-exports it.

| Package | How it gets the props |
| --- | --- |
| `@openreceive/react` | derived: `CheckoutProps extends CheckoutComponentProps` plus the React-only slots |
| `@openreceive/vue` | derived: `defineProps<WrapperCheckoutComponentProps>()`, with `withDefaults` for the defaults a type cannot carry |
| `@openreceive/svelte` | restated: `export let` (and `let { … } = $props()` under runes) is a declaration, not a type — every prop name has to be written |
| `@openreceive/angular` | restated: `@Input()` is a decorator on a declared field; a type cannot generate fields |

The two restatements are forced by those frameworks, not neglect. That is the
whole reason `tests/wrapper-parity.test.mjs` still exists: it holds the Svelte and
Angular lists to the table above, and holds React and Vue to *deriving* rather
than quietly growing a fourth copy.

Deriving the Vue props means the shipped SFC's `defineProps` type is imported, so
the consuming toolchain must be able to resolve types across packages —
`@vue/compiler-sfc` does that with TypeScript's resolver, which is why
`@openreceive/vue` declares `typescript` as an OPTIONAL peer: a JavaScript-only
Vue app needs nothing, and a TypeScript one is told what resolves the imported
prop type. An unresolvable type is a loud compile error, never a silently
dropped prop.

## Where the create-mode flow lives

The deferred Lightning mint and the swap start are ONE implementation, in
`packages/js/browser/src/internal/checkout-session.ts`
(`createCheckoutSession`). React and the custom element each wrap that
session; nothing about the decision is written twice.

| Host | How it wraps the session |
| --- | --- |
| `@openreceive/elements` | `createElementCheckoutSession` keeps the element-only duties (prepare-once bookkeeping, the "these attributes are ours" guard) and delegates the mint and the swap start |
| `@openreceive/react` | `useCheckoutSession` holds one session per component: `CheckoutCreate` wires the mint (it owns the snapshot), `PaymentWizard` wires the swap (it owns the pay-in selection), and `onRequestLightning` connects them |

Only two things stay per-host, as injected callbacks, because they are the real
difference between a custom element and a React tree:

- **Publishing.** `onSnapshot` (a new Lightning snapshot) and `onSwapStarted` (a
  freshly started swap attempt). The element writes attributes it owns, rebuilds
  its shadow tree and re-keys the poll controller; React calls `setState` and
  hands the attempt up to whichever component owns the snapshot.
- **Error surfacing.** `onError`, plus the `wizardError` / `swapStartError`
  strings the session holds for whichever host renders them inline.

### The quote step

`startSwap` QUOTES the pay-in asset before it starts (`POST /swaps/quote`), and
starts only when the quote confirms the amount is in range. This lives in the
shared session, not in either wrapper: React used to quote in its own
`useCallback` and the element started directly, so the same out-of-range amount
was an accepted-range panel in React and a generic swap-start error in the
element.

An unavailable quote lands in `session.swapQuotes[payInAsset]` and both hosts
render it through one model, `createSwapUnavailableModel` in
`@openreceive/browser` — same title, same detail, same accepted range, same
hint. React renders it as `renderSwapUnavailable`; the element renders it as
`renderElementSwapUnavailableHtml`. Neither owns the copy.

Two of the session's six fields gate a request — `mintingLightning` and
`startingSwapAsset`, both read in return-early conditions, both covering only the
window while the request is in flight. The already-completed window is guarded off
state that outlives the request: `ensureLightning` reuses a bolt11 with time left
on it, and `startSwap` re-shows an asset's deposit instructions instead of starting
a second attempt. The remaining three decide nothing about requests: `wizardError`
and `swapStartError` are the payer-facing strings the catch paths set,
`lightningRequested` is a render flag, and `swapQuotes` is the quote cache above.

Both renderers are held to all four gates, in `tests/element-lifecycle.test.mjs`
and `tests/react-checkout-behavior.test.mjs`. The in-flight pair: a second Bitcoin
selection during a mint POSTs `/checkouts` once, and a second swap start POSTs
`/swaps` once. The already-completed pair: re-selecting Bitcoin once the mint has
landed POSTs nothing at all, and neither does re-selecting a swap asset whose
deposit address the payer is already holding. React's wizard has a gate of its own
in front of that last one — its auto-start effect skips an asset it can already see
an attempt for — so React's DOM test pins the two together and a session probe
("the session refuses a second start for an asset it already holds instructions
for") pins the shared branch on its own.

## Events

Every wrapper exposes all seven, as first-class props. React passes framework
values; the element wrappers pass the DOM `CustomEvent` for the named element event.

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

[^open-wallet]: Fires only from host-supplied UI. No shipped renderer emits an
    open-wallet affordance — React's is the opt-in `OpenWalletButton` slot, and
    the element has no built-in one, so a host that wants this event renders its
    own control and calls `openWallet` (or, on the element, dispatches the event
    itself). The element used to carry a click handler for a `part="open"`
    button no renderer produced; it was deleted rather than left as a promise
    the element could not keep.

## Server rendering

No wrapper reads `localStorage` or `matchMedia` during its first render: the
server and the first client render resolve the theme from `defaultTheme`, and the
stored preference is applied after mount. React does this with
`useSyncExternalStore`; the element wrappers pass `deferThemeResolution` to the
shared shell binding until they are mounted. A host-supplied `storage` is read on
the server too, since that is the documented way to server-render a chosen theme.

## Hook surface (React only)

`useCheckout` drives a concrete snapshot and takes no create options: create mode
belongs to `<Checkout>`. It accepts `checkout`, `clipboard`, `open`, `logger`,
`refreshStatus`, `prefix`, `polling`, `pollIntervalMs`, and the `onCopy`,
`onOpenWallet`, `onState`, `onSettled`, `onError` handlers.
