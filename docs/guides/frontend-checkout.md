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

- [`prepareCheckout(options)`](api-reference.md#preparecheckout) — lock the
  amount without minting. Options: `reference`, `prefix`, `fetch?`, `headers?`.
- [`requestCheckout(options)`](api-reference.md#requestcheckout) — mint the
  Lightning invoice. Same options, plus `memo?` and `metadata?`: those two ride
  on the create request, which is why prepare does not take them.
- [`<Checkout>`](api-reference.md#checkout) props — `reference` (create mode) or `checkout` (snapshot mode), `prefix`,
  the seven handlers (`onCopy`, `onOpenWallet`, `onState`, `onSettled`,
  `onProviderCopy`, `onStartOver`, `onError`), `polling`, `pollIntervalMs`, `paymentWizard`,
  `themeToggle` (default `true`), `defaultTheme`, `storageKey`, `decodeLinkUrl`,
  `assetBaseUrl`, `components`, `classNames`, `children`, `syncUrl`,
  `resumePathPrefix`, `routeReference`, `resumable`, `resumePaymentHash`,
  `metadata`, `createFetch`,
  `resolveAssetUrl`. `resumable` says whether a payer who closes the tab has a
  URL that brings them back; it is inferred from `syncUrl` / `routeReference`,
  and set explicitly when your own router owns a per-order route the component
  cannot see. It decides one thing — which return warning the swap refund screen
  shows — and that one thing is what stands between a stranded deposit and a
  recoverable one. See
  [Checkout UX → The refund screens](checkout-ux.md#the-refund-screens). The
  prop declares the URL; restoring the ORDER behind it stays host work.
- `resumePaymentHash` is how the ATTEMPT comes back. `/checkouts/prepare`
  carries none, so without it a bookmarked checkout opens on the method grid —
  the wrong screen for a payer who was told to return and claim a refund. Give
  it the `payment_hash` your application stored beside the order and the deposit
  (or its refund screen) reopens; a hash the server will not serve is ignored.
  `onState` is where the hash comes from. See
  [Swap refunds](swap-refunds.md).
  The shared names and defaults hold for the Vue, Svelte and Angular wrappers,
  which mount the same custom element. Four of these are React-only:
  `components`, `classNames`, `children` (see below) and `createFetch`;
  `resolveAssetUrl` is a function, so it cannot cross an HTML attribute — the
  wrappers take `assetBaseUrl` instead; and `polling`/`pollIntervalMs` ride the
  `options` escape hatch there.
- [`useCheckout(options)`](api-reference.md#usecheckout) — the hook behind `<Checkout>` for custom layouts; returns the live
  snapshot, status/countdown labels, and `copyInvoice`/`openWallet`/`retry` actions.
  Two notes on that list, both of which bite people building chrome around the
  component:
  - `openWallet` is for **touch devices**. Its default path navigates the
    current window, so a wallet button on a desktop is either inert or sends the
    payer off a still-polling checkout. The shipped checkout draws no wallet
    button for that reason. See
    [Headless checkout](headless-checkout.md#the-openreceivebrowserheadless-surface).
  - the status labels are a **status, not a position**. There is no step index
    here and a linear stepper cannot express what the engine reports — see
    [Progress is a status, not a position](headless-checkout.md#progress-is-a-status-not-a-position)
    before you add one around `<Checkout>`. That is where steppers actually get
    added in practice: outside the component, by someone who never opens the
    headless guide.
  - any payer-facing string you need for your own layout is already in
    `checkoutLabels`, exported from `@openreceive/browser/headless` — the copy,
    network and breadcrumb wording the shipped renderers emit. Read it before
    you write your own, so a custom layout and the drop-in do not say different
    things for the same control.

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

## Show the payer what they are buying

The shipped checkout renders the amount, never the order — it cannot, because
OpenReceive owns no line items. A `$1.00` total, a QR code, and no sign of what
is being bought is a real conversion problem, and every drop-in integrator has
it by default.

**The one-line fix is on the server.** Return a `description` beside the price
from the hook you already write, and both drop-ins render it above the amount,
on every screen — the Lightning pane, the swap deposit panel, the expired pane
and the receipt:

```ts
amountFor: async (reference) => {
  const order = await orders.find(reference);
  if (order === null) return null;
  return {
    currency: "USD",
    value: order.total,
    description: `${order.lines.length} items from the shop`,
  };
},
```

```ruby
config.amount_for = lambda do |reference|
  order = Order.find_by(id: reference)
  order && { currency: "USD", value: order.total.to_s,
             description: "#{order.line_items.size} items from the shop" }
end
```

It is ONE display string, deliberately: a line-item schema would make
OpenReceive own the order, which is the thing it never does. It rides the
prepare and create responses only — never a request body, because the payer does
not get to write the copy next to the amount.

**For anything richer, the host supplies markup.** React takes `children`, which
accepts a node or a **render prop** receiving the live `useCheckout` model:

```tsx
<Checkout reference={order.id} prefix="/openreceive">
  {(model) => (
    <ul className="order-lines">
      {cart.lines.map((line) => (
        <li key={line.id}>
          <img src={line.thumbnail} alt="" />
          {line.quantity} × {line.name}
        </li>
      ))}
    </ul>
  )}
</Checkout>
```

The custom element has the same affordance as a named slot. Put your markup
inside the tag with `slot="order"` and the element projects it into its shadow
root, above the amount — and because it is a slot, it survives every re-render
of the shell untouched:

```html
<openreceive-checkout reference="ord_123" prefix="/openreceive">
  <ul slot="order" class="order-lines">
    <li><img src="/mango.jpg" alt=""> 2 kg Ataulfo mangoes</li>
  </ul>
</openreceive-checkout>
```

A headless UI owns the whole screen and has no excuse at all.

## Showing the payer their receipt

`<TransactionDetails>` (and `renderTransactionDetailsHtml` /
`createTransactionDetailsElement` in `@openreceive/elements`) is the collapsible
panel of payment hash, deposit txid, amounts and explorer links that
`<Checkout>` renders on settlement and inside the swap flow. It is also
**mountable on its own**, outside `<Checkout>` — pass it rows or a checkout
state and put it on your order page, which is where a payer goes looking for the
receipt days later:

```tsx
<TransactionDetails state={await loadCheckoutState(order.id)} />
```

Why it matters, and the row contract (`copyValue` is the untruncated value; the
bolt11 decode link is opt-in), are in
[The receipt is not debug output](headless-checkout.md#the-receipt-is-not-debug-output).

## Replacing any of this

The drop-in encodes a set of payer-facing rules — no progress stepper, a network
question only where there is one to ask, a copy row for every value the payer
must retype, suggestions that say they are suggestions. Building your own UI
means owning them: [Checkout UX](checkout-ux.md) is the argument for each, and
names the display model that already carries it.
