import assert from "node:assert/strict";
import test from "node:test";
import {
  clearOrderAccessTokens,
  createOpenReceiveCheckoutSession,
  createOpenReceiveStatusFetcher,
  getOrderAccessToken,
  OPENRECEIVE_DEFAULT_PREFIX,
  orderAccessTokenHeaders,
  postOpenReceiveJson,
  rememberOrderAccessToken,
  requestCheckout,
  requestOrderSummary,
  requestPrepareCheckout,
  resolveOrderSummaryUrlFromPrefix,
  resolveOrderUrlFromPrefix,
  sanitizeBrowserLogEntry,
  startOpenReceiveSwapRequest,
  isOpenReceiveSwapAddressPreparingError,
} from "../../packages/js/browser/src/internal.ts";

const PAYMENT_HASH = "a".repeat(64);

// The mounted create route responds `{ checkout: <snapshot>, order_access_token? }`.
function mountedCreateResponse(orderId, token) {
  return {
    ok: true,
    json: async () => ({
      checkout: {
        checkout_id: `or_chk_${orderId}`,
        order_id: orderId,
        status: "open",
        amount_msats: 200000,
        active: {
          invoice_id: `or_inv_${orderId}`,
          invoice: `lnbc-${orderId}`,
          rail: "lightning",
          payment_hash: PAYMENT_HASH,
          amount_msats: 200000,
          order_id: orderId,
          transaction_state: "pending",
          workflow_state: "invoice_created",
        },
        invoices: [],
      },
      ...(token === undefined ? {} : { order_access_token: token }),
    }),
  };
}

function okStatusResponse(orderId) {
  return {
    ok: true,
    json: async () => ({
      checkout_id: `or_chk_${orderId}`,
      order_id: orderId,
      status: "open",
      amount_msats: 200000,
      active: {
        invoice_id: `or_inv_${orderId}`,
        invoice: `lnbc-${orderId}`,
        rail: "lightning",
        payment_hash: PAYMENT_HASH,
        amount_msats: 200000,
        order_id: orderId,
        transaction_state: "pending",
        workflow_state: "invoice_created",
      },
      invoices: [],
    }),
  };
}

test("requestCheckout with prefix stores the per-order token and it rides status + swap automatically", async () => {
  clearOrderAccessTokens();
  const orderId = "order-prefix-flow";
  const createRequests = [];

  const checkout = await requestCheckout({
    prefix: "/openreceive",
    orderId,
    amount: { currency: "USD", value: "10.00" },
    fetch: async (url, init) => {
      createRequests.push({ url, init });
      return mountedCreateResponse(orderId, "tok_abc");
    },
  });

  // prefix derived the create URL, the nested `checkout` snapshot was normalized, and the
  // token was captured — without the token appearing in the returned snapshot.
  assert.equal(createRequests[0].url, "/openreceive/checkouts");
  assert.equal(checkout.checkout_id, "or_chk_order-prefix-flow");
  assert.equal(checkout.order_id, orderId);
  assert.equal("order_access_token" in checkout, false);
  assert.equal(getOrderAccessToken(orderId), "tok_abc");

  // A status poll for that order carries the token with no caller change.
  const statusRequests = [];
  const refresh = createOpenReceiveStatusFetcher({
    orderUrl: "/openreceive/orders/{order_id}",
    fetch: async (url, init) => {
      statusRequests.push({ url, init });
      return okStatusResponse(orderId);
    },
  });
  await refresh(orderId);
  assert.equal(statusRequests[0].url, "/openreceive/orders/order-prefix-flow");
  assert.equal(statusRequests[0].init.headers.Authorization, "Bearer tok_abc");

  // A swap action (quote/start/refund all flow through postOpenReceiveJson) carries it too.
  const swapRequests = [];
  await postOpenReceiveJson(
    async (url, init) => {
      swapRequests.push({ url, init });
      return { ok: true, json: async () => ({ ok: true }) };
    },
    "/openreceive/orders/order-prefix-flow",
    { order_id: orderId, action: "swap_quote", pay_in_asset: "USDT_TRON" },
  );
  assert.equal(swapRequests[0].init.headers.Authorization, "Bearer tok_abc");

  clearOrderAccessTokens();
});

test("requestCheckout with just { prefix, orderId } POSTs only { order_id } (no amount)", async () => {
  clearOrderAccessTokens();
  const orderId = "ord-1";
  const requests = [];

  const checkout = await requestCheckout({
    prefix: "/openreceive",
    orderId,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return mountedCreateResponse(orderId, "tok_noamount");
    },
  });

  // The mounted server's prepareCheckout persist owns the price, so the body is order_id only — no amount.
  assert.equal(requests[0].url, "/openreceive/checkouts");
  assert.deepEqual(JSON.parse(requests[0].init.body), { order_id: "ord-1" });
  assert.equal(checkout.order_id, orderId);

  clearOrderAccessTokens();
});

test("requestPrepareCheckout POSTs to {prefix}/prepare and returns order_id + summary", async () => {
  const requests = [];
  const result = await requestPrepareCheckout({
    prefix: "/openreceive",
    body: { cart: { sku: "demo" } },
    fetch: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          order_id: "ord-prep-1",
          summary: { title: "Demo" },
        }),
      };
    },
  });

  assert.equal(requests[0].url, "/openreceive/prepare");
  assert.equal(requests[0].init.method, "POST");
  assert.deepEqual(JSON.parse(requests[0].init.body), { cart: { sku: "demo" } });
  assert.deepEqual(result, { order_id: "ord-prep-1", summary: { title: "Demo" } });
});

test("requestOrderSummary GETs {prefix}/orders/{id}/summary", async () => {
  const requests = [];
  const result = await requestOrderSummary({
    prefix: "/openreceive",
    orderId: "ord-sum-1",
    fetch: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          order_id: "ord-sum-1",
          summary: { items: [] },
        }),
      };
    },
  });

  assert.equal(requests[0].url, "/openreceive/orders/ord-sum-1/summary");
  assert.equal(requests[0].init.method, "GET");
  assert.deepEqual(result, { order_id: "ord-sum-1", summary: { items: [] } });

  const missing = await requestOrderSummary({
    orderId: "missing",
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  });
  assert.equal(missing, undefined);
});

test("resolveOrderSummaryUrlFromPrefix derives the summary route", () => {
  assert.equal(
    resolveOrderSummaryUrlFromPrefix("/openreceive", "ord-1"),
    "/openreceive/orders/ord-1/summary",
  );
});

test("resolveOrderUrlFromPrefix derives the order route and OPENRECEIVE_DEFAULT_PREFIX is /openreceive", () => {
  assert.equal(resolveOrderUrlFromPrefix("/openreceive", "ord-1"), "/openreceive/orders/ord-1");
  // trailing slash on the prefix is stripped
  assert.equal(resolveOrderUrlFromPrefix("/openreceive/", "ord-1"), "/openreceive/orders/ord-1");
  assert.equal(OPENRECEIVE_DEFAULT_PREFIX, "/openreceive");
});

test("createOpenReceiveCheckoutSession creates then polls the order route with the auto-attached token", async () => {
  clearOrderAccessTokens();
  const orderId = "ord-1";
  const createRequests = [];
  const statusRequests = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith("/checkouts")) {
      createRequests.push({ url, init });
      return mountedCreateResponse(orderId, "tok_session");
    }
    statusRequests.push({ url, init });
    return okStatusResponse(orderId);
  };

  const session = await createOpenReceiveCheckoutSession({
    prefix: "/openreceive",
    orderId,
    fetch: fetchImpl,
    // Stub timers so start() does not schedule real polling in the test.
    setInterval: () => 0,
    clearInterval: () => {},
  });

  // Create POSTed { order_id } to the derived create route; the session exposes the order route.
  assert.equal(createRequests[0].url, "/openreceive/checkouts");
  assert.deepEqual(JSON.parse(createRequests[0].init.body), { order_id: "ord-1" });
  assert.equal(session.orderUrl, "/openreceive/orders/ord-1");
  assert.equal(session.checkout.order_id, orderId);

  // The ready-to-start controller polls the order route with the captured token attached.
  session.controller.start();
  await session.controller.reloadState();
  session.controller.stop();
  assert.equal(statusRequests[0].url, "/openreceive/orders/ord-1");
  assert.equal(statusRequests[0].init.headers.Authorization, "Bearer tok_session");

  clearOrderAccessTokens();
});

test("createOpenReceiveCheckoutSession defaults the prefix to /openreceive", async () => {
  clearOrderAccessTokens();
  const orderId = "ord-default";
  const createRequests = [];

  const session = await createOpenReceiveCheckoutSession({
    orderId,
    fetch: async (url, init) => {
      createRequests.push({ url, init });
      return mountedCreateResponse(orderId, undefined);
    },
    setInterval: () => 0,
    clearInterval: () => {},
  });

  assert.equal(createRequests[0].url, "/openreceive/checkouts");
  assert.equal(session.orderUrl, "/openreceive/orders/ord-default");
  session.controller.stop();

  clearOrderAccessTokens();
});

test("prefix derives the checkout URL (trailing slash stripped) and explicit checkoutUrl wins", async () => {
  clearOrderAccessTokens();

  const derived = [];
  await requestCheckout({
    prefix: "/openreceive/",
    orderId: "order-derive",
    amount: { currency: "USD", value: "5.00" },
    fetch: async (url) => {
      derived.push(url);
      return mountedCreateResponse("order-derive", undefined);
    },
  });
  assert.equal(derived[0], "/openreceive/checkouts");

  const explicit = [];
  await requestCheckout({
    prefix: "/openreceive",
    checkoutUrl: "/custom/create",
    orderId: "order-explicit",
    amount: { currency: "USD", value: "5.00" },
    fetch: async (url) => {
      explicit.push(url);
      return mountedCreateResponse("order-explicit", undefined);
    },
  });
  assert.equal(explicit[0], "/custom/create");

  clearOrderAccessTokens();
});

test("no token stored: no Authorization header is added and nothing crashes", async () => {
  clearOrderAccessTokens();
  const orderId = "order-untokened";

  assert.equal(getOrderAccessToken(orderId), undefined);
  assert.equal(orderAccessTokenHeaders(orderId), undefined);
  assert.equal(orderAccessTokenHeaders(undefined), undefined);

  const statusRequests = [];
  const refresh = createOpenReceiveStatusFetcher({
    orderUrl: "/openreceive/orders/{order_id}",
    fetch: async (url, init) => {
      statusRequests.push({ url, init });
      return okStatusResponse(orderId);
    },
  });
  await refresh(orderId);
  assert.equal("Authorization" in statusRequests[0].init.headers, false);
  assert.equal(statusRequests[0].init.headers["Content-Type"], "application/json");

  const swapRequests = [];
  await postOpenReceiveJson(
    async (url, init) => {
      swapRequests.push({ url, init });
      return { ok: true, json: async () => ({ ok: true }) };
    },
    "/openreceive/orders/order-untokened",
    { order_id: orderId, action: "swap_quote", pay_in_asset: "USDT_TRON" },
  );
  assert.equal("Authorization" in swapRequests[0].init.headers, false);

  clearOrderAccessTokens();
});

test("an explicit Authorization header overrides the auto-attached token", async () => {
  clearOrderAccessTokens();
  const orderId = "order-override";
  rememberOrderAccessToken(orderId, "tok_auto");

  const swapRequests = [];
  await postOpenReceiveJson(
    async (url, init) => {
      swapRequests.push({ url, init });
      return { ok: true, json: async () => ({ ok: true }) };
    },
    "/openreceive/orders/order-override",
    { order_id: orderId },
    { Authorization: "Bearer tok_explicit" },
  );
  assert.equal(swapRequests[0].init.headers.Authorization, "Bearer tok_explicit");

  clearOrderAccessTokens();
});

test("the per-order token never appears in a sanitized log entry (redaction)", async () => {
  clearOrderAccessTokens();
  const orderId = "order-redact";
  rememberOrderAccessToken(orderId, "tok_secret_value");

  // Capture a real status request so we log exactly what the client would send.
  let logged;
  const refresh = createOpenReceiveStatusFetcher({
    orderUrl: "/openreceive/orders/{order_id}",
    fetch: async (url, init) => {
      logged = { url, init };
      return okStatusResponse(orderId);
    },
  });
  await refresh(orderId);
  assert.equal(logged.init.headers.Authorization, "Bearer tok_secret_value");

  const sanitized = sanitizeBrowserLogEntry({
    level: "debug",
    event: "checkout.status.request",
    message: "Posting order status refresh.",
    request: { url: logged.url, method: logged.init.method, headers: logged.init.headers },
  });

  // The Authorization key is redacted and the token string is nowhere in the entry.
  assert.equal(sanitized.request.headers.Authorization, "[REDACTED]");
  assert.equal(JSON.stringify(sanitized).includes("tok_secret_value"), false);

  clearOrderAccessTokens();
});

test("swap start silently retries soft address-preparing conflicts", async () => {
  assert.equal(
    isOpenReceiveSwapAddressPreparingError(
      new Error("Swap payment address is still being prepared. Retry this swap start shortly."),
    ),
    true,
  );
  assert.equal(isOpenReceiveSwapAddressPreparingError(new Error("Order is already paid.")), false);

  let calls = 0;
  const invoice = await startOpenReceiveSwapRequest(
    async () => {
      calls += 1;
      if (calls < 3) {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            message: "Swap payment address is still being prepared. Retry this swap start shortly.",
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          attempt: {
            shadow_invoice: {
              invoice_id: "or_inv_swap",
              rail: "swap",
              swap: {
                provider: "fixedfloat",
                pay_in_asset: "SOL_SOL",
                provider_state: "waiting_for_deposit",
              },
            },
          },
        }),
      };
    },
    "/openreceive/orders/order-swap",
    "order-swap",
    "SOL_SOL",
  );

  assert.equal(calls, 3);
  assert.equal(invoice.invoice_id, "or_inv_swap");
  assert.equal(invoice.swap?.pay_in_asset, "SOL_SOL");
});
