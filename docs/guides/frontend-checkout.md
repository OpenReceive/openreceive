# Frontend checkout

The browser never receives NWC, provider credentials, or `swap_data`, and never chooses the charged amount.
Create the order through your own application route, then pass its ID to the UI:

```tsx
const order = await createMyOrder(cart);
return <Checkout reference={order.id} prefix="/openreceive" />;
```

The default `<Checkout reference>` flow is prepare-then-mint: on mount the component calls
`prepareCheckout({ reference, prefix })` (POST `/checkouts/prepare`), which locks the
server-resolved amount and returns the payment methods — no Lightning invoice is minted yet.
Only when the payer selects Bitcoin does the component call
`requestCheckout({ reference, prefix })` (POST `/checkouts`) to mint (or reuse) a bolt11; the
host resolves the price and commits its payment-attempt row before the browser receives
the invoice. Selecting a swap asset instead starts a swap (POST `/swaps`). Later payment/swap
requests send the same reference ID plus the displayed `payment_hash` and rely on your
normal authorization.

Browser & React API surface (full reference in
[api-reference.md → Browser & React](api-reference.md#browser--react)):

- `prepareCheckout(options)` / `requestCheckout(options)` — direct calls when you build your
  own UI. Options: `reference`, `prefix`, `fetch`, `headers`, `memo`, `metadata`.
- `<Checkout>` props — `reference` (create mode) or `checkout` (snapshot mode), `prefix`,
  the seven handlers (`onCopy`, `onOpenWallet`, `onState`, `onSettled`,
  `onProviderCopy`, `onStartOver`, `onError`), `polling`, `pollIntervalMs`, `paymentWizard`,
  `themeToggle` (default `true`), `defaultTheme`, `storageKey`, `decodeLinkUrl`,
  `components`, `classNames`, `syncUrl`,
  `resumePathPrefix`, `routeReference`, `metadata`, `createFetch`. The same names and defaults
  hold for the Vue, Svelte and Angular wrappers, which mount the same custom element
  (`polling`/`pollIntervalMs` ride the `options` escape hatch there).
- `useCheckout(options)` — the hook behind `<Checkout>` for custom layouts; returns the live
  snapshot, status/countdown labels, and `copyInvoice`/`openWallet`/`retry` actions.

`prefix` is the only URL the browser packages take. Every route — `/checkouts`,
`/checkouts/prepare`, `/payments/check`, `/swaps`, `/swaps/quote`,
`/swaps/status`, `/swaps/refunds` — is derived from it, so there is nothing to
keep in step and no way to point create and settle at different mounts. Pass
`polling={false}` to render a snapshot without polling.

Order summaries and resume pages are your concern; fetch them from your application API, not
from OpenReceive. Status polling posts `{ reference, payment_hash }` to `/payments/check`; the
host verifies that exact attempt belongs to the reference.
