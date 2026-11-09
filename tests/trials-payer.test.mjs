import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { checkoutLabels } from "../packages/js/browser/src/headless.ts";
import { PAYER_PRICES as fossbillingPrices } from "../trials/harness/fossbilling.ts";
import { SWAP_PRODUCT } from "../trials/harness/live.ts";
import { PAYER_PRICES as medusaPrices } from "../trials/harness/medusa.ts";
import { PAYER_PRICES as odooPrices } from "../trials/harness/odoo.ts";
import { hasPayerWalk, payerOrders } from "../trials/harness/payer-orders.ts";
import {
  apiRoute,
  bannedPayerWords,
  bannedPayerWordsInContext,
  memoProblems,
  sameInvoice,
  checkoutFiatCents,
  formatCents,
  isPayerSentence,
  parsePriceCents,
  relayHostsOf,
  saysPaid,
} from "../trials/harness/payer.ts";
import { PAYER_PRICES as paymenterPrices } from "../trials/harness/paymenter.ts";
import { PAYER_PRICES as prestashopPrices } from "../trials/harness/prestashop.ts";
import { PAYER_PRICES as vendurePrices } from "../trials/harness/vendure.ts";

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

// 2026-11-08: a PrestaShop payer read the handler's 403 for the developer, and
// other runs could have shown a field error or a 409's text the same way.
test("the words check flags text written for the developer", () => {
  assert.deepEqual(
    bannedPayerWords(
      "Could not start checkout.\nNot authorized for this action. The application's authorize " +
        "hook denied it; if this is unexpected, check that the payer's session reaches the " +
        "checkout routes. https://openreceive.org/guides/authorization.md",
    ),
    ["authorize hook", "hook denied", "payer's session", "checkout routes", "docs link"],
  );
  assert.deepEqual(bannedPayerWords("payment_hash is required."), ["field name"]);
  assert.deepEqual(bannedPayerWords("pay_in_asset is not supported."), ["field name"]);
  assert.deepEqual(
    bannedPayerWords(
      "The host did not accept this payment attempt; payer instructions were withheld.",
    ),
    ["payer instructions"],
  );
  for (const code of [
    "FORBIDDEN",
    "INVALID_REQUEST",
    "CONFLICT",
    "NOT_FOUND",
    "WALLET_UNAVAILABLE",
  ]) {
    assert.deepEqual(bannedPayerWords(`Could not start checkout.\n${code}`), ["error code"], code);
  }
  assert.deepEqual(bannedPayerWords('{"code":"RATE_LIMITED","message":"Too many requests."}'), [
    "error code",
  ]);
});

test("the words check passes ordinary words near the developer phrases", () => {
  for (const text of [
    // A shop selling hooks, a session, routes: ordinary words on a shop page.
    "Brass hook, 3 pack — $7.00\nAdd to cart",
    "Your session expired. Sign in again to see your orders.",
    "Delivery routes are updated daily.",
    "Not found\nThat order is not yours.",
    // CSS-capitalized headings that are English words, not codes.
    "OTHER WAYS TO PAY\nINTERNAL REFERENCE 42\nTIMEOUT IN 10 MINUTES\nRESTRICTED CONTENT",
    "Forbidden City tour — $49.00",
    "Conflict-free minerals",
  ]) {
    assert.deepEqual(bannedPayerWords(text), [], text);
  }
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

test("every failure sentence the checkout shows passes the words check", () => {
  // The sentences payerErrorMessage puts in front of a payer, under the
  // headings the two renderers put above them.
  for (const sentence of [
    checkoutLabels.paymentServiceUnavailable,
    checkoutLabels.paymentNotYours,
    checkoutLabels.orderNotFound,
    checkoutLabels.paymentChanged,
    checkoutLabels.paymentRequestFailed,
    checkoutLabels.startCheckoutFailedDetail,
  ]) {
    for (const heading of ["Could not start checkout.", checkoutLabels.swapStartFailedTitle]) {
      const text = `${heading}\n${sentence}\n${checkoutLabels.tryAgain}`;
      assert.deepEqual(bannedPayerWords(text), [], text);
    }
    assert.equal(isPayerSentence(sentence), true, sentence);
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
  // Easy Digital Downloads' own receipt, once the checkout has handed over.
  assert.equal(saysPaid("Receipt\nOrder:\t5\nOrder Status:\tCompleted"), true);
  assert.equal(saysPaid("Receipt\nOrder Status:\tPending"), false);
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

test("a memo names the order, not the shop or the person", () => {
  assert.deepEqual(memoProblems("Order #15"), []);
  assert.deepEqual(memoProblems("Facet"), []);
  assert.deepEqual(memoProblems("Invoice #INV-12"), []);
  assert.deepEqual(memoProblems(""), []);
  // 46dd9917: Odoo put the company name in every payer's wallet app.
  assert.deepEqual(memoProblems("Widget Shop S00012"), ["names the shop"]);
  assert.deepEqual(memoProblems("Facet from widget  shop"), ["names the shop"]);
  assert.deepEqual(memoProblems("Order 12 for buyer@example.test"), ["carries an email address"]);
  assert.deepEqual(memoProblems("NWC settlement"), ["says NWC", "says settlement"]);
});

test("a QR and an invoice are compared as a wallet reads them", () => {
  assert.ok(sameInvoice("lightning:lnbc100n1abc", "lnbc100n1abc"));
  assert.ok(sameInvoice("LIGHTNING:LNBC100N1ABC", "lnbc100n1abc"));
  assert.ok(sameInvoice(" lnbc100n1abc\n", "lnbc100n1abc"));
  assert.ok(!sameInvoice("lightning:lnbc100n1abd", "lnbc100n1abc"));
  assert.ok(!sameInvoice("", "lnbc100n1abc"));
});

test("apiRoute reads a checkout route from the path or PrestaShop's ?path=", () => {
  assert.equal(apiRoute("http://shop.test/openreceive/checkouts"), "/openreceive/checkouts");
  assert.equal(
    apiRoute("http://shop.test/api/openreceive/payments/check"),
    "/api/openreceive/payments/check",
  );
  assert.equal(
    apiRoute("http://shop.test/index.php?fc=module&module=openreceive&path=%2Fcheckouts"),
    "/checkouts",
  );
  assert.equal(
    apiRoute("http://shop.test/module/openreceive/api?path=/swaps/status"),
    "/swaps/status",
  );
  assert.equal(apiRoute("http://shop.test/checkout?step=review"), undefined);
  assert.equal(apiRoute("http://shop.test/order-confirmation?path=/elsewhere"), undefined);
});

test("only BTCPay and Bolt stay out of the payer walk", () => {
  for (const host of ["paymenter", "fossbilling", "prestashop", "odoo", "medusa", "vendure"]) {
    const platform = { slug: host, host };
    assert.equal(hasPayerWalk(platform), true, host);
    assert.equal(typeof payerOrders(platform, "/tmp/shop", "http://127.0.0.1:1"), "function", host);
  }
  assert.equal(hasPayerWalk({ slug: "node" }), true);
  assert.equal(payerOrders({ slug: "node" }, "/tmp/shop", "http://127.0.0.1:1"), undefined);
  assert.equal(
    typeof payerOrders({ slug: "woocommerce" }, "/tmp/shop", "http://127.0.0.1:1"),
    "function",
  );
  assert.equal(hasPayerWalk({ slug: "btcpay", host: "btcpay" }), false);
  assert.equal(hasPayerWalk({ slug: "bolt", host: "bolt" }), false);
});

// The walk compares the checkout to these, so they must be what each shop was seeded with.
test("the hosted platforms' payer prices are their seeds' prices", async () => {
  const platforms = [
    [paymenterPrices, "paymenter/seed/seed.php", /\['Widget VPS \w+', '([\d.]+)'\]/g],
    [fossbillingPrices, "fossbilling/seed/seed.php", /\['Widget VPS \w+', '([\d.]+)'\]/g],
    [prestashopPrices, "prestashop/seed/seed.php", /\['Widget \w+', 'widget-\w+', '([\d.]+)'\]/g],
    [odooPrices, "odoo/seed/seed.py", /\("\w+", ([\d.]+), "\w+"\)/g],
    [
      medusaPrices,
      "medusa/fixture/medusa/src/scripts/seed.ts",
      /handle: "\w+", price: ([\d.]+) }/g,
    ],
    [vendurePrices, "vendure/fixture/server/products.csv", /,,,\w+,([\d.]+),standard/g],
  ];
  for (const [prices, file, row] of platforms) {
    const text = await readFile(new URL(`../trials/platforms/${file}`, import.meta.url), "utf8");
    const seeded = [...text.matchAll(row)].map((match) => Math.round(Number(match[1]) * 100));
    assert.equal(seeded.length, 5, file);
    assert.deepEqual([...prices], seeded.slice(0, 2), file);
    // The test provider takes at least 10 USDT.
    assert.ok(prices[SWAP_PRODUCT - 1] >= 1000, `${file}: product ${SWAP_PRODUCT} is under $10`);
  }
});
