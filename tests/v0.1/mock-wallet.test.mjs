import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MOCK_NWC,
  createMockWalletService
} from "../../tools/mock-wallet/server.mjs";

test("mock wallet exposes deterministic info, invoices, and lookup", async () => {
  const service = createMockWalletService({ now: () => 6000 });

  assert.match(service.parsedNwc.redacted, /\[REDACTED\]/);
  assert.doesNotMatch(service.parsedNwc.redacted, /0{64}/);
  assert.equal(DEFAULT_MOCK_NWC.includes("secret="), true);

  const health = service.health();
  assert.equal(health.ok, true);
  assert.equal(health.invoice_count, 0);

  const info = await service.getInfo();
  assert.equal(info.receiveCheckoutReady, true);
  assert.deepEqual(info.methods, ["make_invoice", "lookup_invoice"]);
  assert.deepEqual(info.notifications, ["payment_received"]);

  const invoice = await service.makeInvoice({
    amount_msats: "200000",
    description: "Fruit sticker",
    expiry: 90
  });
  assert.equal(invoice.invoice, "lnbcopenreceive000001");
  assert.equal(invoice.payment_hash, "0".repeat(63) + "1");
  assert.equal(invoice.amount_msats, "200000");
  assert.equal(invoice.created_at, 6000);
  assert.equal(invoice.expires_at, 6090);

  const lookup = await service.lookupInvoice({
    payment_hash: invoice.payment_hash
  });
  assert.equal(lookup.state, "pending");
  assert.equal(lookup.amount_msats, "200000");

  const invoices = service.listInvoices();
  assert.equal(invoices.invoices.length, 1);
});

test("mock wallet emits scripted settlement and duplicate notifications", async () => {
  const service = createMockWalletService({ now: () => 6000 });
  const notifications = [];
  const unsubscribe = service.subscribeNotification((notification) => {
    notifications.push(notification);
  });

  const invoice = await service.makeInvoice({
    amount_msats: 200000
  });

  const settled = service.settle({
    payment_hash: invoice.payment_hash,
    settled_at: 6010
  });
  assert.equal(settled.state, "settled");
  assert.equal(settled.settled_at, 6010);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].payment_hash, invoice.payment_hash);

  const replayed = service.replayNotification({
    payment_hash: invoice.payment_hash,
    count: 2
  });
  assert.equal(replayed.notifications.length, 2);
  assert.equal(replayed.notifications[0].payment_hash, invoice.payment_hash);
  assert.equal(notifications.length, 3);

  unsubscribe();
  service.replayNotification({
    payment_hash: invoice.payment_hash,
    count: 1
  });
  assert.equal(notifications.length, 3);
});

test("mock wallet rejects oversized metadata before storing invoices", async () => {
  const service = createMockWalletService();

  await assert.rejects(
    () =>
      service.makeInvoice({
        amount_msats: "1000",
        metadata: {
          note: "x".repeat(3901)
        }
      }),
    /metadata must serialize below 3900 bytes/
  );

  assert.equal(service.listInvoices().invoices.length, 0);
});

test("mock wallet supports expired and failed control states", async () => {
  const service = createMockWalletService({ now: () => 6000 });
  const expiredInvoice = await service.makeInvoice({ amount_msats: "1000" });
  const failedInvoice = await service.makeInvoice({ amount_msats: "2000" });

  const expired = service.expire({ invoice: expiredInvoice.invoice });
  const failed = service.fail({ payment_hash: failedInvoice.payment_hash });

  assert.equal(expired.state, "expired");
  assert.equal(failed.state, "failed");
  assert.equal(
    (await service.lookupInvoice({ payment_hash: expiredInvoice.payment_hash })).state,
    "expired"
  );
  assert.equal(
    (await service.lookupInvoice({ invoice: failedInvoice.invoice })).state,
    "failed"
  );
});
