import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

// The payloads are prompts: a coding agent follows Step 0 literally. These are
// the structural promises two dry runs found missing (an agent that never asked
// for the codes, never mentioned swaps, and could not store a code without a
// shell argument), checked on the generated files an agent actually receives.

const release = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
const dir = new URL("../docs/agents/", import.meta.url);
const payloads = readdirSync(dir)
  .filter((name) => name.endsWith(".md"))
  .map((name) => ({ stack: name.slice(0, -3), text: readFileSync(new URL(name, dir), "utf8") }));
const coverDir = new URL("cover/", dir);
const covers = readdirSync(coverDir)
  .filter((name) => name.endsWith(".md"))
  .map((name) => ({
    stack: name.slice(0, -3),
    text: readFileSync(new URL(name, coverDir), "utf8"),
  }));
const fullUrl = (stack) => `https://openreceive.org/agent-directions/${stack}/full.md`;

function stepZero(text) {
  const match = text.match(/^## Step 0\b[^\n]*\n([\s\S]*?)(?=^## )/m);
  return match?.[1] ?? "";
}

// Claude Code's web tool summarized a 17 KB payload to 1.6 KB, keeping code
// blocks and short bullets and dropping the prose that held Step 0. So the full
// file names itself as such, then puts the download line first after the title,
// inside a code block, and restates Step 0 as bullets short enough to be quoted.
function opening(text) {
  const [first, blank, title, ...rest] = text.split("\n");
  assert.equal(`${first}|${blank}`, "This is the full file; follow it from Step 0.|");
  const body = rest.join("\n").trimStart();
  const block = body.match(/^```sh\n([\s\S]*?)\n```\n/)?.[1] ?? "";
  const brief = body.match(/^\*\*Step 0 in brief\*\*[^\n]*\n\n((?:- [^\n]*\n)+)/m)?.[1] ?? "";
  return {
    title,
    block,
    brief: brief
      .trimEnd()
      .split("\n")
      .map((line) => line.slice(2)),
  };
}

test("every payload has a Step 0 that asks for the NWC code and the LSC code", () => {
  assert.ok(payloads.length >= 10, "expected one payload per stack");
  for (const { stack, text } of payloads) {
    const step = stepZero(text);
    assert.notEqual(step, "", `${stack}: no Step 0 section`);
    assert.match(step, /get_a_nwc_code_to_receive_payments/, `${stack}: Step 0 never asks for NWC`);
    assert.match(step, /set_up_swap_provider/, `${stack}: Step 0 never asks for LSC`);
  }
});

test("every payload opens with the download block, then Step 0 in brief", () => {
  for (const { stack, text } of payloads) {
    const { title, block, brief } = opening(text);
    assert.match(title, /^# OpenReceive agent directions/, stack);
    assert.ok(
      block.includes(`\ncurl -fsSL ${fullUrl(stack)}\n`),
      `${stack}: the first block after the title is not the download of this file`,
    );
    const stated = Number(block.match(/this file is (\d+) KB/)?.[1]);
    assert.equal(
      stated,
      Math.round(Buffer.byteLength(text, "utf8") / 1000),
      `${stack}: stated size`,
    );
    assert.ok(brief.length >= 5 && brief.length <= 6, `${stack}: ${brief.length} brief bullets`);
    for (const rule of brief) {
      assert.ok(rule.length < 120, `${stack}: brief bullet is ${rule.length} characters: ${rule}`);
    }
    assert.ok(
      brief.some((rule) => /NWC code/.test(rule)),
      `${stack}: brief never asks for NWC`,
    );
    assert.ok(
      brief.some((rule) => /LSC code/.test(rule)),
      `${stack}: brief never asks for LSC`,
    );
    assert.ok(
      brief.includes("Do not suggest rotating or revoking a code because it was pasted here."),
      `${stack}: brief allows a rotation suggestion`,
    );
    assert.ok(
      text.indexOf("**Step 0 in brief**") < text.indexOf("These directions describe OpenReceive"),
      `${stack}: prose before the brief`,
    );
  }
});

// A rewrite of the full file kept "two codes, one per message" and cut the curl
// block. The URL people paste is therefore a cover with nothing to choose from
// but the curl line to the full file.
test("every payload has a cover: one curl line to its full.md and nothing else to rewrite", () => {
  assert.deepEqual(
    covers.map(({ stack }) => stack).sort(),
    payloads.map(({ stack }) => stack).sort(),
    "one cover per payload",
  );
  for (const { stack, text } of covers) {
    assert.ok(text.length <= 400, `${stack}: cover is ${text.length} characters`);
    const curls = text.split("\n").filter((line) => line.includes("curl -fsSL"));
    assert.equal(curls.length, 1, `${stack}: ${curls.length} curl lines`);
    assert.equal(curls[0].trim(), `curl -fsSL ${fullUrl(stack)}`, stack);
    assert.doesNotMatch(text, /^\s*[-*] /m, `${stack}: cover has a bullet`);
    const full = payloads.find((payload) => payload.stack === stack).text;
    const fullRelease = full.match(/These directions describe OpenReceive (\S+)\./)?.[1];
    assert.equal(fullRelease, release, `${stack}: full file release`);
    assert.match(
      text,
      new RegExp(`^# OpenReceive agent directions: .+ \\(${fullRelease}\\)\n`),
      stack,
    );
    const stated = Number(text.match(/These directions are (\d+) KB\./)?.[1]);
    assert.equal(
      stated,
      Math.round(Buffer.byteLength(full, "utf8") / 1000),
      `${stack}: stated size`,
    );
  }
});

test("every payload's Non-negotiables call the chat paste the supported path", () => {
  for (const { stack, text } of payloads) {
    assert.match(
      text,
      /^- Do not suggest rotating, revoking or replacing a code because it was pasted\n {2}into this chat; that is the supported path\.$/m,
      stack,
    );
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

// The 0.4.16 eval agent (evals/directions) audited the stack before asking,
// read Playwright from another checkout, settled the test invoice through the
// fake wallet's control port, then installed mail and added a cron service.
test("the WooCommerce payload ends at test-invoice and keeps the agent in the store", () => {
  const text = payloads.find(({ stack }) => stack === "woocommerce").text;
  const step = stepZero(text);
  const stepThree = text.match(/^## Step 3\b[^\n]*\n([\s\S]*?)(?=^## )/m)?.[1] ?? "";
  assert.match(step, /PHP\s+extensions, Docker images and the database wait until both codes/);
  assert.match(stepThree, /You cannot pay the invoice/);
  assert.match(stepThree, /Setup ends here\./);
  assert.match(stepThree, /Do not install mail software/);
  assert.match(text, /Never read or run anything from another project/);
  assert.match(text, /A browser, Playwright/);
  assert.doesNotMatch(text, /run WordPress scheduled work from a system cron/);
  // Image-only Compose files get Dockerfiles and build: keys, not invented services.
  assert.match(text, /Compose files with only `image:` lines/);
  assert.match(text, /FROM wordpress:cli-php8\.2\nUSER root[\s\S]*?USER www-data/);
  // The inlined quickstart's wp-admin screens are not a second procedure.
  assert.match(text, /its wp-admin screens are only for a store with no WP-CLI/);
});

// The 0.4.18 Node eval agent ended on "checkout is live", took the reply
// "Yes, go ahead" as a request for the quickstart's browser check, and ran it
// with Playwright from another checkout.
test("the Node payload ends with setup finished and keeps the agent in the app", () => {
  const text = payloads.find(({ stack }) => stack === "node").text;
  const ending = text.match(/^## After the quickstart\b[^\n]*\n([\s\S]*?)(?=^## )/m)?.[1] ?? "";
  assert.match(ending, /browser check in the quickstart's\s+step 6[\s\S]*?is theirs/);
  assert.match(ending, /You cannot pay the invoice/);
  assert.match(ending, /Say "Setup is finished" in one message/);
  assert.match(ending, /Do not offer more work or end the message on a question/);
  assert.match(text, /Never read or run anything from another\s+project/);
  assert.match(text, /A browser and Playwright are not part of setup/);
});
