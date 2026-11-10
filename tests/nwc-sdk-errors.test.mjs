import assert from "node:assert/strict";
import test from "node:test";
import {
  Nip47NetworkError,
  Nip47PublishError,
  Nip47PublishTimeoutError,
  Nip47ReplyTimeoutError,
  Nip47WalletError,
} from "@getalby/sdk/nwc";
import { normalizeNwcWalletError } from "../packages/js/node/src/nwc/errors.ts";

// Found by the trials' chaos phase (2026-11-08, chaos_silent_wallet_answers):
// a relay that accepted the connection and never answered reached the buyer
// as 502 OTHER, retryable false, with "Failed to connect to wss://…" as the
// text. @getalby/sdk throws Nip47NetworkError with code "OTHER" and never sets
// `name`, so only the error's class says the wallet was unreachable.

test("an SDK relay that never connected is WALLET_UNAVAILABLE and retryable", () => {
  const error = new Nip47NetworkError("Failed to connect to wss://relay.example/v1", "OTHER");
  assert.equal(error.name, "Error", "the SDK still sets no name; classify by class");
  const body = normalizeNwcWalletError(error).toJSON();
  assert.equal(body.code, "WALLET_UNAVAILABLE");
  assert.equal(body.retryable, true);
});

test("SDK publish failures and reply timeouts are transport failures, whatever code they carry", () => {
  assert.equal(
    normalizeNwcWalletError(
      new Nip47PublishError(
        "failed to publish: AggregateError: All promises were rejected",
        "INTERNAL",
      ),
    ).toJSON().code,
    "WALLET_UNAVAILABLE",
  );
  assert.equal(
    normalizeNwcWalletError(new Nip47PublishError("Failed to publish: x", "OTHER")).toJSON().code,
    "WALLET_UNAVAILABLE",
  );
  const timeout = normalizeNwcWalletError(
    new Nip47ReplyTimeoutError("reply timeout: event abc", "INTERNAL"),
  ).toJSON();
  assert.equal(timeout.code, "TIMEOUT");
  assert.equal(timeout.retryable, true);
});

// @getalby/sdk 9 gives the relay's own OK wait a second more than the
// client's, so a relay that takes the request and never acknowledges it now
// fails as a publish timeout, where SDK 8 threw a publish error.
test("an SDK relay that never acknowledges a request is a retryable TIMEOUT", () => {
  const body = normalizeNwcWalletError(
    new Nip47PublishTimeoutError("publish timeout: abc", "INTERNAL"),
  ).toJSON();
  assert.equal(body.code, "TIMEOUT");
  assert.equal(body.retryable, true);
  const reworded = normalizeNwcWalletError(new Nip47PublishTimeoutError("no OK came", "OTHER"));
  assert.equal(reworded.toJSON().code, "TIMEOUT");
});

test("an SDK transport error in other words is still classified by its class", () => {
  // The text path only knows today's wording: an unbundled host has the class too.
  const network = normalizeNwcWalletError(new Nip47NetworkError("the relay went away", "OTHER"));
  assert.equal(network.toJSON().code, "WALLET_UNAVAILABLE");
  assert.equal(network.toJSON().retryable, true);
  const timeout = normalizeNwcWalletError(new Nip47ReplyTimeoutError("no reply came", "OTHER"));
  assert.equal(timeout.toJSON().code, "TIMEOUT");
});

test("a bundler renaming the SDK's classes changes nothing: the text says what failed", () => {
  // Next's server build: no class name, code OTHER, the relay URL as the text.
  class a extends Error {
    code = "OTHER";
  }
  const body = normalizeNwcWalletError(
    new a("Failed to connect to wss://relay.example/v1"),
  ).toJSON();
  assert.equal(body.code, "WALLET_UNAVAILABLE");
  assert.equal(body.retryable, true);
});

test("a wallet's own error keeps the wallet's code; an unknown one stays OTHER", () => {
  assert.equal(
    normalizeNwcWalletError(new Nip47WalletError("rate limited", "RATE_LIMITED")).toJSON().code,
    "RATE_LIMITED",
  );
  assert.equal(
    normalizeNwcWalletError(new Nip47WalletError("something odd", "OTHER")).toJSON().code,
    "OTHER",
  );
  assert.equal(normalizeNwcWalletError(new Error("plain")).toJSON().code, "OTHER");
});

// Found by the trials' chaos phase (2026-11-08, chaos_slow_handshakes): the
// SDK's pool gave a relay connection 3 s and every request waits on it, so a
// 3.24 s handshake (measured from a shop container to Rizful's relay) failed
// the buyer's checkout.
test("the SDK client gives a slow relay handshake 8 s, not the pool's 3 s", async () => {
  const { createDefaultAlbyNwcClient } = await import("../packages/js/node/src/nwc/transport.ts");
  const uri =
    "nostr+walletconnect://" +
    "a".repeat(64) +
    "?relay=wss%3A%2F%2Frelay.example%2Fv1&secret=" +
    "1".repeat(64);
  const client = await createDefaultAlbyNwcClient(uri);
  try {
    assert.equal(client.pool.maxWaitForConnection, 8_000);
  } finally {
    client.close?.();
  }
});
