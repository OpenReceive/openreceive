import assert from "node:assert/strict";
import test from "node:test";
import {
  defineOpenReceiveElements,
  formatMsats,
  renderOpenReceiveCheckoutHtml
} from "@openreceive/elements";

test("elements render display-safe checkout HTML", () => {
  const html = renderOpenReceiveCheckoutHtml({
    invoice: "lnbc-test",
    payment_hash: "a".repeat(64),
    amount_msats: 200000,
    transaction_state: "pending"
  });

  assert.match(html, /lightning:lnbc-test/);
  assert.match(html, /200 sats/);
  assert.match(html, /pending/);
  assert.match(html, /aaaaaaaa\.\.\.aaaaaaaa/);
});

test("elements escape invoice text and reject NWC strings", () => {
  const html = renderOpenReceiveCheckoutHtml({
    invoice: "lnbc-test<&"
  });

  assert.match(html, /lnbc-test&lt;&amp;/);
  assert.throws(
    () =>
      renderOpenReceiveCheckoutHtml({
        invoice: `nostr+walletconnect://${"a".repeat(64)}?secret=${"b".repeat(64)}`
      }),
    /must not be an NWC/
  );
});

test("elements format sat and msat amounts", () => {
  assert.equal(formatMsats(1000), "1 sat");
  assert.equal(formatMsats(2000), "2 sats");
  assert.equal(formatMsats(1500), "1500 msats");
  assert.throws(() => formatMsats(-1), /non-negative safe integer/);
});

test("elements definition fails clearly without DOM custom elements", () => {
  assert.throws(
    () =>
      defineOpenReceiveElements({
        registry: undefined
      }),
    /Custom elements are unavailable/
  );
});
