import assert from "node:assert/strict";
import test from "node:test";
import {
  compareFixedFloatDecimalAmounts,
  invoiceLimitsFromFixedFloatRate,
  parseFixedFloatRatesXml,
  quotePayAmountFromFixedFloatRate,
  retainFixedFloatLightningPayoutPairs,
  retainFixedFloatRatePairsForKeys,
  swapRatesMetaKey,
} from "../packages/js/node/src/swap/index.ts";
import { TransientSwapCache } from "../packages/js/node/src/swap/limits-cache.ts";
import {
  deserializeFixedFloatRatesIndex,
  fetchFixedFloatRatesIndex,
  serializeFixedFloatRatesIndex,
} from "../packages/js/node/src/swap/fixedfloat-rates.ts";

const SAMPLE_XML = `<?xml version="1.0"?>
<rates>
  <item>
    <from>USDTTRC</from>
    <to>BTCLN</to>
    <in>315</in>
    <out>0.005</out>
    <amount>1170121.61</amount>
    <tofee>0.00000001 BTC</tofee>
    <minamount>10</minamount>
    <maxamount>11340</maxamount>
  </item>
  <item>
    <from>ETH</from>
    <to>BTCLN</to>
    <in>1</in>
    <out>0.05</out>
    <amount>10</amount>
    <minamount>0.01 ETH</minamount>
    <maxamount>2 ETH</maxamount>
  </item>
</rates>`;

test("parseFixedFloatRatesXml indexes pairs and strips currency suffixes", () => {
  const pairs = parseFixedFloatRatesXml(SAMPLE_XML);
  assert.equal(Object.keys(pairs).sort().join(","), "ETH:BTCLN,USDTTRC:BTCLN");
  assert.equal(pairs["USDTTRC:BTCLN"]?.minamount, "10");
  assert.equal(pairs["ETH:BTCLN"]?.minamount, "0.01");
  assert.equal(pairs["ETH:BTCLN"]?.maxamount, "2");
  assert.equal(pairs["USDTTRC:BTCLN"]?.tofee, "0.00000001 BTC");
});

test("FixedFloat rates retain only Lightning payout pairs and selected keys", async () => {
  const xml = `<?xml version="1.0"?>
<rates>
  <item>
    <from>USDTTRC</from>
    <to>BTCLN</to>
    <in>315</in>
    <out>0.005</out>
    <amount>1000</amount>
    <minamount>10</minamount>
    <maxamount>11340</maxamount>
  </item>
  <item>
    <from>DOGE</from>
    <to>BTC</to>
    <in>1</in>
    <out>0.000001</out>
    <amount>100000</amount>
    <minamount>10</minamount>
    <maxamount>500000</maxamount>
  </item>
  <item>
    <from>ETH</from>
    <to>USDT</to>
    <in>1</in>
    <out>3000</out>
    <amount>10</amount>
    <minamount>0.01</minamount>
    <maxamount>5</maxamount>
  </item>
</rates>`;
  const parsed = parseFixedFloatRatesXml(xml);
  assert.equal(Object.keys(parsed).length, 3);
  const lightningOnly = retainFixedFloatLightningPayoutPairs(parsed);
  assert.equal(Object.keys(lightningOnly).sort().join(","), "USDTTRC:BTCLN");

  const fetched = await fetchFixedFloatRatesIndex({
    baseUrl: "https://ff.example",
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () => xml,
    }),
    now: () => 1_000,
  });
  assert.equal(Object.keys(fetched.pairs).sort().join(","), "USDTTRC:BTCLN");

  const trimmed = retainFixedFloatRatePairsForKeys(
    fetched,
    new Set(["USDTTRC:BTCLN", "MISSING:BTCLN"]),
  );
  assert.equal(Object.keys(trimmed.pairs).sort().join(","), "USDTTRC:BTCLN");
});

test("quotePayAmountFromFixedFloatRate uses exact decimal math and folds BTC tofee", () => {
  const pairs = parseFixedFloatRatesXml(SAMPLE_XML);
  const pair = pairs["USDTTRC:BTCLN"];
  assert.notEqual(pair, undefined);
  // 0.005 BTC (= 500_000 sats) at 315 USDT / 0.005 BTC = 315 USDT.
  assert.equal(
    quotePayAmountFromFixedFloatRate({ pair, invoiceAmountMsats: 500_000_000 }),
    "315.00063",
  );
  // Without the 1-sat tofee the same invoice is exactly 315.
  assert.equal(
    quotePayAmountFromFixedFloatRate({
      pair: { ...pair, tofee: undefined },
      invoiceAmountMsats: 500_000_000,
    }),
    "315",
  );
});

test("invoiceLimitsFromFixedFloatRate maps from-side min/max into invoice msats", () => {
  const pairs = parseFixedFloatRatesXml(SAMPLE_XML);
  const limits = invoiceLimitsFromFixedFloatRate(pairs["USDTTRC:BTCLN"]);
  assert.equal(limits.minimum_pay_amount, "10");
  assert.equal(limits.maximum_pay_amount, "11340");
  assert.equal(limits.minimum_invoice_amount_msats, 15_874_000);
  assert.equal(limits.maximum_invoice_amount_msats, 18_000_000_000);
});

test("invoiceLimitsFromFixedFloatRate handles FixedFloat out amounts padded past 8 decimals", () => {
  // Live FixedFloat XML pads BTC amounts like 0.028314000000 (12 fractional digits).
  // The old Number/8-dp path dropped invoice-side limits and left ETH selectable at $2.
  const pairs = parseFixedFloatRatesXml(`<?xml version="1.0"?>
<rates>
  <item>
    <from>ETH</from>
    <to>BTCLN</to>
    <in>1</in>
    <out>0.028314000000</out>
    <amount>207.22797276</amount>
    <tofee>0.0000016000 BTCLN</tofee>
    <minamount>0.0083927593</minamount>
    <maxamount>6.2933949000</maxamount>
  </item>
</rates>`);
  const pair = pairs["ETH:BTCLN"];
  assert.notEqual(pair, undefined);
  const limits = invoiceLimitsFromFixedFloatRate(pair);
  assert.equal(limits.minimum_pay_amount, "0.0083927593");
  assert.notEqual(limits.minimum_invoice_amount_msats, undefined);
  // Exact: ceil(0.0083927593 × 0.028314000000 × 1e8 / 1) = 23,764 sats
  assert.equal(limits.minimum_invoice_amount_msats, 23_764_000);
  const pay = quotePayAmountFromFixedFloatRate({
    pair,
    invoiceAmountMsats: 3_185_000,
  });
  // The 10-decimal "0.0000016000 BTCLN" network fee (160 sats) is reduced with
  // ceil rounding and folded into the pay amount instead of being dropped:
  // (3185 + 160) sats / 2,831,400 sats-per-ETH = 0.0011814 ETH.
  assert.equal(pay, "0.0011814");
  assert.ok(3_185_000 < limits.minimum_invoice_amount_msats);
});

test("compareFixedFloatDecimalAmounts orders positive decimals without floats", () => {
  assert.equal(compareFixedFloatDecimalAmounts("0.00112489", "0.0083927593"), -1);
  assert.equal(compareFixedFloatDecimalAmounts("10", "10.000"), 0);
  assert.equal(compareFixedFloatDecimalAmounts("2", "1.5"), 1);
});

test("swap rates cache is reused inside one process", async () => {
  let fetches = 0;
  const cache = new TransientSwapCache(() => 1_000);
  const fetch = async () => {
    fetches += 1;
    return await fetchFixedFloatRatesIndex({
      baseUrl: "https://ff.example",
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => SAMPLE_XML,
      }),
      now: () => 1_000,
    });
  };

  const first = await cache.resolve(swapRatesMetaKey("fixedfloat", "fixed"), {
    refreshSeconds: 15,
    maxStaleSeconds: 15,
    serveStaleOnFailure: false,
    fetch,
    serialize: serializeFixedFloatRatesIndex,
    deserialize: deserializeFixedFloatRatesIndex,
  });
  const second = await cache.resolve(swapRatesMetaKey("fixedfloat", "fixed"), {
    refreshSeconds: 15,
    maxStaleSeconds: 15,
    serveStaleOnFailure: false,
    fetch,
    serialize: serializeFixedFloatRatesIndex,
    deserialize: deserializeFixedFloatRatesIndex,
  });

  assert.equal(fetches, 1);
  assert.equal(first.pairs["USDTTRC:BTCLN"]?.in, "315");
  assert.equal(second.pairs["USDTTRC:BTCLN"]?.in, "315");
});

test("rates cache refresh failure does not serve stale rates", async () => {
  let now = 1_000;
  let shouldFail = false;
  const cache = new TransientSwapCache(() => now);
  const fetch = async () => {
    if (shouldFail) throw new Error("rates down");
    return await fetchFixedFloatRatesIndex({
      baseUrl: "https://ff.example",
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => SAMPLE_XML,
      }),
      now: () => now,
    });
  };

  await cache.resolve(swapRatesMetaKey("fixedfloat", "fixed"), {
    refreshSeconds: 15,
    maxStaleSeconds: 15,
    serveStaleOnFailure: false,
    fetch,
    serialize: serializeFixedFloatRatesIndex,
    deserialize: deserializeFixedFloatRatesIndex,
  });

  now = 1_020;
  shouldFail = true;
  await assert.rejects(
    () =>
      cache.resolve(swapRatesMetaKey("fixedfloat", "fixed"), {
        refreshSeconds: 15,
        maxStaleSeconds: 15,
        serveStaleOnFailure: false,
        fetch,
        serialize: serializeFixedFloatRatesIndex,
        deserialize: deserializeFixedFloatRatesIndex,
      }),
    /rates down/,
  );
});
