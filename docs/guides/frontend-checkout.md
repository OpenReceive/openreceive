# Frontend checkout

Create the order on your own server, then pass its id to the UI. The browser
never receives NWC, provider credentials, or `swap_data`. It never chooses the
charged amount either.

```tsx
const order = await createMyOrder(cart);
return <Checkout reference={order.id} prefix="/openreceive" />;
```

`<Checkout>` talks to the OpenReceive routes you already mounted under
`prefix`. Your app owns the order-creation route. It also owns the
authorization that those requests pass through.

1. **On mount** it calls `prepareCheckout` (POST `/checkouts/prepare`). That
   locks the amount and returns the payment methods. It does not create a
   Lightning invoice yet.
2. **Bitcoin** calls `requestCheckout` (POST `/checkouts`) to mint or reuse a
   bolt11.
3. **A swap asset** starts a swap (POST `/swaps`) instead.
4. **Later status and swap calls** send the same reference plus the
   `payment_hash`. Your `authorize` hook still runs.

`prefix` is the path you mounted the router at. In the example it is
`/openreceive`. Every browser URL is `prefix` plus a fixed path, so you have
nothing else to keep in sync. If the router sits inside another mount, such as
`app.use("/api", openReceiveExpress(...))`, pass `/api/openreceive`.

Pass `polling={false}` to render a snapshot without polling.

Your application API serves order summaries and resume pages. OpenReceive
does not.

## Props that matter

Full list: [API reference → Browser & React](api-reference.md#browser--react).

- `reference`: the order id, for create mode (the usual path). Or pass
  `checkout` for a snapshot you already loaded.
- `prefix`: the mount path, as the browser sees it.
- `csrfHeader`: the name of the header that carries the page's
  `<meta name="csrf-token">` value on every request. The meta tag name is
  fixed. Only the header name varies by framework:
  - Rails and Laravel read the default `X-CSRF-Token` and need nothing.
  - Django reads `X-CSRFToken`.
  - WordPress REST reads `X-WP-Nonce`.

  The prop has the same name in all four wrappers. On the custom element it is
  `csrf-header`.
- `onSettled`, `onError`, `onState`: settlement, failures, and every attempt
  the checkout watches. If you want the payer to come back to a refund later,
  store the swap `payment_hash` from `onState`.
- `resumable`: whether a closed tab has a URL that brings the payer back. The
  checkout infers it from `syncUrl` / `routeReference`. Set it yourself when
  your router owns a per-order path the component cannot see. It decides which
  warning the refund screen shows. See [Checkout UX → The refund screens](checkout-ux.md#the-refund-screens).
- `resumePaymentHash`: after prepare, reopen that attempt instead of showing
  the method grid. `/checkouts/prepare` returns no attempts. If the server will
  not serve the hash, the checkout ignores it. See [Swap refunds](swap-refunds.md).
- `theme`, `themeToggle`, `defaultTheme`, `children`, `components`,
  `classNames`: the look around the payment UI. See [Theme](#theme) below.
  `children` and `components` / `classNames` are React-only. Vue, Svelte, and
  Angular wrap the same custom element.

There is no image prop. Everything the checkout draws ships inside the
JavaScript: the payment-method icons, the wallet logos and the pay tutorials.
You have no image file to copy or serve and no asset option to set, with any
bundler or none. Deploy the complete JavaScript and CSS build output, including
generated JavaScript chunks. Code-splitting builds may load tutorial
screenshots the first time a tutorial opens. Single-file builds include them
up front. If your Content-Security-Policy has a strict `img-src`, allow `data:`
([Provider registry](provider-registry.md#assets)).

To use the same engine with your own layout, use `useCheckout`, the hook behind
`<Checkout>`. It returns the live snapshot, status labels, and
`copyInvoice` / `openWallet` / `retry`. Use `openWallet` on touch devices
only. Use `checkoutLabels` for any string you put on the screen.

Importing `@openreceive/react` plus its `styles.css` adds roughly 530 kB
minified (~150 kB gzipped) to a production chunk. If that size matters for the
rest of your site, lazy-load the checkout route so only payers download it.

## Without a bundler

If your site has no JS build step, use the standalone build. Examples are a
WordPress plugin, a Django template, or a plain PHP page. `@openreceive/elements`
ships the standalone build under `dist/standalone/`. You can also get it from
npm with `import "@openreceive/elements/standalone/openreceive-checkout.js"`.
Every GitHub release attaches it as `standalone-checkout-<version>.tar.gz`. It
is two files plus a manifest:

- `openreceive-checkout.js`: one self-contained ES module. It inlines every
  `@openreceive/*` dependency. It registers `<openreceive-checkout>` and
  `<openreceive-theme-toggle>` as soon as it loads, and still exports the
  package's named API. Identifiers are not mangled. Only whitespace is
  minified. A source map sits beside it.
- `openreceive-checkout.css`: the same scoped stylesheet as `styles.css`.
- `MANIFEST.json`: the workspace version and a SHA-256 hash per file. Use it to
  check a copied tree against the release it came from.

Copy the directory somewhere your server serves static files from, and add two
tags:

```html
<link rel="stylesheet" href="/static/openreceive/openreceive-checkout.css" />
<script type="module" src="/static/openreceive/openreceive-checkout.js"></script>

<openreceive-checkout
  reference="ord_123"
  prefix="/openreceive"
></openreceive-checkout>
```

That is all you serve. Everything the checkout draws is inside
`openreceive-checkout.js`: the payment-method icons, the wallet logos and the
pay tutorials. The standalone bundle is one file, so the tutorials are not a
separate chunk here. If your Content-Security-Policy has a strict `img-src`,
allow `data:` ([Provider registry → Assets](provider-registry.md#assets)).

The build is reproducible. Running `npm run build:packages` in the
[repository](https://github.com/openreceive/openreceive) regenerates the
directory from the same commit, using
`tools/package/build-standalone-elements.mjs`. `npm run check:standalone`
checks a copy against its manifest.

## Theme

The checkout sets `data-theme="light"` / `"dark"` on its root and styles
itself from CSS variables under it. It picks the theme in this order:

1. the payer's stored choice (`localStorage["openreceive.theme"]`)
2. `defaultTheme`
3. the system `prefers-color-scheme`

The stylesheet never reaches outside that root. Every rule in `styles.css` is
scoped to `data-openreceive-root`. The checkout, the theme toggle and the
wrapper shell each set that attribute on themselves. Your page keeps its own
resets, headings, buttons and theme variables, whatever order the stylesheets
load in.

If the page that embeds the checkout always uses one theme, lock it and skip
all of that:

```tsx
<Checkout reference={order.id} prefix="/openreceive" theme="dark" />
```

```html
<openreceive-checkout reference="ord_123" theme="dark"></openreceive-checkout>
```

The lock wins over the stored preference and any ancestor `ThemeScope`. It
also hides the toggle, because a locked theme has nothing to toggle.
`theme="system"` locks to `prefers-color-scheme` alone.

`themeToggle={false}` hides the packaged toggle button. The checkout still sets
and styles its resolved theme.

`defaultTheme` is only the starting point until the payer makes a choice. Use
`theme` when your site, not the payer, makes the decision.

Server-rendered pages paint the default theme before the stored preference
applies on mount. To avoid that one-frame flash, pass `theme` or a
server-readable `storage`.

The "Creating checkout…" and "Could not start checkout." screens, shown before
a checkout is created, use the same resolved theme.

## Layout and surface

The checkout lays itself out by its **own width**, not the viewport's. Its
root is a CSS size query container (`container-type: inline-size`, named
`openreceive`). Every internal breakpoint is a container query at the usual
values:

- one column of payment methods under 40rem of checkout width
- two columns from 40rem
- three from 48rem
- four from 64rem
- the two-column wallet list from 48rem

So a checkout mounted in a 560px card on a 1280px page lays out like a 560px
screen. You only need to do one thing: give the root a width. It is a
block-level element, so any normal container works. As a flex or grid item,
add `flex: 1` / `width: 100%`. An inline-size container cannot size itself from
its contents. Container queries and `cqw` units have worked in every browser
since 2023.

The root paints the theme's `base-100` surface, and adds its own padding and
rounded corners (`p-4`, `rounded-box`). You can change both on
`[data-openreceive-root]`:

- If you draw your own card around the checkout and want no second surface,
  set `--root-bg: transparent`.
- For a tighter or looser inset, override `padding`.

Both work because every rule in the shipped stylesheet is wrapped in `:where()`
and has **zero specificity**. Any selector of yours, however plain, wins on the
same property. We promise to keep it that way for compatibility.

Serve the compiled `styles.css` without Tailwind processing. Import it from
JavaScript with a CSS-capable bundler, or use a plain `<link rel="stylesheet">`.
Do not `@import` it into your own Tailwind entry file. Its zero-specificity
rules let your styles override checkout styles. Scoping does not prevent
that.

For a custom element in a flex or grid layout, give the host a width:

```css
openreceive-checkout { display: block; width: 100%; }
```

## Show the payer what they are buying

Return a `description` beside the price. Both drop-ins print it above the
amount on every screen. It also becomes the invoice memo, so the payer's wallet
shows it too:

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

It is one display string. It travels only in the prepare and create
responses, never in a request body.

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

Children add to the payment UI. They render above it and never replace it.
That is the same position as the custom element's `order` slot. To build your
own checkout instead, use `useCheckout` or the headless API, not `children`.

The custom element uses a named slot:

```html
<openreceive-checkout reference="ord_123" prefix="/openreceive">
  <ul slot="order" class="order-lines">
    <li>2 kg Ataulfo mangoes</li>
  </ul>
</openreceive-checkout>
```

## Showing the payer their receipt

`<TransactionDetails>` is the collapsible panel that shows the payment hash and
deposit txid. `@openreceive/elements` offers the same panel as
`renderTransactionDetailsHtml` / `createTransactionDetailsElement`.
`<Checkout>` already renders it. You can also mount it on your order page:

```tsx
<TransactionDetails state={await loadCheckoutState(order.id)} />
```

## Building your own UI

The drop-in already follows the rules for what payers see. If you replace it,
following those rules is your job. [Checkout UX](checkout-ux.md) is the short
list, and [Headless checkout](headless-checkout.md) is the API.
