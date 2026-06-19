#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const nwc = process.env.OPENRECEIVE_NWC;
const profile = process.env.OPENRECEIVE_WALLET_PROFILE || "rizful";
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const expectedCapabilitiesPath =
  process.env.OPENRECEIVE_EXPECTED_CAPABILITIES ??
  path.join(currentDir, "expected_capabilities.json");

function redactNwc(value) {
  if (!value) return value;
  return value.replace(/([?&]secret=)[^&]+/gi, "$1[REDACTED]");
}

function parseNwc(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("OPENRECEIVE_NWC is not a valid URL");
  }

  if (parsed.protocol !== "nostr+walletconnect:") {
    throw new Error("OPENRECEIVE_NWC must use nostr+walletconnect://");
  }

  const walletPubkey = parsed.hostname || parsed.pathname.replace(/^\/+/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(walletPubkey)) {
    throw new Error("NWC wallet pubkey must be 64 hex characters");
  }

  const relays = parsed.searchParams.getAll("relay");
  if (relays.length === 0) {
    throw new Error("NWC URI must contain at least one relay");
  }

  for (const relay of relays) {
    const relayUrl = new URL(relay);
    if (relayUrl.protocol !== "wss:") {
      throw new Error("NWC relays must use wss:// URLs");
    }
  }

  const secrets = parsed.searchParams.getAll("secret");
  if (secrets.length !== 1 || !/^[0-9a-fA-F]{64}$/.test(secrets[0])) {
    throw new Error("NWC URI must contain exactly one 64-hex secret");
  }

  return {
    walletPubkey,
    relays,
    lud16: parsed.searchParams.get("lud16"),
    redacted: redactNwc(value)
  };
}

function loadExpectedCapabilities(filePath) {
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, "utf8"));
}

if (!nwc) {
  console.log("OPENRECEIVE_NWC is not set; skipping live NWC smoke test.");
  process.exit(0);
}

let parsedNwc;
let expectedCapabilities;

try {
  parsedNwc = parseNwc(nwc);
  expectedCapabilities = loadExpectedCapabilities(expectedCapabilitiesPath);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
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

console.log("Next live step: run @openreceive/node preflight, create a tiny invoice, and poll lookup_invoice.");
