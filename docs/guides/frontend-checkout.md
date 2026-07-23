# Frontend checkout

The browser never receives NWC or token-encryption keys and never chooses the charged amount.
Create the order through your own application route, then pass its ID to the UI:

```tsx
const order = await createMyOrder(cart);
return <Checkout orderId={order.id} prefix="/openreceive" />;
```

`requestCheckout({ orderId, prefix })` posts the order ID to the mounted create route. The host
resolves the order price and commits its payment hash before the browser receives the invoice.
The browser keeps the returned capability in memory and attaches it to payment checks.

Order summaries and resume pages are host concerns; fetch them from your application API, not
from OpenReceive. Status polling posts the known `payment_hash` to `/payments/check`.
