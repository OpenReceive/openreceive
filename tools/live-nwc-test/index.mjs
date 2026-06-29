#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lightningUri } from "@openreceive/browser";
import {
  OPENRECEIVE_NWC_METADATA_MAX_BYTES,
  classifyTransactionSettlement,
  parseNwcConnectionUri,
  quoteFiatToMsats,
  redactNwcConnectionUri
} from "@openreceive/core";
import {
  ReceiveCheckoutValidationError,
  createNwcReceiveClient
} from "@openreceive/node";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../..");

process.on("uncaughtException", handleFatalError);
process.on("unhandledRejection", handleFatalError);

const loadedEnvPath = loadLocalEnvFile();
const nwc = process.env.OPENRECEIVE_NWC;
const profile = process.env.OPENRECEIVE_WALLET_PROFILE || "rizful";
const expectedCapabilitiesPath =
  process.env.OPENRECEIVE_EXPECTED_CAPABILITIES ??
  path.join(currentDir, "expected_capabilities.json");
const productPath = path.join(repoRoot, "examples/hello-fruit/shared/product.json");
const shouldRequestLiveInvoice = process.env.OPENRECEIVE_LIVE_CREATE_INVOICE !== "0";
const waitForPayment = process.env.OPENRECEIVE_LIVE_WAIT_FOR_PAYMENT === "1";
const supportedProfiles = new Set(["rizful", "alby", "zeus", "custom"]);
const fruitsPath = path.join(repoRoot, "examples/hello-fruit/shared/fruits.json");

function loadLocalEnvFile() {
  const explicitPath = process.env.OPENRECEIVE_ENV_FILE;
  if (!explicitPath) return null;

  const envPath = path.resolve(explicitPath);
  if (!existsSync(envPath)) {
    throw new Error(`OPENRECEIVE_ENV_FILE does not exist: ${envPath}`);
  }

  const entries = parseEnvFile(readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(entries)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  return envPath;
}

function parseEnvFile(contents) {
  const entries = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    entries[match[1]] = parseEnvValue(match[2]);
  }

  return entries;
}

function parseEnvValue(value) {
  const withoutComment = value.replace(/\s+#.*$/, "").trim();
  if (
    (withoutComment.startsWith("\"") && withoutComment.endsWith("\"")) ||
    (withoutComment.startsWith("'") && withoutComment.endsWith("'"))
  ) {
    return withoutComment.slice(1, -1);
  }

  return withoutComment;
}

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
        return redactNwcConnectionUri(uri);
      } catch {
        return uri.replace(/([?&]secret=)[^&\s"'`<>]+/g, "$1[REDACTED]");
      }
    })
    .replace(/([?&]secret=)[^&\s"'`<>]+/g, "$1[REDACTED]");
}

function assertCapabilities(summary, expected, walletProfile) {
  if (!expected) return;

  if (
    expected.wallet_profile &&
    expected.wallet_profile !== walletProfile
  ) {
    throw new Error(
      `Expected capabilities are for '${expected.wallet_profile}', but OPENRECEIVE_WALLET_PROFILE is '${walletProfile}'.`
    );
  }

  const methods = new Set(summary.methods ?? []);
  const missing = (expected.required_methods ?? []).filter(
    (method) => !methods.has(method)
  );

  if (missing.length > 0) {
    throw new Error(`Wallet is missing required methods: ${missing.join(", ")}`);
  }

  const allowedEncryption = [
    expected.preferred_encryption,
    expected.fallback_encryption
  ].filter(Boolean);
  if (
    allowedEncryption.length > 0 &&
    !allowedEncryption.includes(summary.encryption)
  ) {
    throw new Error(
      `Wallet encryption '${summary.encryption}' does not match expected ${allowedEncryption.join(" or ")}.`
    );
  }
}

async function renderTerminalQr(invoice) {
  try {
    const qr = await import("qrcode");
    return await qr.default.toString(lightningUri(invoice), {
      type: "terminal",
      small: true,
      errorCorrectionLevel: "M",
      margin: 4
    });
  } catch {
    return null;
  }
}

if (!nwc) {
  console.log("OPENRECEIVE_NWC is not set; skipping live NWC smoke test.");
  process.exit(0);
}

if (!supportedProfiles.has(profile)) {
  console.error(
    "OPENRECEIVE_WALLET_PROFILE must be rizful, alby, zeus, or custom."
  );
  process.exit(1);
}

let parsedNwc;
let expectedCapabilities;

try {
  parsedNwc = parseNwcConnectionUri(nwc);
  expectedCapabilities = loadExpectedCapabilities(expectedCapabilitiesPath);
} catch (error) {
  console.error(formatErrorMessage(error));
  process.exit(1);
}

console.log(`Live NWC smoke for profile '${profile}'.`);
if (loadedEnvPath) {
  console.log(`Loaded local env file: ${path.relative(repoRoot, loadedEnvPath)}`);
}
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
  connectionString: nwc
});

console.log("Running wallet preflight...");
const summary = await client.preflight();
assertCapabilities(summary, expectedCapabilities, profile);
console.log(`Receive checkout ready: ${summary.receiveCheckoutReady}`);
console.log(`Encryption: ${summary.encryption}`);
if (summary.spendCapabilityAdvertised) {
  console.log("Warning: wallet advertises spend methods; OpenReceive checkout will not expose them.");
}

if (!shouldRequestLiveInvoice) {
  console.log("OPENRECEIVE_LIVE_CREATE_INVOICE=0; stopping after preflight.");
  process.exit(0);
}

const product = JSON.parse(readFileSync(productPath, "utf8"));
const fruits = JSON.parse(readFileSync(fruitsPath, "utf8"));
const liveFruit = fruits.fruits.find((fruit) => fruit.id === "banana") ?? fruits.fruits[0];
if (!liveFruit) {
  throw new Error("Hello Fruit live smoke needs at least one fruit.");
}
const liveAmountMsats = BigInt(quoteFiatToMsats({ fiat: liveFruit.fiat }).amount_msats);
console.log("Checking local NWC metadata size guard...");
await assertMetadataGuard(client, liveAmountMsats);

console.log("Creating low-value Hello Fruit invoice...");
const invoice = await client.makeInvoice({
  amount_msats: liveAmountMsats,
  description: "Fruit sticker from OpenReceive live smoke test",
  expiry: product.invoice_expiry_seconds,
  metadata: {
    product_id: product.product_id,
    fruit: liveFruit.id,
    fiat: liveFruit.fiat,
    smoke_test: true,
    wallet_profile: profile
  }
});

console.log(`Invoice: ${invoice.invoice}`);
console.log(`Payment hash: ${invoice.payment_hash}`);
console.log(`Amount msats: ${invoice.amount_msats.toString()}`);
const qr = await renderTerminalQr(invoice.invoice);
if (qr) console.log(qr);

console.log("Running initial transaction scan before manual payment...");
const initialTransaction = await findInvoiceTransaction(client, invoice);
console.log(`Initial wallet state: ${initialTransaction?.state ?? initialTransaction?.transaction_state ?? "unknown"}`);

if (!waitForPayment) {
  console.log("Set OPENRECEIVE_LIVE_WAIT_FOR_PAYMENT=1 to refresh status until manual payment settles.");
  process.exit(0);
}

console.log("Waiting for manual payment. Settlement must be proven by list_transactions.");
const createdAt = invoice.created_at ?? Math.floor(Date.now() / 1000);
const expiresAt = invoice.expires_at ?? createdAt + product.invoice_expiry_seconds;
const outcome = await waitForListTransactionsFinalState({
  client,
  invoice,
  createdAt,
  expiresAt
});

console.log(`Final outcome: ${outcome.status} (${outcome.reason})`);
if (outcome.status !== "settled") {
  process.exit(1);
}

async function waitForListTransactionsFinalState({ client, invoice, createdAt, expiresAt }) {
  while (Math.floor(Date.now() / 1000) <= expiresAt) {
    const transaction = await findInvoiceTransaction(client, invoice);
    const settlement = transaction
      ? classifyTransactionSettlement(transaction)
      : { status: "pending", settled: false };
    console.log(`Workflow transition: ${settlement.status} (${transaction ? "wallet_match" : "wallet_no_match"})`);
    if (settlement.status === "settled" || settlement.status === "expired" || settlement.status === "failed") {
      return {
        status: settlement.status,
        reason: transaction ? "wallet_match" : "wallet_no_match"
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  return {
    status: "expired",
    reason: "local_expiry_elapsed"
  };
}

async function findInvoiceTransaction(client, invoice) {
  const createdAt = invoice.created_at ?? Math.floor(Date.now() / 1000);
  const response = await client.listTransactions({
    type: "incoming",
    unpaid: true,
    from: createdAt,
    until: createdAt,
    limit: 25,
    offset: 0
  });
  return response.transactions.find((transaction) =>
    transaction.payment_hash === invoice.payment_hash ||
    transaction.invoice === invoice.invoice
  );
}

async function assertMetadataGuard(client, amountMsats) {
  try {
    await client.makeInvoice({
      amount_msats: amountMsats,
      description: "OpenReceive metadata guard probe",
      metadata: {
        probe: "x".repeat(OPENRECEIVE_NWC_METADATA_MAX_BYTES + 1)
      }
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
