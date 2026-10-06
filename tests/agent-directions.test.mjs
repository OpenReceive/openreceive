import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

// The payloads are prompts: a coding agent follows Step 0 literally. These are
// the structural promises two dry runs found missing (an agent that never asked
// for the codes, never mentioned swaps, and could not store a code without a
// shell argument), checked on the generated files an agent actually receives.

const release = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  .version;
const dir = new URL("../docs/agents/", import.meta.url);
const payloads = readdirSync(dir)
  .filter((name) => name.endsWith(".md"))
  .map((name) => ({ stack: name.slice(0, -3), text: readFileSync(new URL(name, dir), "utf8") }));

function stepZero(text) {
  const match = text.match(/^## Step 0\b[^\n]*\n([\s\S]*?)(?=^## )/m);
  return match?.[1] ?? "";
}

test("every payload has a Step 0 that asks for the NWC code and the LSC code", () => {
  assert.ok(payloads.length >= 10, "expected one payload per stack");
  for (const { stack, text } of payloads) {
    const step = stepZero(text);
    assert.notEqual(step, "", `${stack}: no Step 0 section`);
    assert.match(step, /get_a_nwc_code_to_receive_payments/, `${stack}: Step 0 never asks for NWC`);
    assert.match(step, /set_up_swap_provider/, `${stack}: Step 0 never asks for LSC`);
    assert.match(text, /fetch it raw/, `${stack}: no raw-fetch line`);
  }
});

test("every payload except BTCPay makes the first question a hard rule", () => {
  for (const { stack, text } of payloads.filter(({ stack }) => stack !== "btcpay")) {
    const step = stepZero(text);
    assert.match(step, /your next action is a question to the user/, stack);
    assert.match(step, /paste each code\s+into (the|this) chat/, stack);
    assert.match(step, /stablecoins/, `${stack}: Step 0 never mentions stablecoins`);
  }
});

test("the WooCommerce payload names the pinned install, configure and test-invoice commands", () => {
  const text = payloads.find(({ stack }) => stack === "woocommerce").text;
  const step = stepZero(text);
  assert.ok(
    text.includes(
      `wp plugin install https://github.com/OpenReceive/openreceive/releases/download/v${release}/openreceive-wordpress-${release}.zip --activate`,
    ),
    "the install line is pinned to this release",
  );
  assert.doesNotMatch(text, /\{\{release\}\}/);
  assert.match(text, /wp openreceive configure --nwc-uri=- < /);
  assert.match(text, /--lsc-uri-primary=-/);
  assert.match(text, /wp openreceive test-invoice <order id>/);
  // A request for stablecoins means the second message asks for the LSC code.
  assert.match(step, /this message IS the walkthrough/);
  assert.match(text, /Do not report setup as complete until the NWC code is saved/);
  // The chat paste is the supported path; storing goes through a file, not argv.
  assert.match(step, /do not tell them to revoke or replace a\s+code because it was pasted here/);
  assert.match(text, /file-editing tool, not a shell command/);
});
