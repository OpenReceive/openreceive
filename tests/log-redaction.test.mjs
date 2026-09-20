import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeEvent } from "../packages/js/node/src/index.ts";
import { redactSecrets } from "../packages/js/node/src/service/logging.ts";

// Every log line passes through sanitizeEvent. These fixtures are
// the shapes credentials actually arrive in: connection URIs pasted into a
// message, provider REST URLs, and provider payloads attached to an error.
const NWC_URI =
  "nostr+walletconnect://f00ff00f?relay=wss://relay.example&secret=deadbeefdeadbeefdeadbeef";
const LSC_URI = "lightning+swapconnect://provider.example/api?key=lsckey123&secret=lscsecret456";
const PREIMAGE = "1".repeat(64);
const BOLT11 = "lnbc10u1pjqtestinvoicepayload";

test("connection URIs are redacted wherever they appear in a log string", () => {
  assert.equal(redactSecrets(`connecting via ${NWC_URI} now`), "connecting via [REDACTED_NWC] now");
  assert.equal(redactSecrets(`configured ${LSC_URI}`), "configured [REDACTED_LSC]");
  // `key=` alone is half an LSC credential pair.
  assert.equal(
    redactSecrets("GET https://provider.example/v2/create?key=lsckey123&choice=1"),
    "GET https://provider.example/v2/create?key=[REDACTED]&choice=1",
  );
});

test("nested credentials, preimages, and invoices never reach a log sink", () => {
  const sanitized = sanitizeEvent({
    level: "error",
    event: "swap.provider.request.failed",
    message: `provider call failed for ${LSC_URI}`,
    connection: NWC_URI,
    api_key: "lsckey123",
    private_key: "lscsecret456",
    provider_error: {
      status: 502,
      payload: {
        bolt11: BOLT11,
        invoice: BOLT11,
        preimage: PREIMAGE,
        nested: [{ apiKey: "lsckey123" }],
      },
    },
  });

  const serialized = JSON.stringify(sanitized);
  for (const secret of ["lsckey123", "lscsecret456", "deadbeef", PREIMAGE, BOLT11]) {
    assert.doesNotMatch(serialized, new RegExp(secret), `${secret} must not reach a log line`);
  }
  // Redaction must not swallow the diagnostic itself.
  assert.equal(sanitized.event, "swap.provider.request.failed");
  assert.equal(sanitized.provider_error.status, 502);
});

test("shared secret-redaction vectors agree at browser, server and public error boundaries", async () => {
  const { readFile } = await import("node:fs/promises");
  const { sanitizeLogValue, publicErrorBody, OpenReceiveError } = await import(
    "../packages/js/core/src/index.ts"
  );
  const { sanitizeBrowserLogEntry } = await import(
    "../packages/js/browser/src/internal/console-logger.ts"
  );
  const { errorResponse, mapHostRouteError, HttpError } = await import(
    "../packages/js/http/src/errors.ts"
  );
  const { normalizeNwcWalletError } = await import("../packages/js/node/src/nwc/errors.ts");
  const vectors = JSON.parse(
    await readFile(new URL("../spec/test-vectors/secret-redaction.json", import.meta.url), "utf8"),
  );
  for (const vector of vectors.vectors) {
    assert.deepEqual(sanitizeLogValue(vector.input), vector.expected, vector.name);
    assert.deepEqual(
      sanitizeBrowserLogEntry({
        level: "error",
        event: "fixture",
        message: "fixture",
        data: vector.input,
      }).data,
      vector.expected,
      vector.name,
    );
    const body = {
      code: "WALLET_UNAVAILABLE",
      message: typeof vector.input === "string" ? vector.input : "Fixture outage",
      retryable: true,
      details: {
        data: vector.input,
        cause: { message: "internal" },
        stack: "private",
        configuration: { token: "invalid-token" },
      },
    };
    const expected = publicErrorBody(body);
    for (const error of [
      new HttpError(503, body.code, body.message, { retryable: true, details: body.details }),
      { status: 503, body },
      new OpenReceiveError(body),
    ]) {
      const response = await errorResponse(error, "req_fixture").json();
      assert.equal(response.message, expected.message);
      if (response.details !== undefined) assert.deepEqual(response.details, expected.details);
    }
    assert.deepEqual(normalizeNwcWalletError(new OpenReceiveError(body)).toJSON(), expected);
    assert.deepEqual(mapHostRouteError({ status: 503, body }).body, expected);
    assert.deepEqual(body.details.data, vector.input, "projection must not mutate source");
  }
});
