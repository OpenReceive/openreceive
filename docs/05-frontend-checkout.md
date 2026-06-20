# Frontend Checkout

Frontend code receives display-safe invoice data only. It must never receive an
NWC connection string, wallet secret, or server-side wallet client.

## Browser Helpers

`@openreceive/browser` provides framework-neutral helpers:

- `createLightningUri(invoice)`
- `createQrSvg(invoice)`
- `createQrPngDataUrl(invoice)`
- `copyInvoice({ invoice })`
- `openWallet({ invoice })`
- `createOpenReceiveCheckoutState(invoiceResponse)`
- `applyOpenReceiveInvoiceEvent(state, event)`
- `parseOpenReceiveInvoiceEvent(event.data)`

These helpers reject NWC connection strings and only work with BOLT11 invoice
strings.

The checkout state helpers are pure browser-side reducers for display state.
They update only matching `invoice_id` and `payment_hash` events, track
countdown/phase fields, and keep settlement as a UI hint. Fulfillment still
requires backend lookup and app-owned authorization.

```ts
let checkout = createOpenReceiveCheckoutState(invoiceResponse, {
  now: Math.floor(Date.now() / 1000)
});

events.addEventListener("invoice.settled", (event) => {
  checkout = applyOpenReceiveInvoiceEvent(
    checkout,
    parseOpenReceiveInvoiceEvent(event.data),
    { eventName: "invoice.settled" }
  );
});
```

## Browser Logs

The browser helpers accept an optional `logger(entry)` callback on checkout
state, event, copy, and open-wallet operations:

```ts
const logger = (entry) => console[entry.level]("[openreceive]", entry);

let checkout = createOpenReceiveCheckoutState(invoiceResponse, {
  logger,
  now: Math.floor(Date.now() / 1000)
});

checkout = applyOpenReceiveInvoiceEvent(checkout, eventPayload, {
  eventName: "invoice.settled",
  logger
});
```

Client log entries use display-safe fields such as `invoice_id`,
`payment_hash`, amount, transaction state, workflow state, and phase. They do
not log BOLT11 invoice strings, NWC connection strings, signed event URL
tokens, cookies, authorization headers, or request bodies.

## Web Components

`@openreceive/elements` provides a small no-framework checkout element:

```ts
import { defineOpenReceiveElements } from "@openreceive/elements";

defineOpenReceiveElements({ logger });
```

```html
<openreceive-checkout
  invoice="lnbc..."
  payment-hash="..."
  amount-msats="200000"
  transaction-state="pending"
></openreceive-checkout>
```

The element renders QR, copy, and open-wallet controls from display-safe invoice
data. It dispatches:

- `openreceive-copy`
- `openreceive-open-wallet`
- `openreceive-error`

Settlement and fulfillment still belong to backend-verified invoice state.
Frontend events are UI hints, not payment authority.

## React

`@openreceive/react` provides a headless hook, small primitives, slot/component
overrides, and a default checkout component:

```tsx
import {
  CopyInvoiceButton,
  OpenWalletButton,
  OpenReceiveCheckout,
  OpenReceiveInvoiceSummary,
  OpenReceiveQRCode,
  useOpenReceiveCheckout
} from "@openreceive/react";

const checkout = useOpenReceiveCheckout({ invoice: "lnbc..." });
```

```tsx
<CopyInvoiceButton invoice={checkout.invoice}>Copy invoice</CopyInvoiceButton>
<OpenWalletButton invoice={checkout.invoice}>Open wallet</OpenWalletButton>
```

```tsx
<OpenReceiveCheckout
  invoice="lnbc..."
  payment_hash="..."
  amount_msats={200000}
  transaction_state="pending"
  logger={logger}
/>
```

React components follow the same boundary: they render invoice display data and
browser actions, while the backend remains the settlement authority.

Apps with their own design system can replace the visible pieces without
forking payment logic:

```tsx
<OpenReceiveCheckout
  invoice="lnbc..."
  amount_msats={200000}
  transaction_state="pending"
  components={{
    Button: MyButton,
    InvoiceSummary: MySummary
  }}
  classNames={{
    root: "checkout",
    qr: "checkoutQr",
    actions: "checkoutActions"
  }}
/>
```

For full markup ownership, pass a render function as `children`. The render
function receives the display-safe checkout view model.

The Material UI recipe in `docs/recipes/react-material-ui.md` shows how to
compose the React primitives inside an app-owned design system.

## Static Demo

`examples/hello-fruit/server/static-html-small-api` shows the same flow without
React. It uses shared fruit assets, mounts the Express API inside Vite during
local development, and renders `<openreceive-checkout>` from display-safe
invoice JSON.
