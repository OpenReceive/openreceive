# Frontend checkout

The browser never receives NWC, provider credentials, or `swap_data`, and never chooses the charged amount.
Create the order through your own application route, then pass its ID to the UI:

```tsx
const order = await createMyOrder(cart);
return <Checkout orderId={order.id} prefix="/openreceive" />;
```

`requestCheckout({ orderId, prefix })` posts the order ID to the mounted create route. The host
resolves the order price and commits its payment hash before the browser receives the invoice.
Later payment/swap requests send the same order ID and rely on the host's normal authorization.

Order summaries and resume pages are host concerns; fetch them from your application API, not
from OpenReceive. Status polling posts `order_id` to `/payments/check`; the host loads the hash.
