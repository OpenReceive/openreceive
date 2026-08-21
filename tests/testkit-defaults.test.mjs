import assert from "node:assert/strict";
import test from "node:test";
import { createOpenReceive } from "../packages/js/node/src/index.ts";
import { reconcileOpenReceivePayments } from "../packages/js/http/src/index.ts";
import { createTestkitReceiveClient } from "../packages/js/testkit/src/index.ts";

test("the testkit wallet clock defaults to the real clock", async () => {
  const wallet = createTestkitReceiveClient();
  const invoice = await wallet.makeInvoice({ amount_msats: 1_000n });
  const now = Math.floor(Date.now() / 1_000);
  assert.ok(Math.abs(invoice.created_at - now) <= 5, `created_at ${invoice.created_at}`);
  assert.ok(invoice.expires_at > now);
});

// The default clock has to agree with the one reconciliation uses. A fixed low
// value put every minted invoice past expiry plus grace, so the first pass
// closed attempts the test still considered pending.
test("a default-clock testkit invoice stays pending through a reconcile pass", async () => {
  const wallet = createTestkitReceiveClient();
  const service = await createOpenReceive({ client: wallet });
  try {
    const checkout = await service.createCheckout({
      orderId: "order-testkit-clock",
      amount: { sats: 10 },
    });
    const transitions = [];
    const checks = await reconcileOpenReceivePayments({
      service,
      host: {
        onPaid: async () => undefined,
        payments: {
          listReconcilableAttempts: async () => [
            {
              paymentHash: checkout.paymentHash,
              createdAt: checkout.createdAt,
              expiresAt: checkout.expiresAt,
            },
          ],
          recordReconciliation: (transition) => transitions.push(transition),
        },
      },
    });
    assert.equal(checks.length, 1);
    assert.deepEqual(transitions, []);
  } finally {
    await service.close();
  }
});
