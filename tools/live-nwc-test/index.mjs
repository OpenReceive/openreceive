#!/usr/bin/env node

const nwc = process.env.OPENRECEIVE_NWC;
const profile = process.env.OPENRECEIVE_WALLET_PROFILE || "rizful";

function redactNwc(value) {
  if (!value) return value;
  return value.replace(/([?&]secret=)[^&]+/i, "$1[REDACTED]");
}

if (!nwc) {
  console.log("OPENRECEIVE_NWC is not set; skipping live NWC smoke test.");
  process.exit(0);
}

if (!nwc.startsWith("nostr+walletconnect://")) {
  console.error("OPENRECEIVE_NWC must start with nostr+walletconnect://");
  process.exit(1);
}

console.log(`Live NWC smoke skeleton for profile '${profile}'.`);
console.log(`Configured NWC: ${redactNwc(nwc)}`);
console.log("Real preflight/create/lookup behavior will run after @openreceive/node is implemented.");
