#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLightningUri } from "@openreceive/browser";
import {
  reconcilePaymentAttempts,
  OPENRECEIVE_NWC_METADATA_MAX_BYTES,
  parseNwcUri,
  quoteFiatToMsatsWithPrice,
  redactNwcUri,
} from "@openreceive/core";
import {
  createNwcReceiveClient,
  createPriceFeed,
  ReceiveCheckoutValidationError,
} from "@openreceive/node";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../..");
try {
  process.loadEnvFile(path.join(repoRoot, ".env"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

process.on("uncaughtException", handleFatalError);
process.on("unhandledRejection", handleFatalError);

const nwc = process.env.NWC_URI?.trim();
const profile = process.env.OPENRECEIVE_WALLET_PROFILE || "rizful";
const expectedCapabilitiesPath =
  process.env.OPENRECEIVE_EXPECTED_CAPABILITIES ??
  path.join(currentDir, "expected_capabilities.json");
const catalogPath = path.join(repoRoot, "examples/buttons/shared/shop-catalog.json");
// Opt-IN, matching the Ruby smoke: `npm run test:live:nwc` with NWC_URI set
// used to mint a real invoice on the JS side and stop after preflight on the
// Ruby side, so one command meant two different things per engine.
const shouldRequestLiveInvoice = process.env.OPENRECEIVE_LIVE_CREATE_INVOICE === "1";
const waitForPayment = process.env.OPENRECEIVE_LIVE_WAIT_FOR_PAYMENT === "1";
const supportedProfiles = new Set(["rizful", "alby", "zeus", "custom"]);
// The engine's own default. The demo this replaced read the value from a
// product.json field that file never actually carried, so `expiry` went out
// undefined on every live run.
const INVOICE_EXPIRY_SECONDS = 600;

function handleFatalError(error) {
  console.error(formatErrorMessage(error));
  process.exit(1);
}

function loadExpectedCapabilities(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function formatErrorMessage(error) {
  let message;
  if (error && typeof error === "object" && typeof error.description === "string") {
    message = error.description;
  } else {
    message = error instanceof Error ? error.message : String(error);
  }

  return redactPotentialSecrets(message);
}

function redactPotentialSecrets(message) {
  return message
    .replace(/nostr\+walletconnect:\/\/[^\s"'`<>]+/g, (uri) => {
      try {
        return redactNwcUri(uri);
      } catch {
        return uri.replace(/([?&]secret=)[^&\s"'`<>]+/g, "$1[REDACTED]");
      }
    })
    .replace(/([?&]secret=)[^&\s"'`<>]+/g, "$1[REDACTED]");
}

function assertCapabilities(summary, expected, walletProfile) {
  if (!expected) return;

  if (expected.wallet_profile && expected.wallet_profile !== walletProfile) {
    throw new Error(
      `Expected capabilities are for '${expected.wallet_profile}', but OPENRECEIVE_WALLET_PROFILE is '${walletProfile}'.`,
    );
  }

  const methods = new Set(summary.methods ?? []);
  const missing = (expected.required_methods ?? []).filter((method) => !methods.has(method));

  if (missing.length > 0) {
    throw new Error(`Wallet is missing required methods: ${missing.join(", ")}`);
  }

  const allowedEncryption = [expected.preferred_encryption, expected.fallback_encryption].filter(
    Boolean,
  );
  if (allowedEncryption.length > 0 && !allowedEncryption.includes(summary.encryption)) {
    throw new Error(
      `Wallet encryption '${summary.encryption}' does not match expected ${allowedEncryption.join(" or ")}.`,
    );
  }
}

async function renderTerminalQr(invoice) {
  try {
    const qr = await import("qrcode");
    return await qr.default.toString(createLightningUri(invoice), {
      type: "terminal",
      small: true,
      errorCorrectionLevel: "M",
      margin: 4,
    });
  } catch {
    return null;
  }
}

if (!nwc) {
  console.log("NWC_URI is not set; skipping live NWC smoke test.");
  process.exit(0);
}

if (!supportedProfiles.has(profile)) {
  console.error("OPENRECEIVE_WALLET_PROFILE must be rizful, alby, zeus, or custom.");
  process.exit(1);
}

let parsedNwc;
let expectedCapabilities;

try {
  parsedNwc = parseNwcUri(nwc);
  expectedCapabilities = loadExpectedCapabilities(expectedCapabilitiesPath);
} catch (error) {
  console.error(formatErrorMessage(error));
  process.exit(1);
}

console.log(`Live NWC smoke for profile '${profile}'.`);
console.log(`Configured NWC: ${parsedNwc.redacted}`);
console.log(`Wallet pubkey: ${parsedNwc.walletPubkey}`);
console.log(`Relay count: ${parsedNwc.relays.length}`);
if (parsedNwc.lud16) console.log(`lud16: ${parsedNwc.lud16}`);

if (expectedCapabilities) {
  console.log(`Loaded expected capabilities: ${expectedCapabilitiesPath}`);
  console.log(`Required methods: ${(expectedCapabilities.required_methods ?? []).join(", ")}`);
} else {
  console.log("No expected_capabilities.json found; continuing with built-in v0.1 expectations.");
}

const client = createNwcReceiveClient({
  connectionString: nwc,
});

console.log("Running wallet preflight...");
const summary = await client.preflight();
assertCapabilities(summary, expectedCapabilities, profile);
console.log(`Receive checkout ready: ${summary.receiveCheckoutReady}`);
console.log(`Encryption: ${summary.encryption}`);
if (summary.spendCapabilityAdvertised) {
  console.log(
    "Spend capability was advertised on the info event; OpenReceive warned and continued.",
  );
}

if (!shouldRequestLiveInvoice) {
  console.log("OPENRECEIVE_LIVE_CREATE_INVOICE is not 1; stopping after preflight.");
  process.exit(0);
}

// The cheapest button in the shop's own catalog, so a live smoke against a
// real wallet mints the smallest invoice the demo can sell.
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const liveButton = [...catalog].sort((a, b) => a.price_cents - b.price_cents)[0];
if (!liveButton) {
  throw new Error("The live smoke needs at least one product in shop-catalog.json.");
}
const liveFiat = { currency: "USD", value: (liveButton.price_cents / 100).toFixed(2) };
const liveQuote = await quoteLiveButtonAmount(liveFiat);
const liveAmountMsats = BigInt(liveQuote.amountMsats);
console.log(
  `Priced ${liveFiat.value} ${liveFiat.currency} at ${liveQuote.btcFiatPrice} BTC/${liveFiat.currency} (source: ${liveQuote.source}).`,
);
console.log("Checking local NWC metadata size guard...");
await assertMetadataGuard(client, liveAmountMsats);

console.log("Creating a low-value Buy a Button invoice...");
const invoice = await client.makeInvoice({
  amount_msats: liveAmountMsats,
  description: `OpenReceive button: ${liveButton.name} (live smoke test)`,
  expiry: INVOICE_EXPIRY_SECONDS,
  metadata: {
    sku: liveButton.sku,
    fiat: liveFiat,
    smoke_test: true,
    wallet_profile: profile,
  },
});

console.log(`Invoice: ${invoice.invoice}`);
console.log(`Payment hash: ${invoice.payment_hash}`);
console.log(`Amount msats: ${invoice.amount_msats.toString()}`);
const qr = await renderTerminalQr(invoice.invoice);
if (qr) console.log(qr);

console.log("Running initial production payment check before manual payment...");
const initialCheck = await checkInvoicePayment(client, invoice);
console.log(`Initial payment status: ${initialCheck.status}`);

if (!waitForPayment) {
  console.log(
    "Set OPENRECEIVE_LIVE_WAIT_FOR_PAYMENT=1 to refresh status until manual payment settles.",
  );
  process.exit(0);
}

console.log("Waiting for manual payment. Settlement must be proven by list_transactions.");
const createdAt = invoice.created_at ?? Math.floor(Date.now() / 1000);
const expiresAt = invoice.expires_at ?? createdAt + INVOICE_EXPIRY_SECONDS;
const outcome = await waitForCheckPaymentFinalState({
  client,
  invoice,
  expiresAt,
});

console.log(`Final outcome: ${outcome.status} (${outcome.reason})`);
if (outcome.status !== "settled") {
  process.exit(1);
}

/**
 * The wait loop drives the PRODUCTION scan — @openreceive/core's
 * reconcilePaymentAttempts (settled-first then inclusive-unpaid walk over
 * padded windows) — so this smoke test proves settlement through the same
 * code path a real host uses, not a re-implemented single-pass query.
 */
async function checkInvoicePayment(client, invoice) {
  const [checked] = await reconcilePaymentAttempts({
    client,
    attempts: [
      {
        paymentHash: invoice.payment_hash,
        createdAt: invoice.created_at ?? Math.floor(Date.now() / 1000),
      },
    ],
  });
  return checked;
}

async function waitForCheckPaymentFinalState({ client, invoice, expiresAt }) {
  while (Math.floor(Date.now() / 1000) <= expiresAt) {
    const check = await checkInvoicePayment(client, invoice);
    if (check === undefined) {
      // A truncated wallet-history walk proves nothing; the next poll scans again.
      console.log("Workflow transition: scan_incomplete (truncated wallet-history walk)");
      await sleep(2000);
      continue;
    }
    console.log(
      `Workflow transition: ${check.status} (${check.status === "not_found" ? "wallet_no_match" : "wallet_match"})`,
    );
    if (check.status === "settled" || check.status === "expired" || check.status === "failed") {
      return { status: check.status, reason: "wallet_match" };
    }

    await sleep(2000);
  }

  return {
    status: "expired",
    reason: "local_expiry_elapsed",
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * This tool mints a REAL invoice against a REAL wallet, so the amount has to
 * come from a real rate. Prices through the live feed; if the feed is down the
 * run stops rather than guessing, and the operator opts into an explicit fixed
 * sats amount instead.
 */
async function quoteLiveButtonAmount(fiat) {
  const fixedSats = process.env.OPENRECEIVE_LIVE_INVOICE_SATS?.trim();
  if (fixedSats) {
    if (!/^[1-9][0-9]*$/.test(fixedSats)) {
      throw new Error("OPENRECEIVE_LIVE_INVOICE_SATS must be a positive whole number of sats.");
    }
    return {
      amountMsats: Number(fixedSats) * 1000,
      btcFiatPrice: "not priced",
      source: `fixed ${fixedSats} sats (OPENRECEIVE_LIVE_INVOICE_SATS)`,
    };
  }

  const feed = createPriceFeed({ currencies: [fiat.currency] });
  let rates;
  try {
    rates = await feed.getBtcFiatRatesWithSource([fiat.currency]);
  } catch (error) {
    throw new Error(
      [
        "Live price feed is unavailable, so this smoke test will not mint a real invoice at a guessed rate.",
        "Set OPENRECEIVE_LIVE_INVOICE_SATS to a fixed sats amount to run anyway.",
        `Cause: ${formatErrorMessage(error)}`,
      ].join("\n"),
    );
  }

  return quoteFiatToMsatsWithPrice({
    fiat,
    btcFiatPrice: rates.rates.bitcoin[fiat.currency.toLowerCase()],
    source: rates.source,
  });
}

async function assertMetadataGuard(client, amountMsats) {
  try {
    await client.makeInvoice({
      amount_msats: amountMsats,
      description: "OpenReceive metadata guard probe",
      metadata: {
        probe: "x".repeat(OPENRECEIVE_NWC_METADATA_MAX_BYTES + 1),
      },
    });
  } catch (error) {
    if (
      error instanceof ReceiveCheckoutValidationError ||
      /metadata must serialize below/.test(formatErrorMessage(error))
    ) {
      console.log("Metadata guard rejected oversized payload before wallet request.");
      return;
    }

    throw error;
  }

  throw new Error("Metadata guard did not reject oversized payload.");
}
