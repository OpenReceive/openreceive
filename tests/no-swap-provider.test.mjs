// A shop that never configured a swap provider must still take Lightning payments.
// Every test here boots the real service from an environment with no usable
// LSC_URI_* value and drives the real HTTP routes with the testkit fake wallet.
//
// The blank environments are what `${LSC_URI_PRIMARY:-}` in a Compose file and a
// half-filled .env produce: the variable exists and holds nothing, which must
// mean "not configured", never an invalid-code error.
import assert from "node:assert/strict";
import test from "node:test";
import { StaticPriceProvider } from "../packages/js/core/src/index.ts";
import { createLifecycleStack } from "./helpers/lifecycle-harness.mjs";

const NO_SWAP_ENVIRONMENTS = [
  ["no LSC_URI variables at all", {}],
  ["LSC_URI_* empty", { LSC_URI_PRIMARY: "", LSC_URI_BACKUP: "" }],
  ["LSC_URI_* whitespace", { LSC_URI_PRIMARY: "   ", LSC_URI_BACKUP: "\t\n " }],
];

// 1 sat is below every swap provider's minimum and 2 BTC above every maximum;
// neither limit may touch a Lightning invoice.
const BELOW_ANY_SWAP_MINIMUM_SATS = 1;
const ABOVE_ANY_SWAP_MAXIMUM_SATS = 200_000_000;
const DOCUMENTED_SWAP_ERROR = {
  code: "INTERNAL",
  message: "No configured swap provider supports USDT_TRON.",
};

// Nothing in a no-swap shop should call out: there is no provider, and sat
// amounts need no price feed. A stray fetch fails the test.
const realFetch = globalThis.fetch;
let outboundFetches;
test.beforeEach(() => {
  outboundFetches = [];
  globalThis.fetch = (input) => {
    outboundFetches.push(String(input?.url ?? input));
    throw new Error(`unexpected outbound fetch: ${input}`);
  };
});
test.afterEach(() => {
  globalThis.fetch = realFetch;
});

async function noSwapShop(env) {
  let nowSeconds = 1_700_000_000;
  const clock = () => nowSeconds;
  const logs = [];
  const stack = await createLifecycleStack({
    noSwapProvider: true,
    env,
    now: clock,
    handlerClock: clock,
    logger: (entry) => logs.push(entry),
    priceProviders: [new StaticPriceProvider()],
  });
  const post = async (route, body) => {
    const response = await stack.fetchStub(`/openreceive${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    ...stack,
    logs,
    post,
    advance(seconds) {
      nowSeconds += seconds;
    },
    providerComplaints() {
      return logs.filter(
        (entry) =>
          (entry.level === "error" || entry.level === "warn") &&
          /swap|lsc|provider/i.test(JSON.stringify(entry)),
      );
    },
  };
}

for (const [label, env] of NO_SWAP_ENVIRONMENTS) {
  test(`no swap provider (${label}): boot, prepare, mint, settle and the paid hook`, async () => {
    const shop = await noSwapShop(env);
    try {
      assert.deepEqual(shop.providerComplaints(), [], "boot must log no error about the provider");
      assert.equal(
        shop.logs.find((entry) => entry.event === "swap.providers.resolved")?.provider_count,
        0,
      );
      assert.equal(shop.logs.filter((entry) => entry.level === "error").length, 0);

      shop.addOrder("order-no-swap", 2_100);
      const prepared = await shop.post("/checkouts/prepare", { reference: "order-no-swap" });
      assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
      assert.equal(prepared.body.amount_msats, 2_100_000);
      assert.deepEqual(prepared.body.payment_methods, [], "no swap methods on offer");
      assert.equal(shop.wallet.listInvoices().length, 0, "prepare mints nothing");
      assert.deepEqual(outboundFetches, [], "prepare calls no swap provider");

      const created = await shop.post("/checkouts", { reference: "order-no-swap" });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.match(created.body.checkout.bolt11, /^lnbc/);
      assert.match(created.body.checkout.payment_hash, /^[0-9a-f]{64}$/);
      assert.equal(created.body.checkout.amount_msats, 2_100_000);
      // The wire keeps the (empty) catalog, so a client's picker can stop loading.
      assert.deepEqual(created.body.payment_methods, []);
      const [invoice] = shop.wallet.listInvoices();
      assert.equal(invoice.payment_hash, created.body.checkout.payment_hash);
      assert.equal(Number(invoice.amount_msats), 2_100_000);

      const pending = await shop.post("/payments/check", {
        reference: "order-no-swap",
        payment_hash: created.body.checkout.payment_hash,
      });
      assert.equal(pending.status, 200);
      assert.equal(pending.body.status, "pending");
      assert.deepEqual(pending.body.payment_methods, []);

      shop.wallet.settleInvoice({ payment_hash: created.body.checkout.payment_hash });
      shop.advance(10);
      const settled = await shop.post("/payments/check", {
        reference: "order-no-swap",
        payment_hash: created.body.checkout.payment_hash,
      });
      assert.equal(settled.status, 200);
      assert.equal(settled.body.status, "settled");
      shop.advance(10);
      await shop.post("/payments/check", {
        reference: "order-no-swap",
        payment_hash: created.body.checkout.payment_hash,
      });
      assert.deepEqual(
        shop.settlements.map((settlement) => settlement.reference),
        ["order-no-swap"],
        "the paid hook fires exactly once",
      );
      assert.deepEqual(outboundFetches, []);
    } finally {
      await shop.close();
    }
  });

  test(`no swap provider (${label}): amounts below and above any swap limit mint exactly`, async () => {
    const shop = await noSwapShop(env);
    try {
      for (const [reference, sats] of [
        ["order-tiny", BELOW_ANY_SWAP_MINIMUM_SATS],
        ["order-huge", ABOVE_ANY_SWAP_MAXIMUM_SATS],
      ]) {
        shop.addOrder(reference, sats);
        const created = await shop.post("/checkouts", { reference });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        assert.equal(created.body.checkout.amount_msats, sats * 1000);
        assert.deepEqual(created.body.payment_methods, []);
      }
    } finally {
      await shop.close();
    }
  });

  test(`no swap provider (${label}): swap routes refuse cleanly and never reach the wallet`, async () => {
    const shop = await noSwapShop(env);
    const expectations = [
      ["/swaps/quote", { reference: "order-no-swap", pay_in_asset: "USDT_TRON" }],
      ["/swaps", { reference: "order-no-swap", pay_in_asset: "USDT_TRON" }],
    ];
    try {
      shop.addOrder("order-no-swap", 2_100);
      for (const [route, body] of expectations) {
        const answered = await shop.post(route, body);
        assert.equal(answered.status, 503, `${route}: ${JSON.stringify(answered.body)}`);
        assert.equal(answered.body.code, DOCUMENTED_SWAP_ERROR.code, route);
        assert.equal(answered.body.message, DOCUMENTED_SWAP_ERROR.message, route);
      }
      assert.equal(shop.wallet.listInvoices().length, 0, "a refused swap mints no invoice");

      // Status and refund need an attempt to read, so mint one and ask about it.
      const created = await shop.post("/checkouts", { reference: "order-no-swap" });
      const paymentHash = created.body.checkout.payment_hash;
      for (const route of ["/swaps/status", "/swaps/refunds"]) {
        const answered = await shop.post(route, {
          reference: "order-no-swap",
          payment_hash: paymentHash,
          ...(route === "/swaps/refunds"
            ? { refund_address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb" }
            : {}),
        });
        assert.equal(answered.status, 404, `${route}: ${JSON.stringify(answered.body)}`);
        assert.equal(answered.body.code, "NOT_FOUND", route);
        assert.equal(answered.body.message, "The host order has no swap data.", route);
      }
      assert.equal(shop.wallet.listInvoices().length, 1, "refused swap routes mint nothing");
      assert.deepEqual(outboundFetches, []);
      assert.deepEqual(shop.providerComplaints(), []);
    } finally {
      await shop.close();
    }
  });

  test(`no swap provider (${label}): the rates route answers so a checkout cannot hang`, async () => {
    const shop = await noSwapShop(env);
    try {
      const response = await shop.fetchStub("/openreceive/rates?currencies=USD", { method: "GET" });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.ok(body.bitcoin.usd, "rates answer with a USD price");
      assert.deepEqual(outboundFetches, []);
    } finally {
      await shop.close();
    }
  });
}
