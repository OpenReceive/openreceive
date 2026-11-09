// A stand-in for the Stripe SDK, so this shop's card flow works offline.
// `createCheckoutSession` answers as Stripe's Checkout Sessions API would.

export function createCheckoutSession({ orderId, amountCents }) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error("amount must be a positive integer of cents");
  }
  const id = `cs_test_${orderId}_${Date.now()}`;
  return { id, url: `https://checkout.stripe.test/c/pay/${id}`, amount_total: amountCents };
}

/** Verifies a webhook's signature header. The stand-in checks one fixed value. */
export function verifyWebhookSignature(signature) {
  return signature === "whsec_test_signature";
}
