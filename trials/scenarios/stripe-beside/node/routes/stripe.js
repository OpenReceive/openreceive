import express from "express";
import { createCheckoutSession, verifyWebhookSignature } from "../lib/stripe.js";

// Card payments: POST /stripe/checkout/:id sends the buyer to Stripe, and
// POST /stripe/webhook marks the order paid.
export function stripeRouter({ findOrder, markPaid }) {
  const router = express.Router();

  router.post("/checkout/:id", (req, res) => {
    const order = findOrder(Number(req.params.id));
    if (order?.status !== "awaiting_payment") {
      res.status(404).type("text/plain").send("no such order\n");
      return;
    }
    const session = createCheckoutSession({ orderId: order.id, amountCents: 700 });
    res.redirect(303, session.url);
  });

  router.post("/webhook", express.json(), (req, res) => {
    if (!verifyWebhookSignature(req.headers["stripe-signature"])) {
      res.status(400).type("text/plain").send("bad signature\n");
      return;
    }
    const event = req.body;
    if (event?.type === "checkout.session.completed") {
      markPaid(Number(event.data?.object?.metadata?.order_id));
    }
    res.json({ received: true });
  });

  return router;
}
