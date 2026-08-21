import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenReceiveDecimalError,
  OpenReceivePriceFeedError,
  ceilDiv,
  convertAmountViaBtcRates,
  convertFiatViaBtcPrices,
  decimalScaleFactor,
  fiatValueToSats,
  formatBtcFromSats,
  formatDecimal,
  multiplyAmount,
  parseDecimal,
  quoteBitcoinAmountToMsats,
  quoteFiatToMsatsAtMockRate,
  quoteFiatToMsatsWithPrice,
  requiredBtcFiatRate,
  satsToFiatValue,
  sumAmounts,
} from "../packages/js/core/src/index.ts";

const RATES = { bitcoin: { usd: "68000.00", eur: "62000.00" } };

test("formatDecimal keeps the sign in front of the whole part at every scale", () => {
  assert.equal(formatDecimal(-5n, 8), "-0.00000005");
  assert.equal(formatDecimal(5n, 8), "0.00000005");
  assert.equal(formatDecimal(-12345n, 2), "-123.45");
  assert.equal(formatDecimal(12345n, 2), "123.45");
  assert.equal(formatDecimal(-1n, 0), "-1");
  assert.equal(formatDecimal(-100n, 2), "-1.00");
  assert.equal(formatDecimal(0n, 4), "0.0000");
  assert.throws(() => formatDecimal(1n, -1), OpenReceiveDecimalError);
});

test("parseDecimal names the field it rejected and stays inside the input-error domain", () => {
  assert.deepEqual(parseDecimal("12.345"), { units: 12345n, scale: 3 });
  assert.deepEqual(parseDecimal("7"), { units: 7n, scale: 0 });
  assert.throws(
    () => parseDecimal("-5", "fiat.value"),
    (error) => {
      assert.ok(error instanceof OpenReceiveDecimalError);
      // The Node service maps payer input to 400 by RangeError; decimal domain
      // errors must keep landing there.
      assert.ok(error instanceof RangeError);
      assert.match(error.message, /fiat\.value must be a non-negative decimal string/);
      return true;
    },
  );
  assert.throws(() => parseDecimal("1.2.3"), OpenReceiveDecimalError);
  assert.equal(decimalScaleFactor(8), 100_000_000n);
  assert.equal(ceilDiv(7n, 2n), 4n);
  assert.throws(() => ceilDiv(1n, 0n), OpenReceiveDecimalError);
});

test("price-feed failures are NOT RangeErrors, so a feed outage cannot read as payer input", () => {
  const feedError = (run) => {
    try {
      run();
    } catch (error) {
      return error;
    }
    throw new Error("expected a throw");
  };

  const missing = feedError(() => requiredBtcFiatRate(RATES, "GBP"));
  assert.ok(missing instanceof OpenReceivePriceFeedError);
  assert.equal(missing instanceof RangeError, false);
  assert.match(missing.message, /rate for GBP not available/);

  const zeroPrice = feedError(() => fiatValueToSats("10.00", "0"));
  assert.ok(zeroPrice instanceof OpenReceivePriceFeedError);
  assert.equal(zeroPrice instanceof RangeError, false);

  const junkPrice = feedError(() => fiatValueToSats("10.00", "not-a-price"));
  assert.ok(junkPrice instanceof OpenReceivePriceFeedError);
  assert.equal(junkPrice instanceof RangeError, false);
});

test("quoting splits payer input from feed data across the same two error types", () => {
  assert.throws(
    () =>
      quoteFiatToMsatsWithPrice({
        fiat: { currency: "USD", value: "-1" },
        source: "primary",
        btc_fiat_price: "68000.00",
      }),
    (error) => {
      assert.ok(error instanceof RangeError);
      return true;
    },
  );
  assert.throws(
    () =>
      quoteFiatToMsatsWithPrice({
        fiat: { currency: "USD", value: "10.00" },
        source: "primary",
        btc_fiat_price: "0",
      }),
    (error) => {
      assert.ok(error instanceof OpenReceivePriceFeedError);
      assert.equal(error instanceof RangeError, false);
      return true;
    },
  );
});

test("fiat and bitcoin amounts round through one engine", () => {
  assert.equal(fiatValueToSats("10.00", "68000.00"), 14706n);
  assert.equal(satsToFiatValue(14706n, "68000.00"), "10.01");
  assert.equal(convertFiatViaBtcPrices("10.00", "68000.00", "62000.00"), "9.12");
  assert.equal(formatBtcFromSats(100_000_000n), "1");
  assert.equal(formatBtcFromSats(10n), "0.0000001");
  assert.deepEqual(multiplyAmount({ currency: "USD", value: "1.25" }, 4), {
    currency: "USD",
    value: "5.00",
  });
  assert.deepEqual(
    sumAmounts([
      { currency: "USD", value: "1.5" },
      { currency: "USD", value: "0.25" },
    ]),
    { currency: "USD", value: "1.75" },
  );
  assert.deepEqual(quoteBitcoinAmountToMsats({ currency: "BTC", value: "0.00001" }), {
    amount_sats: 1000,
    amount_msats: 1_000_000,
  });
  assert.deepEqual(quoteBitcoinAmountToMsats({ currency: "SAT", value: "1000" }), {
    amount_sats: 1000,
    amount_msats: 1_000_000,
  });
});

test("convertAmountViaBtcRates converts BOTH ways across the BTC bridge", () => {
  assert.deepEqual(convertAmountViaBtcRates({ currency: "USD", value: "10.00" }, "SATS", RATES), {
    currency: "SATS",
    value: "14706",
  });
  assert.deepEqual(convertAmountViaBtcRates({ currency: "USD", value: "10.00" }, "EUR", RATES), {
    currency: "EUR",
    value: "9.12",
  });
  // The direction that used to fail as "Missing BTC/BTC price feed rate".
  assert.deepEqual(convertAmountViaBtcRates({ currency: "SATS", value: "14706" }, "USD", RATES), {
    currency: "USD",
    value: "10.01",
  });
  assert.deepEqual(convertAmountViaBtcRates({ currency: "BTC", value: "0.5" }, "USD", RATES), {
    currency: "USD",
    value: "34000.00",
  });
  // BTC ↔ SATS needs no rate at all.
  assert.deepEqual(convertAmountViaBtcRates({ currency: "BTC", value: "0.5" }, "SATS", undefined), {
    currency: "SATS",
    value: "50000000",
  });
  assert.deepEqual(
    convertAmountViaBtcRates({ currency: "SATS", value: "50000000" }, "BTC", undefined),
    { currency: "BTC", value: "0.5" },
  );
});

test("convertAmountViaBtcRates compares currency codes case-insensitively", () => {
  const amount = { currency: "usd", value: "10.00" };
  // The lookup lowercases, so the same-currency short circuit must too.
  assert.deepEqual(convertAmountViaBtcRates(amount, "USD", RATES), amount);
  assert.deepEqual(convertAmountViaBtcRates({ currency: "USD", value: "10.00" }, "usd", RATES), {
    currency: "USD",
    value: "10.00",
  });
});

test("the mock-rate quote is named for what it is and never reads as a live source", () => {
  const quote = quoteFiatToMsatsAtMockRate({ fiat: { currency: "USD", value: "50000.00" } });
  assert.equal(quote.source, "static_mock");
  assert.equal(quote.btc_fiat_price, "50000.00");
  assert.equal(quote.amount_sats, 100_000_000);
});
