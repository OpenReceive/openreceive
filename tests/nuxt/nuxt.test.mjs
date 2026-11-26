import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { freePort, startTlsWallet } from "../workers/harness.mjs";

// @openreceive/nuxt in a real Nuxt 4 app (tests/nuxt/app), built with
// `nuxt build` and run as the built Node server, on SQLite, with a
// receive-only wallet on a local relay through a TLS front (OpenReceive
// accepts wss relays only). The app writes no payment route and no checkout
// component of its own: the module registers both, under the app's /pay
// prefix, and the app's server/openreceive.ts holds the three hooks.
//
//   docker compose -f tests/workers/compose.yml up -d --wait
//   npm ci --prefix tests/nuxt && npm run build:packages
//   OPENRECEIVE_TEST_RELAY_URL=ws://127.0.0.1:57777 npm run test:nuxt

const relayUrl = process.env.OPENRECEIVE_TEST_RELAY_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const nuxtBin = path.join(here, "node_modules", ".bin", "nuxt");
const skip =
  (!relayUrl || !existsSync(nuxtBin)) &&
  "Set OPENRECEIVE_TEST_RELAY_URL and run npm ci --prefix tests/nuxt (see tests/nuxt/nuxt.test.mjs)";

const appDir = path.join(here, "app");
const MARKER = "openreceive-server-only-marker";
// The packages the app reaches, directly or through the module.
const PACKAGES = ["core", "provider-data", "browser", "elements", "vue", "node", "http", "nuxt"];

let relay;
let server;
let scratch;
let base;
let dbFile;
const output = [];

/**
 * Each built package where the app resolves it, as a registry install would
 * put it: one copy of Nuxt, Vue and h3 for all of them, from this lane.
 */
function installPackages() {
  for (const name of PACKAGES) {
    const source = path.join(repo, "packages", "js", name);
    const manifest = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"));
    const target = path.join(here, "node_modules", "@openreceive", name);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    cpSync(path.join(source, "package.json"), path.join(target, "package.json"));
    for (const entry of manifest.files ?? ["dist"]) {
      if (existsSync(path.join(source, entry))) {
        cpSync(path.join(source, entry), path.join(target, entry), { recursive: true });
      }
    }
  }
}

function nuxt(command, directory, env = {}) {
  const result = spawnSync(nuxtBin, [command, directory], {
    cwd: here,
    encoding: "utf8",
    env: { ...process.env, NUXT_TELEMETRY_DISABLED: "1", CI: "1", ...env },
    timeout: 300_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

async function startServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(appDir, ".output", "server", "index.mjs")], {
    cwd: appDir,
    env: { ...process.env, ...env, PORT: String(port), HOST: "127.0.0.1" },
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the server exited:\n${output.join("")}`);
    const up = await fetch(`${url}/api/checkout/none`).then(
      () => true,
      () => false,
    );
    if (up) return { child, base: url };
    if (Date.now() > deadline) throw new Error(`the server did not start:\n${output.join("")}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

before(async () => {
  if (skip) return;
  scratch = mkdtempSync(path.join(tmpdir(), "openreceive-nuxt-"));
  dbFile = path.join(scratch, "shop.db");
  installPackages();
  // Built with no wallet code anywhere, as a merchant's CI builds it.
  const {
    NWC_URI: _nwc,
    LSC_URI_PRIMARY: _lsc,
    LSC_URI_BACKUP: _backup,
    ...buildEnv
  } = process.env;
  const build = spawnSync(nuxtBin, ["build", appDir], {
    cwd: here,
    encoding: "utf8",
    env: { ...buildEnv, NUXT_TELEMETRY_DISABLED: "1", CI: "1" },
    timeout: 300_000,
  });
  assert.equal(build.status, 0, `nuxt build failed:\n${build.stdout}${build.stderr}`);
  relay = await startTlsWallet(relayUrl, scratch);
  ({ child: server, base } = await startServer({
    NWC_URI: relay.wallet.nwcUri,
    NODE_EXTRA_CA_CERTS: relay.ca,
    SHOP_DB: dbFile,
  }));
});

after(async () => {
  if (server !== undefined && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
  }
  relay?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** A visitor with the shop's cookie, once it has placed an order. */
class Visitor {
  cookie = undefined;

  async order() {
    const response = await fetch(`${base}/orders`, {
      method: "POST",
      headers: this.cookie ? { cookie: this.cookie } : {},
    });
    assert.equal(response.status, 200);
    this.cookie ??= response.headers.get("set-cookie")?.split(";")[0];
    return (await response.json()).id;
  }

  async page(reference) {
    const response = await fetch(`${base}/checkout/${reference}`, {
      headers: this.cookie ? { cookie: this.cookie } : {},
    });
    return { status: response.status, html: await response.text() };
  }

  async route(route, body, prefix = "/pay") {
    const response = await fetch(`${base}${prefix}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: response.status, body: json };
  }
}

function orderRow(reference) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return db.prepare("SELECT state FROM orders WHERE id = ?").get(reference);
  } finally {
    db.close();
  }
}

function attemptRows(reference) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return db
      .prepare("SELECT status, client_ip FROM openreceive_payments WHERE reference = ?")
      .all(reference);
  } finally {
    db.close();
  }
}

test("the order's page renders the module's checkout, on the module's prefix, with its styles", {
  skip,
}, async () => {
  const buyer = new Visitor();
  const reference = await buyer.order();
  const page = await buyer.page(reference);
  assert.equal(page.status, 200, page.html);
  const element = page.html.match(/<openreceive-checkout\b[^>]*>/)?.[0];
  assert.ok(element, "the server-rendered page has the checkout element");
  assert.match(element, new RegExp(`reference="${reference}"`));
  assert.match(element, /prefix="\/pay"/, "the component took the module's prefix");

  const stylesheets = [...page.html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(
    (match) => match[1],
  );
  const css = await Promise.all(
    stylesheets.map((href) => fetch(new URL(href, base)).then((response) => response.text())),
  );
  assert.ok(
    css.some((text) => text.includes("openreceive")),
    `the page links @openreceive/vue/styles.css (stylesheets: ${stylesheets.join(", ")})`,
  );

  const stranger = new Visitor();
  assert.equal((await stranger.page(reference)).status, 404);
});

test("the module's route mints for the buyer, refuses a stranger and a payer-supplied amount", {
  skip,
}, async () => {
  const buyer = new Visitor();
  const reference = await buyer.order();

  const created = await buyer.route("/checkouts", { reference });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.match(created.body.checkout.bolt11, /^ln/);
  assert.equal(created.body.checkout.amount_msats, 5_000_000);
  assert.equal(created.body.description, "A widget");

  const stranger = new Visitor();
  assert.equal((await stranger.route("/checkouts", { reference })).status, 403);

  const priced = await buyer.route("/checkouts", {
    reference,
    amount: { currency: "SAT", value: "1" },
  });
  assert.equal(priced.status, 400, JSON.stringify(priced.body));

  // Only the configured prefix is mounted.
  const unmounted = await buyer.route("/checkouts", { reference }, "/openreceive");
  assert.equal(unmounted.status, 404);

  // rateLimiting is on, and the module gave it the socket address.
  const rows = attemptRows(reference);
  assert.equal(rows.length, 1);
  assert.match(rows[0].client_ip, /^(::ffff:)?127\.0\.0\.1$|^::1$/);
});

test("a paid invoice settles through the module's route and onPaid marks the order paid", {
  skip,
}, async () => {
  const buyer = new Visitor();
  const reference = await buyer.order();
  const created = await buyer.route("/checkouts", { reference });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const hash = created.body.checkout.payment_hash;
  assert.equal(orderRow(reference).state, "awaiting_payment");

  relay.wallet.settle(hash);
  const deadline = Date.now() + 60_000;
  let check;
  for (;;) {
    check = await buyer.route("/payments/check", { reference, payment_hash: hash });
    if (check.body?.status === "settled" || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.equal(check.body.status, "settled");
  assert.equal(orderRow(reference).state, "paid");
  assert.equal(attemptRows(reference)[0].status, "settled");
});

/** Every request and complaint a page makes while its checkout starts. */
function watch(page) {
  const seen = { prepares: [], wrongPrefix: [], failed: [], complaints: [] };
  page.on("request", (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.endsWith("/checkouts/prepare")) {
      seen.prepares.push(`${request.method()} ${pathname}`);
    }
    if (pathname.startsWith("/openreceive/")) seen.wrongPrefix.push(pathname);
  });
  page.on("requestfailed", (request) => {
    seen.failed.push(`${new URL(request.url()).pathname} ${request.failure()?.errorText ?? ""}`);
  });
  page.on("pageerror", (error) => seen.complaints.push(`uncaught: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      seen.complaints.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  return seen;
}

async function checkoutStarted(page, seen) {
  await page
    .locator("openreceive-checkout")
    .locator('[data-or-method="bitcoin"]')
    .waitFor({ state: "visible", timeout: 30_000 });
  // Room for a second prepare to show itself.
  await page.waitForTimeout(1_000);
  assert.deepEqual(seen.prepares, ["POST /pay/checkouts/prepare"], "one prepare, under /pay");
  assert.deepEqual(seen.wrongPrefix, [], "nothing goes to the default /openreceive prefix");
  assert.deepEqual(seen.failed, [], "no request is abandoned");
  assert.deepEqual(seen.complaints, [], "nothing reaches the console");
}

// The two ways a Nuxt shop opens a checkout: a client-side navigation (a
// fresh client mount, where #132 dropped the prefix) and a direct load
// (server-rendered, then hydrated).
test("in Chromium, the checkout starts once, on /pay, by navigation and by direct load", {
  skip,
}, async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    let seen = watch(page);
    await page.goto(`${base}/`);
    await page.getByRole("button", { name: "Buy" }).click();
    await page.waitForURL(/\/checkout\//);
    await checkoutStarted(page, seen);

    const direct = await context.newPage();
    seen = watch(direct);
    await direct.goto(page.url());
    await checkoutStarted(direct, seen);
  } finally {
    await browser.close();
  }
});

test("server/openreceive.ts stays out of the browser bundle", { skip }, () => {
  const publicDir = path.join(appDir, ".output", "public");
  const files = readdirSync(publicDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = readFileSync(file, "latin1");
    assert.ok(
      !text.includes(MARKER),
      `${path.relative(appDir, file)} carries server/openreceive.ts`,
    );
    assert.ok(!text.includes("NWC_URI"), `${path.relative(appDir, file)} names NWC_URI`);
  }
});

test("without server/openreceive.ts the module says what to write and mounts no route", {
  skip,
}, () => {
  const prepared = nuxt("prepare", path.join(here, "no-config"));
  assert.equal(prepared.status, 0, prepared.output);
  assert.match(prepared.output, /No server\/openreceive\.ts yet/);
  assert.match(prepared.output, /https:\/\/openreceive\.org\/integrations\/nuxt/);
});
