import assert from "node:assert/strict";
import test from "node:test";
import {
  formatAmountCaption,
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
