import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createOpenReceive } from "../packages/js/node/src/index.ts";
import { fixedFloatProvider } from "../packages/js/node/src/swap/fixedfloat.ts";
import {
  FIXEDFLOAT_SWAP_PROVIDER_LIMITS,
  PROVIDER_ONLY_SWAP_PROVIDER_LIMITS,
  SwapProviderWeightBudget,
  swapProviderLimitsForBaseUrl,
} from "../packages/js/node/src/swap/weight-budget.ts";
import { createTestkitReceiveClient } from "../packages/js/testkit/src/index.ts";

const NOW = 1_700_000_000;
const API_KEY = "test-api-key";
const API_SECRET = "test-api-secret";
const BASE_URL = "https://ff.example";
const BOLT11 = "lnbc200u1testshadowinvoice";
const TRX_ADDRESS = "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf";
const ETH_ADDRESS = "0x2222222222222222222222222222222222222222";

const SAMPLE_CCIES = [
  { code: "USDTTRC", coin: "USDT", network: "TRC20", recv: true, send: true },
  { code: "SOL", coin: "SOL", network: "SOL", recv: true, send: true },
  { code: "BTCLN", coin: "BTC", network: "LIGHTNING", recv: false, send: true },
];

// 20_000_000 msats = 20_000 sats = 0.0002 BTC (the string /create must receive).
const INVOICE_AMOUNT_MSATS = 20_000_000;

const CREATE_DATA = {
  id: "ORDER1",
  token: "TOKEN1",
  status: "NEW",
  from: { code: "USDTTRC", amount: "12.5", address: TRX_ADDRESS, tag: "1234", usd: "12.60" },
  to: { code: "BTCLN", amount: "0.0002", usd: "12.40" },
  time: { expiration: NOW + 550 },
};

const BASE_ORDER = {
  provider: "fixedfloat",
  provider_order_id: "ORDER1",
  provider_token: "TOKEN1",
  pay_in_asset: "USDT_TRON",
  deposit_address: TRX_ADDRESS,
  deposit_amount: "12.5",
  expires_at: NOW + 550,
  state: "awaiting_deposit",
};

/**
 * Provider wired to a fake fetch. `routes` maps an /api/v2 path ("create",
 * "order", ...) to either a data payload (wrapped in a `{code: 0}` envelope) or
 * a function returning a raw Response. Every call is recorded with its parsed
 * body and headers so tests can pin the outbound request contract.
 */
function makeProvider(routes, options = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const path = new URL(String(url)).pathname.replace(/^\/api\/v2\//, "");
    calls.push({
      path,
      method: init.method,
      headers: init.headers ?? {},
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      rawBody: init.body,
    });
    const route = routes[path];
    if (route === undefined) {
      throw new Error(`unexpected FixedFloat call: ${url}`);
    }
    if (typeof route === "function") return route();
    return Response.json({ code: 0, msg: "OK", data: route });
  };
  const provider = fixedFloatProvider({
    key: API_KEY,
    secret: API_SECRET,
    baseUrl: BASE_URL,
    fetch: fetcher,
    now: () => NOW,
    ...options,
  });
  return { provider, calls };
}

async function statusFor(orderData, baseOrder = BASE_ORDER) {
  const { provider } = makeProvider({ order: orderData });
  return await provider.getStatus(baseOrder);
}

test("direct provider diagnostic hooks receive only metadata and cannot interrupt payments", async () => {
  const { provider, calls } = makeProvider({
    ccies: SAMPLE_CCIES,
    create: CREATE_DATA,
    order: CREATE_DATA,
    emergency: {},
  });
  const events = [];
  provider.attachApiRequestLogger((entry) => events.push(entry));
  provider.attachApiResponseLogger((entry) => events.push(entry));
  const order = await provider.createSwap({
    payInAsset: "USDT_TRON",
    bolt11: BOLT11,
    invoiceAmountMsats: INVOICE_AMOUNT_MSATS,
  });
  await provider.getStatus(order);
  await provider.requestRefund(order, TRX_ADDRESS);
  const logged = JSON.stringify(events);
  for (const value of [
    API_KEY,
    API_SECRET,
    BOLT11,
    TRX_ADDRESS,
    "TOKEN1",
    "X-API-KEY",
    "X-API-SIGN",
  ]) {
    assert.equal(logged.includes(value), false, value);
  }
  assert.equal(order.provider_token, "TOKEN1");
  assert.equal(calls.find((call) => call.path === "emergency").body.token, "TOKEN1");
  provider.attachApiRequestLogger(() => {
    throw new Error("sink down");
  });
  provider.attachApiResponseLogger(() => {
    throw new Error("sink down");
  });
  await provider.getStatus(order);
  await provider.requestRefund(order, TRX_ADDRESS);
});

test("createSwap sends a signed fixed-rate create request and maps the order", async () => {
  const { provider, calls } = makeProvider({ ccies: SAMPLE_CCIES, create: CREATE_DATA });
  const order = await provider.createSwap({
    payInAsset: "USDT_TRON",
    bolt11: BOLT11,
    invoiceAmountMsats: INVOICE_AMOUNT_MSATS,
  });

  // /ccies resolves the pair, then /create places the order. from/to.usd were
  // present, so no /price fee backfill happens.
  assert.deepEqual(
    calls.map((call) => call.path),
    ["ccies", "create"],
  );
  const create = calls[1];
  assert.equal(create.method, "POST");
  assert.deepEqual(create.body, {
    type: "fixed",
    fromCcy: "USDTTRC",
    toCcy: "BTCLN",
    direction: "to",
    amount: "0.0002",
    toAddress: BOLT11,
  });
  assert.equal(create.headers["X-API-KEY"], API_KEY);
  assert.equal(
    create.headers["X-API-SIGN"],
    createHmac("sha256", API_SECRET).update(create.rawBody).digest("hex"),
  );

  assert.equal(order.provider, "fixedfloat");
  assert.equal(order.provider_order_id, "ORDER1");
  assert.equal(order.provider_token, "TOKEN1");
  assert.equal(order.pay_in_asset, "USDT_TRON");
  assert.equal(order.deposit_address, TRX_ADDRESS);
  assert.equal(order.deposit_memo, "1234");
  assert.equal(order.deposit_amount, "12.5");
  assert.equal(order.expires_at, NOW + 550);
  assert.equal(order.state, "awaiting_deposit");
  assert.deepEqual(order.fee, { currency: "USD", pay_in_fiat: "12.60", payout_fiat: "12.40" });
  assert.deepEqual(order.raw, CREATE_DATA);
});

test("createSwap fails when the order omits expiration", async () => {
  // No invented deadline: the provider states the expiry. A create body without
  // one is a provider contract break, and fabricating a 10-minute window would
  // hand the payer a deadline the provider never agreed to.
  const { provider } = makeProvider({
    ccies: SAMPLE_CCIES,
    create: { ...CREATE_DATA, time: {} },
  });
  await assert.rejects(
    provider.createSwap({
      payInAsset: "USDT_TRON",
      bolt11: BOLT11,
      invoiceAmountMsats: INVOICE_AMOUNT_MSATS,
    }),
    /FixedFloat order is missing time.expiration/,
  );
});

test("createSwap backfills the swap fee from /price when create omits USD values", async () => {
  const createData = {
    ...CREATE_DATA,
    from: { code: "USDTTRC", amount: "12.5", address: TRX_ADDRESS },
    to: { code: "BTCLN", amount: "0.0002" },
  };
  const { provider, calls } = makeProvider({
    ccies: SAMPLE_CCIES,
    create: createData,
    price: { from: { usd: "12.61" }, to: { usd: "12.41" } },
  });
  const order = await provider.createSwap({
    payInAsset: "USDT_TRON",
    bolt11: BOLT11,
    invoiceAmountMsats: INVOICE_AMOUNT_MSATS,
  });
  assert.deepEqual(
    calls.map((call) => call.path),
    ["ccies", "create", "price"],
  );
  assert.deepEqual(calls[2].body, {
    type: "fixed",
    fromCcy: "USDTTRC",
    toCcy: "BTCLN",
    direction: "to",
    amount: "0.0002",
  });
  assert.deepEqual(order.fee, { currency: "USD", pay_in_fiat: "12.61", payout_fiat: "12.41" });
});

test("createSwap leaves the fee off when the /price backfill fails", async () => {
  const createData = {
    ...CREATE_DATA,
    from: { code: "USDTTRC", amount: "12.5", address: TRX_ADDRESS },
    to: { code: "BTCLN", amount: "0.0002" },
  };
  const { provider } = makeProvider({
    ccies: SAMPLE_CCIES,
    create: createData,
    price: () => Response.json({ code: 1, msg: "Unavailable" }),
  });
  const order = await provider.createSwap({
    payInAsset: "USDT_TRON",
    bolt11: BOLT11,
    invoiceAmountMsats: INVOICE_AMOUNT_MSATS,
  });
  assert.equal(order.fee, undefined);
  assert.equal(order.state, "awaiting_deposit");
});

test("createSwap trusts the provider's quoted payout amount", async () => {
  const { provider } = makeProvider({
    ccies: SAMPLE_CCIES,
    create: { ...CREATE_DATA, to: { code: "BTCLN", amount: "0.0003" } },
  });
  const order = await provider.createSwap({
    payInAsset: "USDT_TRON",
    bolt11: BOLT11,
    invoiceAmountMsats: INVOICE_AMOUNT_MSATS,
  });
  assert.equal(order.state, "awaiting_deposit");
});

test("createSwap stores the deposit address the provider sent", async () => {
  const { provider } = makeProvider({
    ccies: SAMPLE_CCIES,
    create: {
      ...CREATE_DATA,
      from: { code: "USDTTRC", amount: "12.5", address: ETH_ADDRESS },
    },
  });
  const order = await provider.createSwap({
    payInAsset: "USDT_TRON",
    bolt11: BOLT11,
    invoiceAmountMsats: INVOICE_AMOUNT_MSATS,
  });
  assert.equal(order.deposit_address, ETH_ADDRESS);
});

test("getStatus maps every recognized FixedFloat status to its provider_state", async () => {
  const cases = [
    ["NEW", "awaiting_deposit"],
    ["PENDING", "confirming"],
    ["EXCHANGE", "exchanging"],
    ["WITHDRAW", "paying_invoice"],
    ["DONE", "completed"],
    ["done", "completed"],
    ["EXPIRED", "expired"],
    ["FAILED", "failed"],
  ];
  for (const [providerStatus, state] of cases) {
    // Sparse status payload: id/token/address/amount all come from the prior order.
    const order = await statusFor({ status: providerStatus });
    assert.equal(order.state, state, providerStatus);
    assert.equal(order.deposit_address, TRX_ADDRESS, providerStatus);
    assert.equal(order.deposit_amount, "12.5", providerStatus);
    assert.equal(order.expires_at, NOW + 550, providerStatus);
    assert.equal(order.attention, undefined, providerStatus);
  }
});

test("getStatus sends the stored order id and token", async () => {
  const { provider, calls } = makeProvider({ order: { status: "PENDING" } });
  await provider.getStatus(BASE_ORDER);
  assert.deepEqual(calls[0].body, { id: "ORDER1", token: "TOKEN1" });
  assert.equal(
    calls[0].headers["X-API-SIGN"],
    createHmac("sha256", API_SECRET).update(calls[0].rawBody).digest("hex"),
  );
});

test("getStatus labels unrecognized statuses provider_status_unrecognized", async () => {
  // L14 fix: an unknown status is not a provider-reported emergency — it gets
  // its own attention reason so operators land on the right runbook section.
  const order = await statusFor({ status: "SOMETHING_NEW" });
  assert.equal(order.state, "attention");
  assert.equal(order.attention, true);
  assert.equal(order.attention_reason, "provider_status_unrecognized");
});

test("getStatus maps DONE with a refund transaction to refunded", async () => {
  const order = await statusFor(
    { status: "DONE", back: { amount: "12.3", tx: { id: "refund-tx-1" } } },
    { ...BASE_ORDER, state: "refund_pending", refund_reason: "underpaid" },
  );
  assert.equal(order.state, "refunded");
  assert.equal(order.refund_tx_id, "refund-tx-1");
  assert.equal(order.refund_amount, "12.3");
  // The refund reason established earlier in the lifecycle is retained.
  assert.equal(order.refund_reason, "underpaid");
});

test("getStatus maps EMERGENCY responses onto the refund and attention paths", async () => {
  const cases = [
    {
      name: "underpaid, no choice yet",
      emergency: { status: ["LESS"] },
      expected: { state: "refund_required", refund_reason: "underpaid" },
    },
    {
      name: "late deposit, no choice yet",
      emergency: { status: ["EXPIRED"] },
      expected: { state: "refund_required", refund_reason: "late_deposit" },
    },
    {
      name: "underpaid and late",
      emergency: { status: ["LESS", "EXPIRED"] },
      expected: { state: "refund_required", refund_reason: "underpaid_and_late" },
    },
    {
      name: "refund chosen, not yet paid out",
      emergency: { choice: "REFUND", status: ["EXPIRED"] },
      expected: { state: "refund_pending", refund_reason: "late_deposit" },
    },
    {
      name: "exchange chosen",
      emergency: { choice: "EXCHANGE", status: ["LESS"] },
      expected: { state: "attention", attention_reason: "provider_reported_emergency" },
    },
    {
      // The provider refunds an overpay in full — same self-serve path as an
      // underpay, not a support ticket.
      name: "overpaid",
      emergency: { status: ["MORE", "LIMIT"] },
      expected: { state: "refund_required", refund_reason: "overpaid" },
    },
    {
      name: "overpaid and late",
      emergency: { status: ["MORE", "EXPIRED"] },
      expected: { state: "refund_required", refund_reason: "overpaid_and_late" },
    },
  ];
  for (const { name, emergency, expected } of cases) {
    const order = await statusFor({ status: "EMERGENCY", emergency });
    assert.equal(order.state, expected.state, name);
    assert.equal(order.refund_reason, expected.refund_reason, name);
    assert.equal(order.attention_reason, expected.attention_reason, name);
    assert.equal(order.attention, expected.state === "attention" ? true : undefined, name);
  }
});

test("getStatus maps a paid-out emergency refund to refunded", async () => {
  const order = await statusFor({
    status: "EMERGENCY",
    emergency: { choice: "REFUND", status: ["LESS"] },
    back: { amount: "11.9", tx: { id: "refund-tx-2" } },
  });
  assert.equal(order.state, "refunded");
  assert.equal(order.refund_reason, "underpaid");
  assert.equal(order.refund_tx_id, "refund-tx-2");
  assert.equal(order.refund_amount, "11.9");
});

test("getStatus surfaces repeat deposits, received amounts, and tx ids", async () => {
  const order = await statusFor({
    status: "EMERGENCY",
    emergency: { status: ["LESS"], repeat: "1" },
    from: { tx: { id: "deposit-tx-1", amount: "6.25" } },
  });
  assert.equal(order.state, "refund_required");
  assert.equal(order.emergency_repeat, true);
  assert.equal(order.deposit_tx_id, "deposit-tx-1");
  assert.equal(order.deposit_received_amount, "6.25");
});

test("requestRefund posts the REFUND choice with the refund address", async () => {
  const { provider, calls } = makeProvider({ emergency: {} });
  await provider.requestRefund(BASE_ORDER, TRX_ADDRESS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "emergency");
  assert.deepEqual(calls[0].body, {
    id: "ORDER1",
    token: "TOKEN1",
    choice: "REFUND",
    address: TRX_ADDRESS,
  });
  assert.equal(
    calls[0].headers["X-API-SIGN"],
    createHmac("sha256", API_SECRET).update(calls[0].rawBody).digest("hex"),
  );
});

test("HTTP failures surface as FixedFloatApiError with status and message", async () => {
  const { provider } = makeProvider({
    order: () => Response.json({ code: 1, msg: "Internal error" }, { status: 500 }),
  });
  await assert.rejects(provider.getStatus(BASE_ORDER), (error) => {
    assert.equal(error.name, "FixedFloatApiError");
    assert.equal(error.kind, "http");
    assert.equal(error.status, 500);
    assert.equal(error.path, "order");
    assert.equal(error.message, "FixedFloat order failed with HTTP 500: Internal error");
    return true;
  });
});

test("API envelope errors surface the FixedFloat message", async () => {
  const { provider } = makeProvider({
    order: () => Response.json({ code: 1, msg: "Invalid order" }),
  });
  await assert.rejects(provider.getStatus(BASE_ORDER), (error) => {
    assert.equal(error.name, "FixedFloatApiError");
    assert.equal(error.kind, "api");
    assert.equal(error.fixedFloatCode, 1);
    assert.equal(error.message, "Invalid order");
    return true;
  });
});

test("invalid JSON, network, and timeout failures map to their error kinds", async () => {
  const invalidJson = makeProvider({ order: () => new Response("<html>oops</html>") });
  await assert.rejects(invalidJson.provider.getStatus(BASE_ORDER), (error) => {
    assert.equal(error.name, "FixedFloatApiError");
    assert.equal(error.kind, "invalid_json");
    return true;
  });

  const network = makeProvider({
    order: () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(network.provider.getStatus(BASE_ORDER), (error) => {
    assert.equal(error.name, "FixedFloatApiError");
    assert.equal(error.kind, "network");
    return true;
  });

  const timeout = makeProvider({
    order: () => {
      throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    },
  });
  await assert.rejects(timeout.provider.getStatus(BASE_ORDER), (error) => {
    assert.equal(error.name, "FixedFloatApiError");
    assert.equal(error.kind, "timeout");
    assert.equal(error.message, "FixedFloat order request timed out.");
    return true;
  });
});

test("HTTP 429 marks the weight budget rate limited", async () => {
  const { provider } = makeProvider({
    order: () => Response.json({ code: 1, msg: "Too many requests" }, { status: 429 }),
  });
  const reserved = [];
  let rateLimited = 0;
  provider.attachWeightBudget({
    reserve: async (path) => {
      reserved.push(path);
    },
    markRateLimited: async () => {
      rateLimited += 1;
    },
  });
  await assert.rejects(provider.getStatus(BASE_ORDER), (error) => {
    assert.equal(error.name, "FixedFloatApiError");
    assert.equal(error.kind, "rate_limited");
    assert.equal(error.status, 429);
    return true;
  });
  assert.deepEqual(reserved, ["order"]);
  assert.equal(rateLimited, 1);
});

// The weight window rolls; the 429 backoff does NOT ride along with it. A 429
// marked at second 59 was forgiven one second later, so a rate-limited provider
// could be hammered again almost immediately.
test("a rate-limit backoff outlives the weight window it started in", async () => {
  let now = 1_000;
  const budget = new SwapProviderWeightBudget(
    "fixedfloat",
    () => now,
    FIXEDFLOAT_SWAP_PROVIDER_LIMITS,
  );
  await budget.reserve("order");
  now = 1_059;
  await budget.markRateLimited();
  await assert.rejects(() => budget.reserve("order"), /in backoff until/);

  // Window rolls at second 60 and clears the used weight...
  now = 1_061;
  const denied = await budget.reserve("create").then(
    () => undefined,
    (error) => error,
  );
  assert.match(String(denied?.message), /in backoff until/);
  assert.equal(denied?.denial?.reason, "backoff");

  // ...and the backoff expires on its own clock (1_059 + 60).
  now = 1_120;
  await budget.reserve("create");
});

// --- provider limits: only FixedFloat's own host is counted locally ----------

test("only FixedFloat's own host is counted locally; every other host only obeys its 429", () => {
  for (const url of ["https://ff.io", "https://ff.io/", "https://api.ff.io/v2", "https://FF.IO"]) {
    assert.equal(swapProviderLimitsForBaseUrl(url), FIXEDFLOAT_SWAP_PROVIDER_LIMITS, url);
  }
  for (const url of [
    "https://lightning-swap.com",
    "https://swap.example/v1",
    "http://127.0.0.1:18080",
    // A look-alike host is not FixedFloat.
    "https://evil-ff.io",
    "https://ff.io.example",
    "not a url",
  ]) {
    assert.equal(swapProviderLimitsForBaseUrl(url), PROVIDER_ONLY_SWAP_PROVIDER_LIMITS, url);
  }
  assert.equal(
    fixedFloatProvider({ key: "k", secret: "s", baseUrl: "https://lightning-swap.com" }).limits
      .profile,
    "provider-only",
  );
  assert.equal(fixedFloatProvider({ key: "k", secret: "s" }).limits.profile, "fixedfloat");
});

test("a FixedFloat guard allows four creates a minute when nothing else ran", async () => {
  let now = 1_000;
  const budget = new SwapProviderWeightBudget(
    "fixedfloat",
    () => now,
    FIXEDFLOAT_SWAP_PROVIDER_LIMITS,
  );
  for (let index = 0; index < 4; index += 1) await budget.reserve("create");
  await assert.rejects(() => budget.reserve("create"), /weight budget exhausted \(200\+50 > 200\)/);
  now += 60;
  await budget.reserve("create");
});

test("on FixedFloat, status calls can no longer starve new swaps", async () => {
  const budget = new SwapProviderWeightBudget(
    "fixedfloat",
    () => 1_000,
    FIXEDFLOAT_SWAP_PROVIDER_LIMITS,
  );
  // Fifty status polls spend the share the calls that are not creates have.
  for (let index = 0; index < 50; index += 1) await budget.reserve("order");
  const denied = await budget.reserve("order").then(
    () => undefined,
    (error) => error,
  );
  assert.match(String(denied?.message), /calls other than creates exhausted \(50\+1 > 50\)/);
  assert.deepEqual(
    [denied?.denial?.reason, denied?.denial?.used, denied?.denial?.gate],
    ["exhausted", 50, 50],
  );
  // Three payers can still start a swap this minute.
  for (let index = 0; index < 3; index += 1) await budget.reserve("create");
  await assert.rejects(() => budget.reserve("create"), /weight budget exhausted/);
});

test("the guard counts nothing for any other provider, however many calls", async () => {
  for (const limits of [undefined, PROVIDER_ONLY_SWAP_PROVIDER_LIMITS]) {
    const budget = new SwapProviderWeightBudget("lightning-swap-com", () => 1_000, limits);
    for (let index = 0; index < 500; index += 1) await budget.reserve("create");
    for (let index = 0; index < 2_000; index += 1) await budget.reserve("order");
    await budget.assertAvailable("create");
  }
});

test("asking whether a create is available uses no budget", async () => {
  const budget = new SwapProviderWeightBudget(
    "fixedfloat",
    () => 1_000,
    FIXEDFLOAT_SWAP_PROVIDER_LIMITS,
  );
  for (let index = 0; index < 10; index += 1) await budget.assertAvailable("create");
  for (let index = 0; index < 4; index += 1) await budget.reserve("create");
  await assert.rejects(() => budget.assertAvailable("create"), /weight budget exhausted/);
});

test("another provider's 429 on a create stops creates for the wait it names, and nothing else", async () => {
  let now = 1_000;
  const budget = new SwapProviderWeightBudget(
    "lightning-swap-com",
    () => now,
    PROVIDER_ONLY_SWAP_PROVIDER_LIMITS,
  );
  await budget.markRateLimited({ path: "create", retryAfterSeconds: 12 });
  const denied = await budget.reserve("create").then(
    () => undefined,
    (error) => error,
  );
  assert.equal(denied?.denial?.reason, "backoff");
  assert.equal(denied?.denial?.backoff_until, 1_012);
  // A guard that counts nothing reports no counts.
  assert.equal(denied?.denial?.used, undefined);
  assert.equal(denied?.denial?.gate, undefined);
  await budget.reserve("order");
  now = 1_012;
  await budget.reserve("create");

  // A 429 on any other call means the account's API budget is spent: all stop.
  await budget.markRateLimited({ path: "order", retryAfterSeconds: 30 });
  await assert.rejects(() => budget.reserve("order"), /in backoff until 1042/);
  await assert.rejects(() => budget.reserve("create"), /in backoff until 1042/);

  // No wait named (the unpaid-swaps-open limit): one minute. A day-long wait
  // is retried after five minutes, because the provider can lift it sooner.
  now = 2_000;
  await budget.markRateLimited({ path: "create" });
  await assert.rejects(() => budget.reserve("create"), /in backoff until 2060/);
  now = 3_000;
  await budget.markRateLimited({ path: "create", retryAfterSeconds: 86_000 });
  await assert.rejects(() => budget.reserve("create"), /in backoff until 3300/);
});

test("a FixedFloat 429 stops every call for at least a minute, longer when it says so", async () => {
  let now = 1_000;
  const budget = new SwapProviderWeightBudget(
    "fixedfloat",
    () => now,
    FIXEDFLOAT_SWAP_PROVIDER_LIMITS,
  );
  await budget.markRateLimited({ path: "create", retryAfterSeconds: 5 });
  await assert.rejects(() => budget.reserve("order"), /in backoff until 1060/);
  now = 2_000;
  await budget.markRateLimited({ path: "create", retryAfterSeconds: 600 });
  await assert.rejects(() => budget.reserve("order"), /in backoff until 2600/);
  now = 5_000;
  await budget.markRateLimited({ retryAfterSeconds: 999_999 });
  await assert.rejects(() => budget.reserve("order"), /in backoff until 8600/);
});

test("a 429 hands the guard the path and the provider's own wait", async () => {
  const notices = [];
  const attach = (provider) =>
    provider.attachWeightBudget({
      reserve: async () => {},
      markRateLimited: async (notice) => {
        notices.push(notice);
      },
    });
  // Lightning Swap answers a refused create with Retry-After and a body.
  const header = makeProvider({
    order: () =>
      Response.json(
        { code: 429, msg: "Rate limit", data: null },
        { status: 429, headers: { "Retry-After": "17" } },
      ),
  });
  attach(header.provider);
  await assert.rejects(header.provider.getStatus(BASE_ORDER), { kind: "rate_limited" });
  const body = makeProvider({
    order: () =>
      Response.json(
        { code: 429, msg: "Rate limit", data: { errors: ["RATE_LIMIT"], retry_after: 41 } },
        { status: 429 },
      ),
  });
  attach(body.provider);
  await assert.rejects(body.provider.getStatus(BASE_ORDER), { kind: "rate_limited" });
  const bare = makeProvider({
    order: () => Response.json({ code: 1, msg: "Too many requests" }, { status: 429 }),
  });
  attach(bare.provider);
  await assert.rejects(bare.provider.getStatus(BASE_ORDER), { kind: "rate_limited" });
  assert.deepEqual(notices, [
    { path: "order", retryAfterSeconds: 17 },
    { path: "order", retryAfterSeconds: 41 },
    { path: "order" },
  ]);
});

test("a create the guard would refuse is refused before an invoice is made", async () => {
  let invoices = 0;
  let creates = 0;
  const client = createTestkitReceiveClient({ now: () => NOW });
  const makeInvoice = client.makeInvoice.bind(client);
  client.makeInvoice = async (...args) => {
    invoices += 1;
    return makeInvoice(...args);
  };
  let budget;
  const logs = [];
  const service = await createOpenReceive({
    client,
    clock: () => NOW,
    logLevel: "warn",
    logger: (entry) => logs.push(entry),
    swap: {
      provider: {
        name: "fixedfloat",
        limits: FIXEDFLOAT_SWAP_PROVIDER_LIMITS,
        supportedPayInAssets: async () => new Set(["USDT_TRON"]),
        invoiceExpirySeconds: () => 1800,
        attachWeightBudget: (attached) => {
          budget = attached;
        },
        assertCreateAvailable: () => budget.assertAvailable("create"),
        createSwap: async () => {
          creates += 1;
          throw new Error("the provider must not be asked");
        },
      },
    },
  });
  for (let index = 0; index < 4; index += 1) await budget.reserve("create");
  const request = {
    reference: "order-busy",
    amount: { currency: "SAT", value: "20000" },
    payInAsset: "USDT_TRON",
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(service.createSwap(request), (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.message, "The swap provider is rate limited. Please try again shortly.");
      return true;
    });
  }
  assert.equal(invoices, 0);
  assert.equal(creates, 0);
  // Two refusals, one log line: status polls must not bury the log.
  const refusals = logs.filter((entry) => entry.event === "swap.provider.rate_limited");
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].reason, "exhausted");
});

test("another provider's create stand-off refuses a new swap before an invoice is made", async () => {
  let invoices = 0;
  let creates = 0;
  const client = createTestkitReceiveClient({ now: () => NOW });
  const makeInvoice = client.makeInvoice.bind(client);
  client.makeInvoice = async (...args) => {
    invoices += 1;
    return makeInvoice(...args);
  };
  let budget;
  const logs = [];
  const service = await createOpenReceive({
    client,
    clock: () => NOW,
    logLevel: "warn",
    logger: (entry) => logs.push(entry),
    swap: {
      // No limits: a provider this library does not know is never counted.
      provider: {
        name: "lightning-swap-com",
        supportedPayInAssets: async () => new Set(["USDT_TRON"]),
        invoiceExpirySeconds: () => 1800,
        attachWeightBudget: (attached) => {
          budget = attached;
        },
        assertCreateAvailable: () => budget.assertAvailable("create"),
        createSwap: async () => {
          creates += 1;
          throw new Error("the provider must not be asked");
        },
      },
    },
  });
  // However many calls this process made, nothing is refused locally...
  for (let index = 0; index < 500; index += 1) await budget.reserve("create");
  for (let index = 0; index < 2_000; index += 1) await budget.reserve("order");
  // ...until the provider answers a create with 429.
  await budget.markRateLimited({ path: "create", retryAfterSeconds: 20 });
  await assert.rejects(
    service.createSwap({
      reference: "order-busy",
      amount: { currency: "SAT", value: "20000" },
      payInAsset: "USDT_TRON",
    }),
    (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.message, "The swap provider is rate limited. Please try again shortly.");
      return true;
    },
  );
  assert.equal(invoices, 0);
  assert.equal(creates, 0);
  const refusals = logs.filter((entry) => entry.event === "swap.provider.rate_limited");
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].reason, "backoff");
  assert.equal(refusals[0].backoff_until, NOW + 20);
  assert.equal(refusals[0].used, undefined);
  // Status and refund calls for swaps that already exist keep going.
  await budget.reserve("order");
  await budget.reserve("emergency");
});
