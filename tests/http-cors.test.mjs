import assert from "node:assert/strict";
import test from "node:test";
import { createOpenReceive } from "../packages/js/node/src/index.ts";
import { createStack } from "../packages/js/http/src/index.ts";
import { createTestkitReceiveClient } from "../packages/js/testkit/src/index.ts";
import { memoryPaymentsDb } from "./helpers/factories.mjs";

// The `cors` option: a checkout whose page is on another origin than the
// routes (a Supabase Edge Function on <ref>.supabase.co, the shop elsewhere).
// The page sends a bearer token, never cookies, and every other origin stays
// refused exactly as without the option.

const SHOP = "https://shop.example";
const TOKEN = "Bearer buyer-token";

async function stack(cors) {
  const service = await createOpenReceive({
    client: createTestkitReceiveClient({ now: () => 1000 }),
    clock: () => 1000,
  });
  return createStack({
    wallet: { service },
    storage: { db: memoryPaymentsDb(), onPaid: async () => undefined },
    amountFor: () => ({ sats: 2100 }),
    // The token a cross-origin page sends; cookies never come with it.
    authorize: ({ request }) => request.headers.get("authorization") === TOKEN,
    ...(cors === undefined ? {} : { cors }),
  });
}

function checkout(headers, body = { reference: "order-1" }) {
  return new Request("https://ref.supabase.co/openreceive/checkouts", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function preflight(origin, method = "POST", path = "/openreceive/checkouts") {
  return new Request(`https://ref.supabase.co${path}`, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": method,
      "access-control-request-headers": "authorization, content-type",
    },
  });
}

const CROSS_SITE = { origin: SHOP, "sec-fetch-site": "cross-site", authorization: TOKEN };

test("without cors, a cross-site request and its preflight are refused as before", async () => {
  const { handler } = await stack();
  const refused = await handler(checkout(CROSS_SITE));
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get("access-control-allow-origin"), null);
  const unanswered = await handler(preflight(SHOP));
  assert.equal(unanswered.status, 405);
  assert.equal(unanswered.headers.get("access-control-allow-origin"), null);
});

test("a listed origin's preflight is answered, with no credentials", async () => {
  const { handler } = await stack({ origins: [SHOP] });
  const answered = await handler(preflight(SHOP));
  assert.equal(answered.status, 204);
  assert.equal(answered.headers.get("access-control-allow-origin"), SHOP);
  assert.match(answered.headers.get("access-control-allow-headers"), /authorization/);
  assert.match(answered.headers.get("access-control-allow-methods"), /POST/);
  assert.match(answered.headers.get("vary"), /Origin/);
  assert.equal(answered.headers.get("access-control-allow-credentials"), null);
});

test("an unlisted origin's preflight is refused, and so is one for no route", async () => {
  const { handler } = await stack({ origins: [SHOP] });
  const stranger = await handler(preflight("https://evil.example"));
  assert.equal(stranger.status, 403);
  assert.equal(stranger.headers.get("access-control-allow-origin"), null);
  assert.equal((await handler(preflight(SHOP, "POST", "/openreceive/nothing"))).status, 404);
});

test("a listed origin's cross-site checkout passes on its token and can read the answer", async () => {
  const { handler } = await stack({ origins: [SHOP] });
  const created = await handler(checkout(CROSS_SITE));
  assert.equal(created.status, 201, await created.clone().text());
  assert.equal(created.headers.get("access-control-allow-origin"), SHOP);
  assert.match(created.headers.get("vary"), /Origin/);
  assert.equal(created.headers.get("access-control-allow-credentials"), null);
  assert.match((await created.json()).checkout.bolt11, /^ln/);

  // No token: authorize refuses, and the page can still read why.
  const refused = await handler(checkout({ origin: SHOP, "sec-fetch-site": "cross-site" }));
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get("access-control-allow-origin"), SHOP);
});

test("an unlisted origin's cross-site request is still refused before the body", async () => {
  const { handler } = await stack({ origins: [SHOP] });
  const refused = await handler(checkout({ ...CROSS_SITE, origin: "https://evil.example" }));
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).message, /Cross-site requests are not accepted/);
  assert.equal(refused.headers.get("access-control-allow-origin"), null);
});

test("a listed origin still sends JSON only, and a same-origin request gets no CORS headers", async () => {
  const { handler } = await stack({ origins: [SHOP] });
  const form = await handler(
    new Request("https://ref.supabase.co/openreceive/checkouts", {
      method: "POST",
      headers: { ...CROSS_SITE, "content-type": "text/plain" },
      body: JSON.stringify({ reference: "order-1" }),
    }),
  );
  assert.equal(form.status, 415);
  const same = await handler(checkout({ authorization: TOKEN }));
  assert.equal(same.status, 201);
  assert.equal(same.headers.get("access-control-allow-origin"), null);
});

test("cors.origins takes exact origins only", async () => {
  for (const origin of [
    "*",
    "shop.example",
    `${SHOP}/`,
    `${SHOP}/checkout`,
    "ftp://shop.example",
  ]) {
    // The stack builds its handler at boot, so a bad origin fails `ready`.
    const { ready } = await stack({ origins: [origin] });
    await assert.rejects(ready, /cors\.origins lists/, origin);
  }
});
