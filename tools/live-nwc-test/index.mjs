#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLightningUri } from "@openreceive/browser";
import {
  parseNwcConnectionUri,
  pollInvoiceUntilFinalState
} from "@openreceive/core";
import {
  createAlbyNwcReceiveClient
} from "@openreceive/node";

const nwc = process.env.OPENRECEIVE_NWC;
const profile = process.env.OPENRECEIVE_WALLET_PROFILE || "rizful";
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../..");
const expectedCapabilitiesPath =
  process.env.OPENRECEIVE_EXPECTED_CAPABILITIES ??
  path.join(currentDir, "expected_capabilities.json");
const productPath = path.join(repoRoot, "examples/hello-fruit/shared/product.json");
const createInvoice = process.env.OPENRECEIVE_LIVE_CREATE_INVOICE !== "0";
const waitForPayment = process.env.OPENRECEIVE_LIVE_WAIT_FOR_PAYMENT === "1";

function loadExpectedCapabilities(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function formatErrorMessage(error) {
  if (error && typeof error === "object" && typeof error.description === "string") {
    return error.description;
  }

  return error instanceof Error ? error.message : String(error);
}

function assertCapabilities(summary, expected) {
  if (!expected) return;

  const methods = new Set(summary.methods ?? []);
  const missing = (expected.required_methods ?? []).filter(
    (method) => !methods.has(method)
  );

  if (missing.length > 0) {
    throw new Error(`Wallet is missing required methods: ${missing.join(", ")}`);
  }
}

async function renderTerminalQr(invoice) {
  try {
    const qr = await import("qrcode");
    return await qr.default.toString(createLightningUri(invoice), {
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

let parsedNwc;
let expectedCapabilities;

try {
  parsedNwc = parseNwcConnectionUri(nwc);
  expectedCapabilities = loadExpectedCapabilities(expectedCapabilitiesPath);
} catch (error) {
  console.error(formatErrorMessage(error));
  process.exit(1);
}

console.log(`Live NWC smoke skeleton for profile '${profile}'.`);
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

const client = createAlbyNwcReceiveClient({
  connectionString: nwc
});

console.log("Running wallet preflight...");
const summary = await client.preflight();
assertCapabilities(summary, expectedCapabilities);
console.log(`Receive checkout ready: ${summary.receiveCheckoutReady}`);
console.log(`Encryption: ${summary.encryption}`);
if (summary.spendCapabilityAdvertised) {
  console.log("Warning: wallet advertises spend methods; OpenReceive checkout will not expose them.");
}

if (!createInvoice) {
  console.log("OPENRECEIVE_LIVE_CREATE_INVOICE=0; stopping after preflight.");
  process.exit(0);
}

const product = JSON.parse(readFileSync(productPath, "utf8"));
console.log("Creating low-value Hello Fruit invoice...");
const invoice = await client.makeInvoice({
  amount_msats: BigInt(product.amount_msats),
  description: "Fruit sticker from OpenReceive live smoke test",
  expiry: product.invoice_expiry_seconds,
  metadata: {
    product_id: product.product_id,
    smoke_test: true,
    wallet_profile: profile
  }
});

console.log(`Invoice: ${invoice.invoice}`);
console.log(`Payment hash: ${invoice.payment_hash}`);
console.log(`Amount msats: ${invoice.amount_msats.toString()}`);
const qr = await renderTerminalQr(invoice.invoice);
if (qr) console.log(qr);

console.log("Running initial lookup before manual payment...");
const initialLookup = await client.lookupInvoice({
  payment_hash: invoice.payment_hash
});
console.log(`Initial wallet state: ${initialLookup.state ?? initialLookup.transaction_state ?? "unknown"}`);

if (!waitForPayment) {
  console.log("Set OPENRECEIVE_LIVE_WAIT_FOR_PAYMENT=1 to poll until manual payment settles.");
  process.exit(0);
}

console.log("Waiting for manual payment. Settlement must be proven by lookup_invoice.");
const createdAt = invoice.created_at ?? Math.floor(Date.now() / 1000);
const expiresAt = invoice.expires_at ?? createdAt + product.invoice_expiry_seconds;
const outcome = await pollInvoiceUntilFinalState({
  created_at: createdAt,
  expires_at: expiresAt,
  lookup_invoice: () => client.lookupInvoice({ payment_hash: invoice.payment_hash }),
  on_transition: (transition) => {
    console.log(`Workflow transition: ${transition.workflow_state} (${transition.reason})`);
  }
});

console.log(`Final outcome: ${outcome.status} (${outcome.reason})`);
if (outcome.status !== "settled") {
  process.exit(1);
}
