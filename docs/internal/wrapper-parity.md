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
| `orderId` | – | yes | yes | create |
| `prefix` | `/openreceive` | yes | yes | both |
| `orderUrl` | derived from `prefix` | yes (`string \| false`) | yes | both |
| `paymentWizard` | `true` | yes | yes | both |
| `decodeLinkUrl` | – (no decode link) | yes | yes | both |
| `themeToggle` | `true` | yes | yes | both |
| `defaultTheme` | `system` | yes | yes | both |
| `storageKey` | `openreceive-theme` | yes | yes | both |
| `metadata` | – | yes | yes | **create only** |
| `syncUrl` | `false` | yes | yes | **create only** |
| `resumePathPrefix` | `/checkout` | yes | yes | **create only** |
| `routeOrderId` | – | yes | yes | **create only** |
| `polling` / `pollIntervalMs` | on / engine default | yes | via `options` | both |
| `createFetch` | `globalThis.fetch` | yes | element-owned | create |
| `qrEncoder`, `logger` | – | yes | element-owned | both |
| `components`, `classNames`, `children` | – | yes | not representable | both |
| `options` | `{}` | – (props are flat) | yes (escape hatch for the rest of `CheckoutShellOptions`) | both |

Mode rules:

- Exactly one of `checkout` (snapshot) or `orderId` (create) is required. Passing
  neither is a prop error raised at the boundary — `<Checkout>` in React,
  `validateOpenReceiveWrapperCheckoutProps` in the element wrappers — never a
  `TypeError` thrown out of a computed/reactive/change-detection read.
- The create-only props do nothing in snapshot mode. Each wrapper warns once when
  one is passed with a `checkout` present.
- `themeToggle: false` means the host owns theming: no package toggle is rendered
  and no `data-theme` is stamped. React additionally treats an ancestor
  `ThemeScope` as the owner, because the scope already renders a page toggle.

## Events

Every wrapper exposes all seven, as first-class props. React passes framework
values; the element wrappers pass the DOM `CustomEvent` for the named element event.

| Handler | Element event | React payload |
| --- | --- | --- |
| `onCopy` | `openreceive-copy` | `()` |
| `onOpenWallet` | `openreceive-open-wallet` | `(uri: string)` |
| `onState` | `openreceive-state` | `(state: CheckoutState)` |
| `onSettled` | `openreceive-settled` | `()` |
| `onProviderCopy` | `openreceive-provider-copy` | `(providerId: string)` |
| `onStartOver` | `openreceive-start-over` | `()` |
| `onError` | `openreceive-error` | `(error: unknown)` |

`onSettled` is a UI hint. Fulfillment runs from the backend settlement hook.

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
`refreshStatus`, `orderUrl`, `polling`, `pollIntervalMs`, and the `onCopy`,
`onOpenWallet`, `onState`, `onSettled`, `onError` handlers.
