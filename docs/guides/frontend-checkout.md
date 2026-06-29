# Frontend Checkout

Frontend code receives display-safe invoice data only. Keep NWC connection
strings, wallet clients, and fulfillment on the backend.

## Browser Helpers

`@openreceive/browser` is the small app-facing browser entry:

- `status(invoiceLike)` returns `"pending"`, `"settled"`, `"expired"`, or
  `"failed"` from display-safe fields.
- `requestCheckoutInvoice(options)` is a lower-level helper for apps that intentionally
  expose a checkout-creation route; most stores call their own `/create_order`
  route and render the checkout returned with the order.
- `lightningUri(invoice)`, `qrSvg(invoice)`, and `qrPngDataUrl(invoice)` render
  BOLT11 payment data.
- `copyInvoice({ invoice })` copies the BOLT11 string.
- `openWallet({ invoice })` launches the visitor's installed Lightning wallet
  app with this invoice prefilled. Call it from your own "Open in wallet"
  button's click handler.
- `createCheckoutController(options)` powers advanced headless checkout flows.

These helpers reject NWC connection strings. They work with display-safe BOLT11
invoice data only.

```ts
import { status } from "@openreceive/browser";

const response = await fetch("/create_order", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ cart })
});
const { order, checkout } = await response.json();

console.log(status(checkout));
```

`status()` is a display helper. Your product still unlocks only after the
backend settlement hook runs.

## React

The default checkout is one prop:

```tsx
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

<Checkout
  invoice={checkout}
  statusUrl="/order_status"
  onSettled={() => showThankYou()}
/>;
```

`onSettled` is a UI hint from status refresh. It is useful for showing a thank-you panel,
but fulfillment stays in the backend settlement hook.

`statusUrl` is optional. If omitted, React uses the default
`/openreceive/v1/orders/{order_id}/status` route. Apps without a frontend
status route can render a static checkout surface without status refresh:

```tsx
<Checkout invoice={checkout} polling={false} />;
```

Use `statusUrl={false}` to disable only the default status URL while still
allowing a custom `refreshStatus` function.

For app-wide theme attributes and the packaged light/dark toggle:

```tsx
import { Checkout, ThemeScope } from "@openreceive/react";

<ThemeScope as="main" className="page" themeToggle>
  <Checkout invoice={checkout} />
</ThemeScope>
```

To build your own checkout layout from the individual pieces (QR code, invoice
summary, copy button, open-wallet button) instead of using the default
`<Checkout>`:

```tsx
import {
  CopyInvoiceButton,
  InvoiceSummary,
  OpenWalletButton,
  QRCode,
  useCheckout
} from "@openreceive/react";

function CustomCheckout({ invoice }) {
  const checkout = useCheckout({ invoice });

  return (
    <section>
      <QRCode invoice={checkout.invoice} />
      <InvoiceSummary
        amountLabel={checkout.amountLabel}
        fiatLabel={checkout.fiatLabel}
        paymentHashLabel={checkout.paymentHashLabel}
        status={checkout.status}
      />
      <CopyInvoiceButton
        invoice={checkout.invoice}
        copyInvoice={checkout.copyInvoice}
      />
      <OpenWalletButton
        invoice={checkout.invoice}
        openWallet={checkout.openWallet}
      />
    </section>
  );
}
```

For a fully headless checkout, use `useCheckout({ invoice })` and render your
own markup. The hook owns status refresh, countdown state, copy/open-wallet
actions, retry, refresh, cancel, and the public `status` string.

Apps with design systems can also pass `components`, `classNames`, or a render
function as `children` to `Checkout`.

## Web Components

`@openreceive/elements` registers `<openreceive-checkout>` and
`<openreceive-theme-toggle>` for no-framework pages.

```ts
import { defineOpenReceiveElements } from "@openreceive/elements";
import "@openreceive/elements/styles.css";

defineOpenReceiveElements();
```

```html
<openreceive-theme-toggle
  root-selector=".page"
  checkout-selector="openreceive-checkout"
  default-theme="light"
></openreceive-theme-toggle>

<openreceive-checkout
  invoice-id="or_inv_..."
  invoice="lnbc..."
  payment-hash="..."
  amount-msats="200000"
  status="pending"
  expires-at="1781943000"
  status-url="/order_status"
  theme="dark"
></openreceive-checkout>
```

The element renders QR, copy, open-wallet, waiting, countdown, and payment
wizard UI from display-safe data. It dispatches UI events such as
`openreceive-copy`, `openreceive-open-wallet`, `openreceive-state`,
`openreceive-settled`, and `openreceive-error`. Treat all frontend events as
display hints.

## Vue

```vue
<script setup lang="ts">
import Checkout from "@openreceive/vue/checkout.vue";
import type { CheckoutSnapshot } from "@openreceive/vue";
import "@openreceive/vue/styles.css";

defineProps<{ invoice: CheckoutSnapshot }>();
</script>

<template>
  <Checkout :invoice="invoice" :options="{ onSettled: showThankYou }" />
</template>
```

## Svelte

```svelte
<script lang="ts">
  import Checkout from "@openreceive/svelte/checkout.svelte";
  import "@openreceive/svelte/styles.css";

  export let invoice;
</script>

<Checkout invoice={invoice} options={{ onSettled: showThankYou }} />
```

## Angular

`@openreceive/angular` provides a thin typed binding around the shared web
component:

- `@openreceive/angular/checkout-component`

The common binding path creates the checkout element attributes and listeners
from the same invoice object:

```ts
import {
  createOpenReceiveAngularCheckoutShellBinding,
  defineOpenReceiveElements
} from "@openreceive/angular";

defineOpenReceiveElements();

const shell = createOpenReceiveAngularCheckoutShellBinding(invoice, {
  rootSelector: ".page",
  onSettled: () => showThankYou()
});
```

## Styling

Each frontend package exposes a `styles.css` wrapper:

```ts
import "@openreceive/react/styles.css";
import "@openreceive/elements/styles.css";
import "@openreceive/vue/styles.css";
import "@openreceive/svelte/styles.css";
import "@openreceive/angular/styles.css";
```

Use the package you installed. The CSS does not contain receive-only NWC codes or
live checkout authority.

## Browser Logs

Checkout helpers accept an optional `logger(entry)` callback. Log entries are
display-safe and omit BOLT11 strings, NWC connection strings, signed status or
refresh tokens, cookies, authorization headers, and request bodies.

```ts
const logger = (entry) => console[entry.level]("[openreceive]", entry);

<Checkout invoice={invoice} logger={logger} />;
```
