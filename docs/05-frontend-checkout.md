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

These helpers reject NWC connection strings and only work with BOLT11 invoice
strings.

## Web Components

`@openreceive/elements` provides a small no-framework checkout element:

```ts
import { defineOpenReceiveElements } from "@openreceive/elements";

defineOpenReceiveElements();
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

`@openreceive/react` provides a headless hook, small primitives, and a default
checkout component:

```tsx
import {
  OpenReceiveCheckout,
  OpenReceiveQRCode,
  useOpenReceiveCheckout
} from "@openreceive/react";

const checkout = useOpenReceiveCheckout({ invoice: "lnbc..." });
```

```tsx
<OpenReceiveCheckout
  invoice="lnbc..."
  payment_hash="..."
  amount_msats={200000}
  transaction_state="pending"
/>
```

React components follow the same boundary: they render invoice display data and
browser actions, while the backend remains the settlement authority.
