import assert from "node:assert/strict";
import test from "node:test";
import {
  bannedPayerWords,
  bannedPayerWordsInContext,
  checkoutFiatCents,
  formatCents,
  isPayerSentence,
  parsePriceCents,
  relayHostsOf,
  saysPaid,
} from "../trials/harness/payer.ts";

test("the words check flags what the 0.4.32 videos showed the payer", () => {
  assert.deepEqual(bannedPayerWords("Configured NWC relays are unavailable."), ["NWC", "relay"]);
  assert.deepEqual(bannedPayerWords("Payment received\nBackend settlement verified."), [
    "backend",
    "settlement verified",
    "settlement",
  ]);
  // 0.4.32's badge and waiting line (2026-11-08 reviews).
  assert.deepEqual(bannedPayerWords("Payment received\nsettled"), ["settled"]);
  assert.deepEqual(bannedPayerWords("Keep this page open while we verify settlement."), [
    "settlement",
  ]);
  assert.deepEqual(
    bannedPayerWords("Could not prepare the payment address\nInternal server error."),
    ["Internal server error"],
  );
  assert.deepEqual(bannedPayerWords("Failed to connect to wss://relay-nwc.rizful.com/v1"), [
    "NWC",
    "relay",
  ]);
  assert.deepEqual(bannedPayerWords("A nostr event timed out"), ["nostr"]);
  assert.deepEqual(bannedPayerWords("Traceback (most recent call last):"), ["traceback"]);
  assert.deepEqual(bannedPayerWords("An exception occurred"), ["exception"]);
  assert.deepEqual(bannedPayerWords("java.lang.NullPointerException"), ["exception"]);
  assert.deepEqual(bannedPayerWords("RuntimeError: Order could not be created."), ["error class"]);
  assert.deepEqual(bannedPayerWords("TypeError: x is not a function"), ["error class"]);
});

test("the words check flags values JavaScript failed to format", () => {
  assert.deepEqual(bannedPayerWords("Amount: undefined sats"), ["undefined"]);
  assert.deepEqual(bannedPayerWords("NaN sats / $7.00 USD"), ["NaN"]);
  assert.deepEqual(bannedPayerWords("Order [object Object]"), ["[object Object]"]);
  assert.deepEqual(bannedPayerWords("Total null"), ["null"]);
});

test("the words check passes the checkout's own payer copy", () => {
  for (const text of [
    "Payment received\nThank you. Your payment is confirmed.",
    "The payment service did not answer in time. Please try again.",
    "Waiting for payment\nKeep this page open while we confirm your payment.",
    "Payment received\nThank you. Your payment is confirmed.\nPaid",
    // The wallet list names swap services; only the videos avoid the words.
    "Boltz\nswap service\nHow To Pay\nFixedFloat\nswap service",
    "Could not prepare the payment address\nThe swap provider refused this request.\nTry again",
    // Words that merely contain a banned one.
    "Exceptional service in Nanaimo, nullable fields, an undefinedness",
    "Error\nSomething went wrong. Please try again.",
  ]) {
    assert.deepEqual(bannedPayerWords(text), [], text);
  }
});

test("the words evidence quotes the words around each hit", () => {
  const [hit] = bannedPayerWordsInContext(
    "Facet\nConfigured NWC relays are unavailable.\nTry again",
  );
  assert.equal(hit, 'NWC: "Facet Configured NWC relays are unavailable. Try again"');
  assert.deepEqual(bannedPayerWordsInContext("Payment received"), []);
});

test("parsePriceCents reads the shop's listing price to the cent", () => {
  assert.equal(parsePriceCents("Facet — $7.00 Buy"), 700);
  assert.equal(parsePriceCents("Bezel — $12.00 USD"), 1200);
  assert.equal(parsePriceCents("$12"), 1200);
  assert.equal(parsePriceCents("$ 9.5"), 950);
  assert.equal(parsePriceCents("US$9.99"), 999);
  assert.equal(parsePriceCents("$1,234.50"), 123450);
  assert.equal(parsePriceCents("USD 7.25"), 725);
  assert.equal(parsePriceCents("Latch 9.00 USD"), 900);
  assert.equal(parsePriceCents("It costs $7."), 700);
  assert.equal(parsePriceCents("Order 6: $48.99"), 4899);
});

test("parsePriceCents refuses what is not a dollar price", () => {
  assert.equal(parsePriceCents("Facet — Buy"), undefined);
  assert.equal(parsePriceCents("Order 7"), undefined);
  assert.equal(parsePriceCents("€7.00"), undefined);
  // Three decimals is not a price to the cent.
  assert.equal(parsePriceCents("$7.005"), undefined);
});

test("checkoutFiatCents prefers the amount beside the sats", () => {
  assert.equal(checkoutFiatCents("Facet\n9,244 sats / $7.00 USD\nBitcoin Lightning invoice"), 700);
  assert.equal(checkoutFiatCents("Minimum amount $7.50\n9,244 sats / $7.00 USD"), 700);
  assert.equal(checkoutFiatCents("1 sat / $0.01 USD"), 1);
  assert.equal(checkoutFiatCents("Total\n$49.00"), 4900);
  assert.equal(checkoutFiatCents("Waiting for payment"), undefined);
});

test("formatCents writes dollars and cents", () => {
  assert.equal(formatCents(4899), "$48.99");
  assert.equal(formatCents(700), "$7.00");
  assert.equal(formatCents(123450), "$1,234.50");
  assert.equal(formatCents(5), "$0.05");
});

test("saysPaid reads a paid screen and not a waiting one", () => {
  assert.equal(saysPaid("Payment received\nThank you. Your payment is confirmed."), true);
  assert.equal(saysPaid("Order 8\nPaid."), true);
  assert.equal(saysPaid("Pay this invoice\nPay via Lightning"), false);
  assert.equal(
    saysPaid("Waiting for payment\nKeep this page open while we verify settlement."),
    false,
  );
  assert.equal(saysPaid("Confirming payment"), false);
});

test("isPayerSentence wants words, not a bare label", () => {
  assert.equal(
    isPayerSentence("The payment service did not answer in time. Please try again."),
    true,
  );
  assert.equal(isPayerSentence("Try again"), false);
  assert.equal(isPayerSentence(""), false);
  assert.equal(isPayerSentence("503 502 500"), false);
});

test("relayHostsOf reads only the relay hosts from a wallet code", () => {
  const code =
    "nostr+walletconnect://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?relay=wss%3A%2F%2FRelay.Example%2Fv1&relay=wss://two.example&secret=71a8c14c1407c113601079c4302dab36460f0ccd0ad506f1f2dc73b5100e4f3c";
  assert.deepEqual(relayHostsOf(code), ["relay.example", "two.example"]);
  assert.deepEqual(relayHostsOf("not a code"), []);
  assert.deepEqual(relayHostsOf("nostr+walletconnect://abc?relay=nonsense"), []);
});
