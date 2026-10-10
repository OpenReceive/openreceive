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
    text.includes(`wp plugin install openreceive --version=${release} --activate`),
    "the WordPress.org install line is pinned to this release",
  );
  assert.ok(
    text.includes(
      `wp plugin install https://github.com/OpenReceive/openreceive/releases/download/v${release}/openreceive-wordpress-${release}.zip --activate`,
    ),
    "the release ZIP fallback is pinned to this release",
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

// The 0.4.16 trial agent audited the stack before asking,
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

// The 0.4.18 Next.js trial agent could not get doctor to see `.env.local`, ran
// `set -a; . ./.env.local`, and the `&` in each code printed pieces of both.
test("the @openreceive/node payloads say doctor reads the env file and never to source it", () => {
  const envFiles = { node: ".env", fastify: ".env", next: ".env.local" };
  for (const [stack, file] of Object.entries(envFiles)) {
    const { text } = payloads.find((payload) => payload.stack === stack);
    assert.ok(
      text.includes(`Doctor reads \`${file}\` itself. Never source it into a shell`),
      stack,
    );
  }
});

// On 0.4.21 one Django video agent of three copied the quickstart's browser
// checklist out after "Setup is finished".
// The 0.4.18 Node and Fastify trial agents ended on "checkout is live", took
// the reply "Yes, go ahead" as a request for the quickstart's browser check,
// and ran it with Playwright from another checkout. On 0.4.20 the Next.js
// agents wrote 30-line wrap-ups, one deleted the order behind its link, and
// both called stablecoins unavailable on a $1–$7 shop over one swap minimum.
test("every library payload ends with setup finished and keeps the agent in the app", () => {
  const libraries = payloads.filter(({ stack }) => !["woocommerce", "btcpay"].includes(stack));
  assert.equal(libraries.length, 8);
  for (const { stack, text } of libraries) {
    const ending = text.match(/^## After the quickstart\b[^\n]*\n([\s\S]*?)(?=^## )/m)?.[1] ?? "";
    assert.match(ending, /The browser check in the quickstart's\s[\s\S]*?is theirs/, stack);
    assert.match(ending, /You cannot pay the invoice/, stack);
    assert.match(
      ending,
      /Your last message starts "Setup is finished" and has at most\s+five/,
      stack,
    );
    assert.match(ending, /Send nothing after it\./, stack);
    assert.match(ending, /copy out the quickstart's browser checklist/, stack);
    assert.match(ending, /offer more work, or end\s+the message on a question/, stack);
    assert.match(ending, /Keep that order; do not delete it/, stack);
    assert.match(ending, /never say a coin\s+will not work or will not be\s+offered/, stack);
    assert.match(text, /Never read or run anything from another\s+project/, stack);
    assert.match(text, /A browser and Playwright are not part of setup/, stack);
  }
  const btcpay = payloads.find(({ stack }) => stack === "btcpay").text;
  assert.match(btcpay, /Say "Setup is finished" in one\s+message/);
});

// On 0.4.21 one Fastify agent of three answered "Enable Bitcoin and stablecoin
// payments" with a yes/no about swaps, one read `.env` back after writing it
// (codes on camera), and all three tried `pkill -f "node server.js"`, which on
// a shared machine stops other people's servers.
test("every library payload's Step 0 sends the swap walkthrough, checks codes by name, and restarts by pid", () => {
  const libraries = payloads.filter(({ stack }) => !["woocommerce", "btcpay"].includes(stack));
  for (const { stack, text } of libraries) {
    const step = stepZero(text);
    assert.match(step, /this message IS the walkthrough below/, stack);
    assert.doesNotMatch(step, /skip the yes\/no/, stack);
    const file = stack === "next" ? ".env.local" : ".env";
    assert.ok(
      step.includes(`\`grep -E '^(NWC_URI|LSC_URI_PRIMARY)=.' ${file} | cut -d= -f1\``),
      `${stack}: Step 0 does not check ${file} by name`,
    );
    assert.match(step, /not by reading the file/, stack);
    assert.match(text, /Never `pkill` or `killall` by name/, stack);
    assert.match(text, /on the port it already uses/, stack);
    assert.match(text, /Start it the way this project already\s+does/, stack);
    assert.match(text, /Run commands where the app runs/, stack);
    assert.match(text, /To check that the running app sees the codes, run doctor/, stack);
  }
});

// In the 2026-10-09 trials Cursor wrote the swap code into .env with
// `python3 -c` in all three Fastify runs, putting the code on the command
// line; only the WooCommerce directions named the file-editing tool. One
// Fastify agent passed the Web Request to the shop's cookie helper, so every
// buyer got a 403: the quickstart's own example did the same.
test("every library payload writes codes with the file tool, and Express and Fastify read the session from native", () => {
  const libraries = payloads.filter(({ stack }) => !["woocommerce", "btcpay"].includes(stack));
  for (const { stack, text } of libraries) {
    const step = stepZero(text);
    assert.match(step, /with your file-editing\s+tool/, stack);
    assert.match(step, /Never write it with a shell\s+command/, stack);
  }
  for (const stack of ["node", "fastify"]) {
    const { text } = payloads.find((payload) => payload.stack === stack);
    assert.doesNotMatch(text, /currentUser\(request\)/, stack);
    assert.match(text, /sessions\.currentUser\(native\)/, stack);
  }
});

// The 2026-10-10 WooCommerce trials ended on 10 to 14 lines that listed
// each coin as available or "unavailable — below the provider minimum", the
// wrap-up the library directions already ruled out after the Next.js video.
test("the WooCommerce hand-over is short and never calls a coin unavailable", () => {
  const { text } = payloads.find((payload) => payload.stack === "woocommerce");
  const ending = text.match(/^Setup ends here\.[\s\S]*?question\.\n/m)?.[0] ?? "";
  assert.match(ending, /starts "Setup is finished" and has at most six short lines/);
  assert.match(ending, /Do not list\s+each coin's availability, mention a minimum/);
  assert.match(ending, /Send nothing\s+after it/);
});
