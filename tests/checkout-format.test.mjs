import assert from "node:assert/strict";
import test from "node:test";
import {
  formatAmountCaption,
  formatDepositAmount,
  formatEstimateAmount,
  formatFiatAmount,
  formatFiatValue,
} from "../packages/js/browser/src/internal/checkout-format.ts";

// The caption under the QR is the one line every payer reads. It used to
// print the host's value verbatim ("$87.0 US" for a Ruby BigDecimal echo of
// 87.0): neither an integer nor money, and "US" is not a currency code.

test("formatFiatValue renders money at two decimals with grouping, without floats", () => {
  assert.equal(formatFiatValue("87"), "87.00");
  assert.equal(formatFiatValue("87.0"), "87.00");
  assert.equal(formatFiatValue("87.5"), "87.50");
  assert.equal(formatFiatValue("87.00"), "87.00");
  assert.equal(formatFiatValue("0.05"), "0.05");
  assert.equal(formatFiatValue("1234.5"), "1,234.50");
  assert.equal(formatFiatValue("1234567"), "1,234,567.00");
  // More than two decimals: half-up, in bigint.
  assert.equal(formatFiatValue("87.125"), "87.13");
  assert.equal(formatFiatValue("87.124"), "87.12");
  assert.equal(formatFiatValue("0.999"), "1.00");
  // Past double precision, still exact.
  assert.equal(formatFiatValue("12345678901234567890.115"), "12,345,678,901,234,567,890.12");
  // Our own server sent it: a malformed value is a bug that surfaces.
  assert.throws(() => formatFiatValue("87,0"), /fiat\.value/);
  assert.throws(() => formatFiatValue("-1"), /fiat\.value/);
});

test("formatFiatAmount keeps the $ for USD and the code for everything else", () => {
  assert.equal(formatFiatAmount({ currency: "USD", value: "87.0" }), "$87.00");
  assert.equal(formatFiatAmount({ currency: "EUR", value: "87" }), "87.00 EUR");
  // Bitcoin denominations are not money-formatted: sats are integers already
  // and BTC carries eight decimals.
  assert.equal(formatFiatAmount({ currency: "BTC", value: "0.00012000" }), "0.00012000 BTC");
  assert.equal(formatFiatAmount({ currency: "SATS", value: "12000" }), "12000 sats");
  assert.equal(formatFiatAmount({ currency: "SAT", value: "12000" }), "12000 sats");
  assert.equal(formatFiatAmount(undefined), undefined);
  assert.equal(formatFiatAmount({ currency: "USD" }), undefined);
});

test("formatAmountCaption names the dollar with its ISO code", () => {
  assert.equal(
    formatAmountCaption({ amountLabel: "112,128 sats", fiatLabel: "$87.00", fiatCurrency: "USD" }),
    "112,128 sats / $87.00 USD",
  );
  // Already suffixed (a host-formatted label) is not suffixed twice.
  assert.equal(
    formatAmountCaption({ amountLabel: "1 sat", fiatLabel: "$0.01 USD", fiatCurrency: "USD" }),
    "1 sat / $0.01 USD",
  );
  assert.equal(
    formatAmountCaption({ amountLabel: "1 sat", fiatLabel: "0.01 EUR", fiatCurrency: "EUR" }),
    "1 sat / 0.01 EUR",
  );
  assert.equal(formatAmountCaption({ amountLabel: "1 sat" }), "1 sat");
  assert.equal(formatAmountCaption({}), undefined);
});

test("swap limits retain fiat after minting and group the sats fallback", async () => {
  const { requestCheckout } = await import(
    "../packages/js/browser/src/internal/checkout-transport.ts"
  );
  const { formatSwapLimit } = await import(
    "../packages/js/browser/src/internal/checkout-format.ts"
  );
  const previous = {
    checkout_id: "prepare",
    reference: "order",
    status: "open",
    amount_msats: 1000000,
    invoices: [],
    fiat: { currency: "USD", value: "1.00" },
  };
  const snapshot = await requestCheckout({
    prefix: "/openreceive",
    reference: "order",
    previous,
    fetch: async () =>
      Response.json({
        checkout: {
          reference: "order",
          payment_hash: "a".repeat(64),
          amount_msats: 1000000,
          bolt11: "lnbc-test",
          expires_at: 2000000000,
        },
      }),
  });
  assert.equal(formatSwapLimit(previous, 25000000), "$25.00");
  assert.equal(formatSwapLimit(snapshot, 25000000), "$25.00");
  assert.equal(formatSwapLimit({ amount_msats: 1000000 }, 25000000), "25,000 sats");
});

// The picker's amount line ("≈ 12.35 USDT") is read once, before Continue. A
// quote arrives with eight decimals; the line shows four significant digits.
// The deposit panel's amount is the opposite case: the payer types it into a
// wallet, so it keeps every digit.
test("formatEstimateAmount shortens a quote to a glance, without floats", () => {
  // Stablecoins: cents.
  assert.equal(formatEstimateAmount("12.34567891"), "12.35");
  assert.equal(formatEstimateAmount("12.34400000"), "12.34");
  assert.equal(formatEstimateAmount("1250.12345678"), "1250.12");
  // Small amounts keep four significant digits, however many zeros lead them.
  assert.equal(formatEstimateAmount("0.04213457"), "0.04213");
  assert.equal(formatEstimateAmount("0.00312345"), "0.003123");
  assert.equal(formatEstimateAmount("0.00000123"), "0.00000123");
  assert.equal(formatEstimateAmount("1.23456789"), "1.235");
  // Padding is the provider's, not the payer's.
  assert.equal(formatEstimateAmount("0.04210000"), "0.0421");
  assert.equal(formatEstimateAmount("12.50"), "12.5");
  assert.equal(formatEstimateAmount("5.00000000"), "5");
  assert.equal(formatEstimateAmount("100"), "100");
  // Half up, and a round-up that gains a digit stays a number.
  assert.equal(formatEstimateAmount("12.345"), "12.35");
  assert.equal(formatEstimateAmount("99.999"), "100");
  assert.equal(formatEstimateAmount("0.99996"), "1");
  // Past double precision, still exact.
  assert.equal(formatEstimateAmount("123456789012345678901.555"), "123456789012345678901.56");
  // Not a number: shown as sent, never a throw on the payment screen.
  assert.equal(formatEstimateAmount("about 5"), "about 5");
  assert.equal(formatEstimateAmount(""), "");

  // A coin pegged to a currency is read as money, so it is shown as money: to
  // the cent, half up, and always with both decimals. "≈ 7.477 USDT" on a
  // $7.00 order looked like a typo (2026-11-16).
  const cents = (amount) => formatEstimateAmount(amount, { cents: true });
  assert.equal(cents("7.47712345"), "7.48");
  assert.equal(cents("7.475"), "7.48");
  assert.equal(cents("7.4749"), "7.47");
  assert.equal(cents("12.5"), "12.50");
  assert.equal(cents("5.00000000"), "5.00");
  assert.equal(cents("100"), "100.00");
  assert.equal(cents("1250.12345678"), "1250.12");
  assert.equal(cents("0.999"), "1.00");
  // Under half a cent would read "0.00": the digits stay instead.
  assert.equal(cents("0.00312345"), "0.003123");
  assert.equal(cents("0"), "0.00");
  assert.equal(cents("about 5"), "about 5");

  // The amount to REPRODUCE is never shortened.
  assert.equal(formatDepositAmount("12.34567891"), "12.34567891");
});
