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
// Lovable's agent has no shell, and Bolt's runs commands in a browser sandbox
// that cannot reach every host: their payloads and covers name the full file
// for the agent's fetch tool instead of a curl line, and they keep codes as
// the platform's secrets.
const FETCH_ONLY = new Set(["lovable", "bolt"]);
// Bolt's agent cannot store a secret: the user adds each code in Bolt's
// Secrets tab, so a code pasted into the chat has nowhere to go.
const SECRETS_TAB_ONLY = new Set(["bolt"]);

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
  const block = body.match(/^```(?:sh|text)\n([\s\S]*?)\n```\n/)?.[1] ?? "";
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
      block.includes(
        FETCH_ONLY.has(stack) ? `\n${fullUrl(stack)}\n` : `\ncurl -fsSL ${fullUrl(stack)}\n`,
      ),
      `${stack}: the first block after the title is not the download of this file`,
    );
    const stated = Number(block.match(/this file is (\d+) KB/i)?.[1]);
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
    if (FETCH_ONLY.has(stack)) {
      assert.equal(curls.length, 0, `${stack}: a cover for an agent with no shell has a curl line`);
      const urls = text.split("\n").filter((line) => line.includes("https://"));
      assert.deepEqual(
        urls.map((line) => line.trim()),
        [fullUrl(stack)],
        stack,
      );
    } else {
      assert.equal(curls.length, 1, `${stack}: ${curls.length} curl lines`);
      assert.equal(curls[0].trim(), `curl -fsSL ${fullUrl(stack)}`, stack);
    }
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
    if (SECRETS_TAB_ONLY.has(stack)) {
      assert.match(
        text,
        /^- Do not suggest rotating, revoking or replacing a code because it was pasted\n {2}into this chat; ask the user to save it as a secret instead\.$/m,
        stack,
      );
      continue;
    }
    assert.match(
      text,
      /^- Do not suggest rotating, revoking or replacing a code because it was pasted\n {2}into this chat; that is the supported path\.$/m,
      stack,
    );
  }
});

test("every payload makes the first question a hard rule", () => {
  for (const { stack, text } of payloads) {
    const step = stepZero(text);
    assert.match(step, /your next action is a question to the user/, stack);
    if (SECRETS_TAB_ONLY.has(stack)) assert.match(step, /Only the user can add a secret/, stack);
    else assert.match(step, /paste each code\s+into (the|this) chat/, stack);
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
  const envFiles = {
    node: ".env",
    fastify: ".env",
    next: ".env.local",
    nestjs: ".env",
    sveltekit: ".env",
    nuxt: ".env",
    astro: ".env",
    "react-router": ".env",
    "tanstack-start": ".env",
  };
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
  const libraries = payloads.filter(
    ({ stack }) =>
      ![
        "woocommerce",
        "edd",
        "paymenter",
        "fossbilling",
        "prestashop",
        "odoo",
        "medusa",
        "vendure",
        "btcpay",
        "lovable",
        "bolt",
        "mobile",
      ].includes(stack),
  );
  assert.equal(libraries.length, 15);
  for (const { stack, text } of libraries) {
    const ending = text.match(/^## After the quickstart\b[^\n]*\n([\s\S]*?)(?=^## )/m)?.[1] ?? "";
    assert.match(
      ending,
      /The browser check (?:in the quickstart's|of that page)\s[\s\S]*?is theirs/,
      stack,
    );
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
  const libraries = payloads.filter(
    ({ stack }) =>
      ![
        "woocommerce",
        "edd",
        "paymenter",
        "fossbilling",
        "prestashop",
        "odoo",
        "medusa",
        "vendure",
        "btcpay",
        "lovable",
        "bolt",
        "mobile",
      ].includes(stack),
  );
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
test("every library payload writes codes with the file tool, and Express, Fastify and NestJS read the session from native", () => {
  const libraries = payloads.filter(
    ({ stack }) =>
      ![
        "woocommerce",
        "edd",
        "paymenter",
        "fossbilling",
        "prestashop",
        "odoo",
        "medusa",
        "vendure",
        "btcpay",
        "lovable",
        "bolt",
        "mobile",
      ].includes(stack),
  );
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
  const nest = payloads.find((payload) => payload.stack === "nestjs").text;
  assert.doesNotMatch(nest, /currentUser\(request\)/);
  assert.match(nest, /auth\.currentUser\(native as Request\)/);
});

// Nest registers its JSON body parser when the app starts listening, after
// anything main.ts mounts. Until 0.4.27 a plain app.use() of the Express
// adapter saw no body and refused every checkout, so the directions added
// app.useBodyParser("json"); the adapter now reads the body itself. Nest's
// guards never run for middleware.
test("the NestJS payload mounts with no body parser and checks ownership in authorize", () => {
  const text = payloads.find(({ stack }) => stack === "nestjs").text;
  const own = text.slice(0, text.indexOf("## The quickstart, in full"));
  assert.match(own, /needs\s+no `app\.useBodyParser\("json"\)`/);
  assert.match(own, /guards, interceptors and pipes do not run for middleware/);
  assert.match(own, /`app\.get\(DataSource\)`/);
  const quickstart = text.slice(text.indexOf("## The quickstart, in full"));
  assert.doesNotMatch(
    quickstart,
    /^\s*app\.useBodyParser\("json"\);$/m,
    "the mount still adds a parser",
  );
  assert.match(quickstart, /With 0\.4\.26 or older, add\s+`app\.useBodyParser\("json"\)`/);
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

// Paymenter takes the WooCommerce shape: a release ZIP, codes through stdin,
// a doctor and a test invoice. Its own trap is artisan as root, which leaves
// Paymenter's log owned by root and fails every page after it.
test("the Paymenter payload pins the release ZIP, runs artisan as the web user and ends at test-invoice", () => {
  const text = payloads.find(({ stack }) => stack === "paymenter").text;
  const step = stepZero(text);
  const stepThree = text.match(/^## Step 3\b[^\n]*\n([\s\S]*?)(?=^## )/m)?.[1] ?? "";
  assert.ok(
    text.includes(
      `https://github.com/OpenReceive/openreceive/releases/download/v${release}/openreceive-paymenter-${release}.zip`,
    ),
    "the extension ZIP is pinned to this release",
  );
  assert.doesNotMatch(text, /\{\{release\}\}/);
  assert.match(text, /php artisan app:extension:install gateway OpenReceive/);
  assert.match(text, /openreceive:configure --nwc-uri=- < \/tmp\/openreceive-code/);
  assert.match(text, /--lsc-uri-primary=-/);
  assert.match(text, /file-editing tool, not a shell command/);
  assert.match(text, /docker compose exec -T -u nginx paymenter php artisan/);
  assert.match(text, /Run `php artisan` as the web server's user, never as root\./);
  assert.match(step, /this message IS the walkthrough/);
  assert.match(step, /do not tell them to revoke or replace a\s+code because it was pasted here/);
  assert.match(stepThree, /php artisan openreceive:test-invoice --new/);
  assert.match(stepThree, /You cannot pay the invoice/);
  assert.match(stepThree, /Setup ends here\./);
  assert.match(stepThree, /starts "Setup is finished" and has at most six short lines/);
  assert.match(stepThree, /Do not\s+list each coin's availability, mention a minimum/);
  assert.match(stepThree, /Do not add containers, services, workers or cron jobs/);
  assert.match(text, /Never read or run anything from another project/);
  assert.match(text, /`tinker` and reading the extension's source are not part of setup/);
});

// Easy Digital Downloads takes the WooCommerce shape, in the same plugin:
// WP-CLI from stdin, --enable for EDD's active gateways, and a test order of
// its own, since EDD has no order-create command an agent should reach for.
test("the Easy Digital Downloads payload installs the WordPress plugin, enables the EDD gateway and ends at test-invoice", () => {
  const text = payloads.find(({ stack }) => stack === "edd").text;
  const step = stepZero(text);
  const stepThree = text.match(/^## Step 3\b[^\n]*\n([\s\S]*?)(?=^## )/m)?.[1] ?? "";
  assert.match(
    text,
    new RegExp(
      `wp plugin install openreceive --version=${release.replaceAll(".", "\\.")} --activate`,
    ),
  );
  assert.ok(
    text.includes(
      `https://github.com/OpenReceive/openreceive/releases/download/v${release}/openreceive-wordpress-${release}.zip`,
    ),
  );
  assert.doesNotMatch(text, /\{\{release\}\}/);
  assert.match(text, /wp openreceive configure --nwc-uri=- < \/tmp\/openreceive-code/);
  assert.match(
    text,
    /wp openreceive configure --enable`, which adds OpenReceive to EDD's\s+active gateways/,
  );
  assert.match(text, /Store: Easy Digital Downloads active/);
  assert.match(text, /file-editing tool, not a shell command/);
  assert.match(step, /this message IS the walkthrough/);
  assert.match(stepThree, /wp openreceive test-invoice --new/);
  assert.match(stepThree, /signed in\s+to WordPress as the shop manager/);
  assert.match(stepThree, /You cannot pay the invoice/);
  assert.match(stepThree, /starts "Setup is finished" and has at most six short lines/);
  assert.match(text, /`wp eval` and reading the plugin's source are not part of setup/);
});

// PrestaShop takes the FOSSBilling shape. Its own steps: the ZIP unzips into
// modules/, PrestaShop's console installs it, and PrestaShop has no
// scheduler, so the last message gives the merchant the reconcile cron line.
test("the PrestaShop payload pins the release ZIP, adds GMP, installs with bin/console and ends at test-invoice", () => {
  const text = payloads.find(({ stack }) => stack === "prestashop").text;
  const step = stepZero(text);
  const stepThree = text.match(/^## Step 3\b[^\n]*\n([\s\S]*?)(?=^## )/m)?.[1] ?? "";
  assert.ok(
    text.includes(
      `https://github.com/OpenReceive/openreceive/releases/download/v${release}/openreceive-prestashop-${release}.zip`,
    ),
    "the module ZIP is pinned to this release",
  );
  assert.doesNotMatch(text, /\{\{release\}\}/);
  assert.match(text, /docker-php-ext-install gmp/);
  assert.match(text, /unzip -oq openreceive-prestashop-[^ ]+\.zip -d modules/);
  assert.match(text, /php bin\/console prestashop:module install openreceive/);
  assert.match(text, /openreceive:configure --nwc-uri=- < \/tmp\/openreceive-code/);
  assert.match(text, /--lsc-uri-primary=-/);
  assert.match(text, /file-editing tool, not a shell command/);
  assert.match(text, /docker compose exec -T -u www-data prestashop php bin\/console/);
  assert.match(text, /Run `php` as the web server's user, never as root\./);
  assert.match(step, /this message IS the walkthrough/);
  assert.match(stepThree, /php bin\/console openreceive:test-invoice --new/);
  assert.match(stepThree, /You cannot pay the invoice/);
  assert.match(stepThree, /starts "Setup is finished" and has at most six short lines/);
  assert.match(stepThree, /php bin\/console openreceive:reconcile/);
  assert.match(stepThree, /do not add it yourself/);
  assert.match(text, /Never read or run anything from another\s+project/);
});

// FOSSBilling takes the Paymenter shape. Its own steps: the official image
// lacks GMP, the console commands exist only once the module is active, and
// the test invoice opens for an admin, not for its test client.
test("the FOSSBilling payload pins the release ZIP, adds GMP, activates the module and ends at test-invoice", () => {
  const text = payloads.find(({ stack }) => stack === "fossbilling").text;
  const step = stepZero(text);
  const stepThree = text.match(/^## Step 3\b[^\n]*\n([\s\S]*?)(?=^## )/m)?.[1] ?? "";
  assert.ok(
    text.includes(
      `https://github.com/OpenReceive/openreceive/releases/download/v${release}/openreceive-fossbilling-${release}.zip`,
    ),
    "the extension ZIP is pinned to this release",
  );
  assert.doesNotMatch(text, /\{\{release\}\}/);
  assert.match(text, /docker-php-ext-install gmp/);
  assert.match(text, /php modules\/Openreceive\/activate\.php/);
  assert.match(text, /openreceive:configure --nwc-uri=- < \/tmp\/openreceive-code/);
  assert.match(text, /--lsc-uri-primary=-/);
  assert.match(text, /file-editing tool, not a shell command/);
  assert.match(text, /docker compose exec -T -u www-data fossbilling php console\.php/);
  assert.match(text, /Run `php` as the web server's user, never as root\./);
  assert.match(step, /this message IS the walkthrough/);
  assert.match(step, /do not tell them to revoke or replace a\s+code because it was pasted here/);
  assert.match(stepThree, /php console\.php openreceive:test-invoice --new/);
  assert.match(stepThree, /signed in\s+to FOSSBilling's admin area/);
  assert.match(stepThree, /You cannot pay the invoice/);
  assert.match(stepThree, /Setup ends here\./);
  assert.match(stepThree, /starts "Setup is finished" and has at most six short lines/);
  assert.match(stepThree, /Do not\s+list each coin's availability, mention a minimum/);
  assert.match(stepThree, /Do not add containers, services, workers or cron jobs/);
  assert.match(text, /Never read or run anything from another\s+project/);
});

// Medusa takes the library shape for its codes (the Medusa server's .env, by
// name, with the file tool) and the billing panels' for the rest: a plugin
// from npm, a script that offers it in the regions, and no hooks to write.
// The starter's Tailwind v3 build refuses the checkout's stylesheet, so the
// storefront's route serves it instead of an import.
test("the Medusa payload installs the plugin, offers it in the regions, proves the routes and stops", () => {
  const text = payloads.find(({ stack }) => stack === "medusa").text;
  const step = stepZero(text);
  assert.ok(
    step.includes("`grep -E '^(NWC_URI|LSC_URI_PRIMARY)=.' .env | cut -d= -f1`"),
    "Step 0 checks the Medusa server's .env by name",
  );
  assert.match(step, /with your file-editing\s+tool/);
  assert.match(step, /Never write it with a shell command/);
  assert.match(step, /this message IS the walkthrough/);
  assert.match(step, /do not tell them to revoke or replace a\s+code because it was pasted here/);
  assert.match(text, /npm install @openreceive\/medusa/);
  assert.match(text, /@openreceive\/medusa\/providers\/openreceive/);
  assert.match(text, /npx medusa db:migrate/);
  assert.match(
    text,
    /npx medusa exec \.\/node_modules\/@openreceive\/medusa\/dist\/enable-openreceive\.js/,
  );
  assert.match(text, /npx openreceive doctor/);
  assert.match(text, /Do not import\s+`@openreceive\/react\/styles\.css`/);
  assert.match(text, /x-publishable-api-key/);
  assert.match(text, /"code":"FORBIDDEN"/);
  assert.match(text, /Never `pkill` or `killall` by name/);
  assert.match(text, /You cannot pay an invoice/);
  assert.match(
    text,
    /Your last message starts "Setup is finished" and has at most five short\s+lines/,
  );
  assert.match(text, /Do not add\s+containers, services, workers or cron jobs/);
  assert.match(text, /Never read or run anything from another\s+project/);
  assert.match(text, /Do not write your own payment provider/);
});

// Vendure takes Medusa's shape: the codes in the Vendure server's .env by
// name with the file tool, a plugin from npm, a script that creates the
// payment method, and no hooks. The storefront's route serves the checkout's
// stylesheet and forwards its calls with the buyer's session, and the curl
// through it must answer FORBIDDEN.
test("the Vendure payload installs the plugin, creates the method, proves the routes and stops", () => {
  const text = payloads.find(({ stack }) => stack === "vendure").text;
  const step = stepZero(text);
  assert.ok(
    step.includes("`grep -E '^(NWC_URI|LSC_URI_PRIMARY)=.' .env | cut -d= -f1`"),
    "Step 0 checks the Vendure server's .env by name",
  );
  assert.match(step, /with your file-editing\s+tool/);
  assert.match(step, /Never write it with a shell command/);
  assert.match(step, /this message IS the walkthrough/);
  assert.match(step, /do not tell them to revoke or replace a\s+code because it was pasted here/);
  assert.match(text, /npm install @openreceive\/vendure/);
  assert.match(text, /import \{ OpenReceivePlugin \} from "@openreceive\/vendure\/plugin"/);
  assert.match(text, /node node_modules\/@openreceive\/vendure\/dist\/enable-openreceive\.js/);
  assert.match(text, /npx openreceive doctor --url http:\/\/localhost:3000/);
  assert.match(text, /Do not import `@openreceive\/react\/styles\.css`/);
  assert.match(text, /\/openreceive\/order/);
  assert.match(text, /"code":"FORBIDDEN"/);
  assert.match(text, /Never `pkill` or `killall` by name/);
  assert.match(text, /You cannot pay an invoice/);
  assert.match(
    text,
    /Your last message starts "Setup is finished" and has at most five short\s+lines/,
  );
  assert.match(text, /Do not add\s+containers, services, workers or cron jobs/);
  assert.match(text, /Never read or run anything from another\s+project/);
  assert.match(text, /Do not write your own payment handler/);
});

// Lovable's agent has no terminal and Lovable keeps codes as project secrets:
// its payload asks through the secret input, never for a file or a command,
// sends the agent to the published migration, and keeps fulfillment in SQL.
test("the Lovable payload asks through the secret input and needs no terminal", () => {
  const text = payloads.find(({ stack }) => stack === "lovable").text;
  const own = text.slice(0, text.indexOf("## The quickstart, in full"));
  const step = stepZero(text);
  assert.match(step, /Lovable's secure secret input/);
  assert.match(step, /Lovable reserves the\s+`SUPABASE_` prefix/);
  assert.doesNotMatch(step, /file-editing tool|\.env\.local|grep -E/);
  assert.match(own, /never put one in `\.env`/);
  assert.match(own, /https:\/\/openreceive\.org\/guides\/supabase-migration\.md/);
  assert.match(own, /No `onPaid` and no `db`/);
  assert.match(own, /buyer_token/);
  assert.match(own, /Your last message starts "Setup is finished"/);
  for (const command of [/\bcurl\b/, /\bnpx\b/, /\bdoctor\b/, /docker compose/, /\bpkill\b/]) {
    assert.doesNotMatch(own, command, `the Lovable steps mention ${command}`);
  }
});

// Bolt's pages are a Vite React app and its payment routes a Supabase Edge
// Function on another site: the payload asks for codes through Bolt's Secrets
// tab, sends the buyer's token, lets Bolt's changing preview host through, and
// keeps the price out of the browser's hands. Bolt functions open with a
// corsHeaders boilerplate that would answer for OpenReceive; the payload
// forbids it.
test("the Bolt payload keeps codes in Secrets, the buyer in a token and the price in the database", () => {
  const text = payloads.find(({ stack }) => stack === "bolt").text;
  const own = text.slice(0, text.indexOf("## The quickstart, in full"));
  const step = stepZero(text);
  assert.match(step, /database\s+icon at the top → \*\*Secrets\*\*/);
  assert.match(step, /do not write it into\s+any file, code or log/);
  assert.match(step, /`SUPABASE_SERVICE_ROLE_KEY`\. Do not ask for them/);
  assert.match(own, /never put a code in `\.env`/i);
  assert.match(own, /https:\/\/openreceive\.org\/guides\/supabase-migration\.md/);
  assert.match(own, /before insert` trigger/);
  assert.match(own, /never update an order's total or status/);
  assert.match(own, /No `onPaid` and no `db`/);
  assert.match(own, /never wrap the\s+handler in the usual `corsHeaders` boilerplate/);
  assert.match(own, /`withSupabaseToken`/);
  assert.match(own, /Your last message starts "Setup is finished"/);
  assert.match(text, /npm:@openreceive\/http@\^/);
  assert.match(text, /local-credentialless\\\.webcontainer-api\\\.io/);
  assert.match(text, /cors: \{ origins: shopOrigins\(request\) \}/);
  assert.match(text, /supabase\.auth\.getUser\(token\)/);
  assert.match(text, /total::text/);
  for (const command of [/\bcurl\b/, /\bnpx\b/, /\bdoctor\b/, /docker compose/, /\bpkill\b/]) {
    assert.doesNotMatch(own, command, `the Bolt steps mention ${command}`);
  }
});

// The Supabase badge (0.4.24) was earned on the Node directions with an
// opening message that named Supabase; without that, an agent reached the
// pooler, the certificate and the Data API lock-down only through one line of
// further reading. Each server stack that can sit on Supabase carries the
// branch in its database step.
// A mobile app pays on its server's checkout page: the payload sends the agent
// to the server's own directions, and keeps codes and the paid decision there.
test("the mobile payload keeps the codes and the paid decision on the server", () => {
  const text = payloads.find(({ stack }) => stack === "mobile").text;
  const step = stepZero(text);
  assert.match(step, /What does the app sell\?/);
  assert.match(step, /Find the app's server/);
  assert.match(step, /https:\/\/openreceive\.org\/agent-directions\/node\/full\.md/);
  assert.match(step, /Never put either in the app/);
  assert.match(step, /EXPO_PUBLIC_/);
  assert.match(text, /The app never decides "paid"/);
  for (const opener of [
    "expo-web-browser",
    "url_launcher",
    "SFSafariViewController",
    "Custom Tabs",
  ]) {
    assert.ok(text.includes(opener), `mobile: no ${opener}`);
  }
});

test("every server payload that can run on Supabase has the Supabase branch in its database step", () => {
  const stacks = [
    "node",
    "fastify",
    "next",
    "nestjs",
    "tanstack-start",
    "fastapi",
    "django",
    "flask",
  ];
  for (const stack of stacks) {
    const { text } = payloads.find((payload) => payload.stack === stack);
    const branch = text.match(/^### If the database is Supabase\n([\s\S]*?)(?=^## )/m)?.[1] ?? "";
    assert.notEqual(branch, "", `${stack}: no Supabase branch`);
    assert.match(branch, /transaction pooler \(port `6543`/, stack);
    assert.match(branch, /prod-ca-2021\.crt/, stack);
    assert.match(
      branch,
      /revoke all on table openreceive_payments, openreceive_meta from anon, authenticated;/,
      stack,
    );
  }
});
