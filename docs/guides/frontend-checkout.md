# Frontend checkout

Create the order on your own server, then pass its id to the UI. The browser
never receives NWC, provider credentials, or `swap_data`, and never chooses
the charged amount.

```tsx
const order = await createMyOrder(cart);
return <Checkout reference={order.id} prefix="/openreceive" />;
```

`<Checkout>` talks to the OpenReceive routes you already mounted under
`prefix`. Your app owns the order-creation route and the authorization those
requests pass through.

1. **On mount** it calls `prepareCheckout` (POST `/checkouts/prepare`). That
   locks the amount and returns the payment methods. No Lightning invoice yet.
2. **Bitcoin** calls `requestCheckout` (POST `/checkouts`) to mint or reuse a
   bolt11.
3. **A swap asset** starts a swap (POST `/swaps`) instead.
4. **Later status and swap calls** send the same reference plus the
   `payment_hash`. Your `authorize` hook still runs.

`prefix` is the path you mounted the router at — `/openreceive` in the
example. Every browser URL is `prefix` plus a fixed path, so there is nothing
to keep in step. If the router sits inside another mount
(`app.use("/api", openReceiveExpress(...))`), pass `/api/openreceive`.

Pass `polling={false}` to render a snapshot without polling.

Order summaries and resume pages come from your application API, not from
OpenReceive.

## Props that matter

Full list: [API reference → Browser & React](api-reference.md#browser--react).

- `reference` — create mode (the usual path). Or pass `checkout` for a
  snapshot you already loaded.
- `prefix` — the mount path, as the browser sees it.
- `onSettled`, `onError`, `onState` — settlement, failures, and every
  attempt the checkout watches. Store a swap `payment_hash` from `onState`
  if you want the payer to return to a refund later.
- `resumable` — whether a closed tab has a URL that brings the payer back.
  Inferred from `syncUrl` / `routeReference`; set it yourself when your
  router owns a per-order path the component cannot see. It chooses the
  refund-screen warning. See [Checkout UX → The refund screens](checkout-ux.md#the-refund-screens).
- `resumePaymentHash` — reopen that attempt after prepare, instead of the
  method grid. `/checkouts/prepare` returns no attempts. A hash the server
  will not serve is ignored. See [Swap refunds](swap-refunds.md).
- `assetBaseUrl` — where you serve `@openreceive/provider-data`'s wallet
  logos and pay tutorials. Required under most bundlers that are not Vite.
  The payment-method icons are compiled in and need nothing. See
  [Provider registry](provider-registry.md#assets).
- `theme`, `themeToggle`, `defaultTheme`, `children`, `components`,
  `classNames` — chrome; see [Theme](#theme) below. `children` and
  `components` / `classNames` are React-only. Vue, Svelte, and Angular wrap
  the same custom element; they take `assetBaseUrl` instead of
  `resolveAssetUrl`.

`useCheckout` is the hook behind `<Checkout>` if you want the same engine
with your own layout. It returns the live snapshot, status labels, and
`copyInvoice` / `openWallet` / `retry`. Use `openWallet` on touch devices
only. Use `checkoutLabels` for any string you put on the screen.

Importing `@openreceive/react` plus its `styles.css` adds roughly 530 kB
minified (~150 kB gzipped) to a production chunk. If that matters on the rest
of your site, lazy-load the checkout route so only payers download it.

## Theme

The checkout stamps `data-theme="light"` / `"dark"` on its root and styles
itself from CSS variables under it. Resolution order: the payer's stored
choice (`localStorage["openreceive.theme"]`), then `defaultTheme`, then the
system `prefers-color-scheme`.

The stylesheet never reaches past that root: every rule in `styles.css` is
scoped to `data-openreceive-root`, which the checkout, the theme toggle and
the wrapper shell stamp on themselves. Your page keeps its own resets,
headings, buttons and theme variables whatever order the sheets load in.

If the embedding page is always one theme, lock it and skip all of that:

```tsx
<Checkout reference={order.id} prefix="/openreceive" theme="dark" />
```

```html
<openreceive-checkout reference="ord_123" theme="dark"></openreceive-checkout>
```

The lock wins over the stored preference and any ancestor `ThemeScope`, and
hides the toggle — a locked theme has nothing to toggle. `theme="system"`
locks to `prefers-color-scheme` alone.

`themeToggle={false}` hides the packaged toggle button but the checkout still
stamps and styles its resolved theme. `defaultTheme` is the starting point
only until the payer makes a choice; use `theme` when the host, not the
payer, owns the decision. Server-rendered pages paint the default before the
stored preference applies on mount — a host that must avoid that one-frame
flash passes `theme` or a server-readable `storage`. The "Creating checkout…"
and "Could not start checkout." screens that precede a created checkout carry
the same resolved theme.

## Layout and surface

The checkout lays itself out by its **own width**, not the viewport's. Its
root is a CSS size query container (`container-type: inline-size`, named
`openreceive`), and every internal breakpoint is a container query at the
usual values — one column of payment methods under 40rem of checkout width,
two from 40rem, three from 48rem, four from 64rem; the two-column wallet list
from 48rem. A checkout mounted in a 560px card on a 1280px page lays out like
a 560px screen. The one thing this asks of the host: give the root a width.
It is a block-level element, so any normal container does; as a flex or grid
item, add `flex: 1` / `width: 100%` — an inline-size container cannot size
itself from its contents. Container queries and `cqw` units have been in every
browser since 2023.

The root paints the theme's `base-100` surface and pads and rounds itself
(`p-4`, `rounded-box`). A host that draws its own card around the checkout
and wants no second surface sets `--root-bg: transparent` on
`[data-openreceive-root]`; a host that wants a tighter or looser inset
overrides `padding` there. Both work because every rule in the shipped
stylesheet is wrapped in `:where()` and carries **zero specificity**: a
host's own selector, however plain, wins on the same property. That is a
compatibility promise, not an accident.

## Show the payer what they are buying

Return a `description` beside the price. Both drop-ins print it above the
amount on every screen:

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

One display string. It rides the prepare and create responses only — never
a request body.

For a richer summary, pass markup. React takes `children` as a node or a
render prop:

```tsx
<Checkout reference={order.id} prefix="/openreceive">
  {(model) => (
    <ul className="order-lines">
      {cart.lines.map((line) => (
        <li key={line.id}>
          {line.quantity} × {line.name}
        </li>
      ))}
    </ul>
  )}
</Checkout>
```

Children compose: they render above the shipped payment UI (the same position
as the custom element's `order` slot) and never replace it. To build your own
checkout instead, use `useCheckout` or the headless API — not `children`.

The custom element uses a named slot:

```html
<openreceive-checkout reference="ord_123" prefix="/openreceive">
  <ul slot="order" class="order-lines">
    <li>2 kg Ataulfo mangoes</li>
  </ul>
</openreceive-checkout>
```

## Showing the payer their receipt

`<TransactionDetails>` (and `renderTransactionDetailsHtml` /
`createTransactionDetailsElement` in `@openreceive/elements`) is the
collapsible payment-hash / deposit-txid panel. `<Checkout>` already renders
it. You can also mount it on your order page:

```tsx
<TransactionDetails state={await loadCheckoutState(order.id)} />
```

## Building your own UI

The drop-in already follows the payer-facing rules. If you replace it, you
own those rules: [Checkout UX](checkout-ux.md) is the short list, and
[Headless checkout](headless-checkout.md) is the API.
