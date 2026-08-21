import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeOpenReceiveEvent } from "../packages/js/node/src/index.ts";
import { redactSecrets } from "../packages/js/node/src/service/logging.ts";

// Every log line passes through sanitizeOpenReceiveEvent. These fixtures are
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
  const sanitized = sanitizeOpenReceiveEvent({
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
