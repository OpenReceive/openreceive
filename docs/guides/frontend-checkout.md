# Frontend checkout

The browser never receives NWC, provider credentials, or `swap_data`, and never chooses the charged amount.
Create the order through your own application route, then pass its ID to the UI:

```tsx
const order = await createMyOrder(cart);
return <Checkout reference={order.id} prefix="/openreceive" />;
```

The default `<Checkout reference>` flow is prepare-then-mint. Every `POST` path below is an
OpenReceive route, shipped by the server package and mounted under `prefix`; your app defines
only the order-creation route above and the authorization these requests pass through.

- **On mount** the component calls [`prepareCheckout({ reference, prefix })`](api-reference.md#preparecheckout)
  (POST `/checkouts/prepare`). This locks the server-resolved amount and returns the
  available payment methods — no Lightning invoice is minted yet.
- **When the payer selects Bitcoin** the component calls
  [`requestCheckout({ reference, prefix })`](api-reference.md#requestcheckout) (POST `/checkouts`) to mint (or reuse) a bolt11.
  The host resolves the price and commits its payment-attempt row before the browser
  receives the invoice.
- **When the payer selects a swap asset** the component starts a swap (POST `/swaps`)
  instead.
- **Every later payment/swap request** sends the same reference ID plus the displayed
  `payment_hash` and relies on your normal authorization.

Browser & React API surface (full reference in
[api-reference.md → Browser & React](api-reference.md#browser--react)):

- [`prepareCheckout(options)`](api-reference.md#preparecheckout) / [`requestCheckout(options)`](api-reference.md#requestcheckout) — direct calls when you build your
  own UI. Options: `reference`, `prefix`, `fetch`, `headers`, `memo`, `metadata`.
- [`<Checkout>`](api-reference.md#checkout) props — `reference` (create mode) or `checkout` (snapshot mode), `prefix`,
  the seven handlers (`onCopy`, `onOpenWallet`, `onState`, `onSettled`,
  `onProviderCopy`, `onStartOver`, `onError`), `polling`, `pollIntervalMs`, `paymentWizard`,
  `themeToggle` (default `true`), `defaultTheme`, `storageKey`, `decodeLinkUrl`,
  `components`, `classNames`, `syncUrl`,
  `resumePathPrefix`, `routeReference`, `metadata`, `createFetch`. The same names and defaults
  hold for the Vue, Svelte and Angular wrappers, which mount the same custom element
  (`polling`/`pollIntervalMs` ride the `options` escape hatch there).
- [`useCheckout(options)`](api-reference.md#usecheckout) — the hook behind `<Checkout>` for custom layouts; returns the live
  snapshot, status/countdown labels, and `copyInvoice`/`openWallet`/`retry` actions.

`prefix` is the base path your app mounted the shipped OpenReceive router at —
`/openreceive` in the example above. It is the only URL input the browser packages take:
every route they call is `prefix` plus a fixed path (`/checkouts`, `/checkouts/prepare`,
`/payments/check`, `/swaps`, `/swaps/quote`, `/swaps/status`, `/swaps/refunds`), so the
component above posts to `/openreceive/checkouts/prepare`. Because every URL is derived
from the one `prefix`, there is nothing to keep in step and no way to point create and
settle at different mounts. Pass `polling={false}` to render a snapshot without polling.

You choose this path on the server, where the router is mounted: the adapter option
(`openReceiveExpress({ prefix })`, `fastify.register(openReceiveFastify, { prefix })`, the
catch-all route folder in Next) or the Rails engine mount
(`mount OpenReceive::Engine => "/openreceive"`) — see
[api-reference.md → Framework adapters](api-reference.md#framework-adapters). Give the
browser the full path as it sees it: if the router sits inside another mount —
`app.use("/api", openReceiveExpress(...))` with the default prefix — the browser's `prefix`
is `/api/openreceive`, not `/openreceive`.

Order summaries and resume pages are your concern; fetch them from your application API, not
from OpenReceive. Status polling posts `{ reference, payment_hash }` to `/payments/check`; the
host verifies that exact attempt belongs to the reference.
