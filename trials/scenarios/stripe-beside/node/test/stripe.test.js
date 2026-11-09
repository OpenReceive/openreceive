import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { createCheckoutSession, verifyWebhookSignature } from "../lib/stripe.js";
import { stripeRouter } from "../routes/stripe.js";

function listening(findOrder, markPaid) {
  const app = express();
  app.use("/stripe", stripeRouter({ findOrder, markPaid }));
  const server = createServer(app);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("a checkout session answers with a Stripe-hosted URL", () => {
  const session = createCheckoutSession({ orderId: 9, amountCents: 700 });
  assert.match(session.id, /^cs_test_9_/);
  assert.match(session.url, /^https:\/\/checkout\.stripe\.test\/c\/pay\//);
  assert.equal(session.amount_total, 700);
});

test("a session refuses a fractional amount of cents", () => {
  assert.throws(() => createCheckoutSession({ orderId: 9, amountCents: 7.5 }), /integer/);
});

test("the webhook signature must match", () => {
  assert.equal(verifyWebhookSignature("whsec_test_signature"), true);
  assert.equal(verifyWebhookSignature("nope"), false);
});

test("POST /stripe/checkout/:id redirects an unpaid order to Stripe", async () => {
  const server = await listening(
    (id) => ({ id, status: "awaiting_payment" }),
    () => {},
  );
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/stripe/checkout/3`, {
    method: "POST",
    redirect: "manual",
  });
  server.close();
  assert.equal(response.status, 303);
  assert.match(response.headers.get("location"), /checkout\.stripe\.test/);
});

test("a signed completed-session webhook marks the order paid", async () => {
  const paid = [];
  const server = await listening(
    () => undefined,
    (id) => paid.push(id),
  );
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/stripe/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": "whsec_test_signature" },
    body: JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { metadata: { order_id: "12" } } },
    }),
  });
  server.close();
  assert.equal(response.status, 200);
  assert.deepEqual(paid, [12]);
});
