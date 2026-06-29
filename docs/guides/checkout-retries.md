# Checkout Retries

Invoices expire. OpenReceive does not create replacement invoices just because
time passes or because the frontend polls status. Show a try-again or start-over
action, then call `getOrCreateCheckout` again from that user action.

Use the same order id for the same logical purchase. Use a new order id only
when your app is creating a different order.

## Retry Outcomes

On a user-driven retry, the order id is the boundary:

- Same order id and the order is already paid: OpenReceive returns the paid
  checkout and does not create another invoice, even if the amount you pass now
  differs from the paid checkout.
- Same order id, same amount, and an unexpired open checkout: OpenReceive
  returns the existing checkout and BOLT11.
- Same order id, changed amount, and an unexpired open checkout: OpenReceive
  supersedes the old open checkout and creates a new checkout and invoice for the
  new amount.
- Same order id and only expired checkouts remain: OpenReceive creates a new
  checkout and invoice for the amount you pass. Fiat amounts are quoted again at
  current rates; fixed `btc` or `sats` amounts keep the requested bitcoin
  amount. The old checkout stays in the order history as expired.
- Different order id: OpenReceive treats the call as a different order. The old
  order, old checkouts, and any late payment to an old invoice still belong to
  the old order.
- Status polling and `getOrder`: OpenReceive refreshes settlement status only;
  it never mints a replacement invoice from polling alone.

## Late Payments

Old unexpired checkouts remain settlement-watchable. If a superseded checkout is
paid before its invoice expires, `getOrder` exposes the paid checkout as
`paid_checkout` and `display_checkout`. Once every invoice for an order is past
`expires_at`, status polling reads storage only and does not call
`list_transactions`.

Fulfillment must be idempotent on `checkoutId` or your own order id. Fulfill from
the paid checkout snapshot and its metadata, not from the live cart.
