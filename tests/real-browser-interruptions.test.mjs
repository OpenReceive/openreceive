// Interruptions: the payer reloads in the middle of a step, and the network
// misbehaves, in real browsers.
//
// The lifecycle tests keep one page and a perfect network from the first click
// to the receipt. A payer has neither. They reload while the invoice is being
// made, a phone drops a request whose work the shop already did, a proxy
// answers with its own HTML page, and the connection comes and goes. Every
// case here ends on the same promises the product makes on a good day: one
// invoice and one swap provider order per order, the payment reaching the
// screen once it is paid, the shop told once, and nothing on the screen a
// payer should not read.
//
// "In flight" is never a race against a timer: the lab holds the request
// (lab.fault, tests/helpers/real-browser-lab.mjs) and the test reloads while
// it is held. Covered elsewhere and not repeated here: a reload while an open
// invoice waits (trials reloadJourney, tests/e2e/persistence.spec.ts), a reload
// with a swap already open (tests/e2e/swap.spec.ts), one offline-online cycle
// (trials offlineJourney) and a background tab (trials APP_SWITCH).
//
// The bugs these cases found run through `whileOpen` against their entries in
// tests/helpers/known-issues.mjs: reload-mid-create, reload-after-pay,
// swap-screen-misses-paid, no-request-timeout and slow-after-outage. A case
// that met one leaves a screenshot of the payer's screen in
// OPENRECEIVE_LAB_SHOTS (default: the system temp folder) and says where.
// The whole file takes about seven minutes in three engines: the outage and
// the requests that never answer are waits on the clock by definition.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { KNOWN_OPEN, whileOpen } from "./helpers/known-issues.mjs";
import { until } from "./helpers/lifecycle-harness.mjs";
import { wrapperBundle } from "./helpers/real-browser-bundles.mjs";
import {
  checkoutTag,
  closeEngines,
  createLab,
  documentHtml,
  holdCalls,
  launchEngine,
  openTab,
  requestedEngines,
  STANDALONE_SCRIPT,
} from "./helpers/real-browser-lab.mjs";

process.env.LOG_LEVEL ??= "error";
test.after(closeEngines);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRE = process.env.OPENRECEIVE_BROWSER_TESTS === "require";
/** Screenshots of what a payer saw when a known bug showed, outside the repository. */
const SHOTS =
  process.env.OPENRECEIVE_LAB_SHOTS ??
  path.join(tmpdir(), "openreceive-real-browser-interruptions");

const REFERENCE = "order-interrupted";
const PAID = /Payment (complete|received)/;
const SOL_DEPOSIT = /SOL on the Solana network/;
/** A checksum-valid Tron address (tests/e2e/swap.spec.ts). */
const TRON_REFUND_ADDRESS = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
/** The testkit provider numbers its orders; the first one an order opens. */
const FIRST_PROVIDER_ORDER = "testkit-swap-1";

/**
 * Generous because the machine running these is often busy: a step that
 * really hangs is caught by the waits below, which are shorter and say what.
 */
const STEP_MS = 20_000;
/** The checkout polls every 3 s and a wallet scan waits up to 3 s for its gate. */
const PAID_MS = 20_000;

const open = (id) => (KNOWN_OPEN[id] === undefined ? undefined : id);

/**
 * Words a payer must not read when the network fails: a script error's class
 * or text, a proxy's page leaking through, a value that failed to format.
 * Adapted from trials/harness/payer.ts, narrowed to what a network fault can
 * put on the screen.
 */
const BANNED = [
  ["error class", /\b(?:[A-Z][a-z0-9]+)+Error\b/],
  ["fetch", /\bfetch\b/i],
  ["failed to fetch", /failed to fetch|load failed|networkerror/i],
  ["JSON", /\bJSON\b|unexpected token|unexpected end/i],
  ["HTML", /<\s*\/?\s*(?:html|body|head|title|!doctype)/i],
  ["proxy page", /bad gateway|gateway time-?out|nginx|cloudflare|sign in to wi-?fi/i],
  ["stack trace", /\bat\s+\S+\s+\(|\.m?js:\d+/],
  ["exception", /\bexceptions?\b|\btraceback\b/i],
  ["undefined", /\bundefined\b/i],
  ["null", /\bnull\b/i],
  ["NaN", /\bNaN\b/],
  ["[object Object]", /\[object Object\]/],
  ["status code", /\b(?:status|HTTP)\s*(?:code\s*)?[45]\d\d\b/i],
  ["field name", /\b(?:payment_hash|pay_in_asset|amount_msats|swap_data|bolt11)\b/],
];

function bannedWords(text) {
  const flat = text.replace(/\s+/g, " ");
  return BANNED.flatMap(([term, pattern]) => {
    const at = flat.search(pattern);
    return at < 0 ? [] : [`${term}: "…${flat.slice(Math.max(0, at - 40), at + 60)}…"`];
  });
}

// ------------------------------------------------------------------- the pages

/**
 * Runs in every page before its scripts. The `pageshow` events are kept in
 * sessionStorage so they survive the navigations under test; `persisted` on
 * one is a restore from the back/forward cache.
 */
function recordPageLife() {
  const read = (key, fallback) => {
    try {
      return JSON.parse(sessionStorage.getItem(key) ?? "null") ?? fallback;
    } catch {
      return fallback;
    }
  };
  const write = (key, value) => {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {}
  };
  window.labShows = () => read("lab.shows", []);
  addEventListener("pageshow", (event) => {
    write("lab.shows", [...read("lab.shows", []), { persisted: event.persisted }]);
  });
  // Per page load: how many times this page said the order is paid. The
  // element's settled event does not bubble, so capture it.
  window.labSettled = 0;
  document.addEventListener(
    "openreceive-settled",
    () => {
      window.labSettled += 1;
    },
    true,
  );
}

/**
 * The way back the guides document (docs/guides/frontend-checkout.md, "The
 * way back to a refund"): the page keeps the attempt it was shown, and hands
 * it back as `resume-payment-hash` on the next visit. The guide keeps swap
 * attempts; this keeps a Lightning one too, with `resume-payment-rail`, which
 * the same guide offers for an open invoice.
 */
const RESUME_SCRIPT = `
(() => {
  const checkout = document.querySelector("openreceive-checkout");
  const key = "lab.resume." + checkout.getAttribute("reference");
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(key) ?? "null"); } catch {}
  if (saved !== null) {
    checkout.setAttribute("resume-payment-hash", saved.hash);
    if (saved.rail === "lightning") checkout.setAttribute("resume-payment-rail", "lightning");
  }
  checkout.addEventListener("openreceive-state", (event) => {
    const { state } = event.detail;
    if ((state.rail === "swap" || state.rail === "lightning") && state.payment_hash && !state.settled) {
      localStorage.setItem(key, JSON.stringify({ hash: state.payment_hash, rail: state.rail }));
    }
  });
})();`;

const ELEMENT = {
  name: "the element",
  scope: (page) => page.locator("openreceive-checkout"),
  bitcoin: (scope) => scope.locator('[data-or-method="bitcoin"]').first(),
  async html(lab, { resume = false } = {}) {
    const resumeScript = resume ? `<script>${RESUME_SCRIPT}</script>` : "";
    return documentHtml({
      body: `${checkoutTag({ reference: REFERENCE, prefix: lab.prefix, ...(resume ? { resumable: "" } : {}) })}
${resumeScript}
<script type="module" src="${STANDALONE_SCRIPT}"></script>`,
    });
  },
};

const REACT = {
  name: "React's checkout",
  scope: (page) => page.locator("[data-openreceive-root][data-openreceive-checkout]"),
  bitcoin: (scope) => scope.getByRole("button", { name: /Bitcoin/ }).first(),
  async html(lab, { resume = false } = {}) {
    const styles = lab.asset(
      "react-styles.css",
      readFileSync(path.join(repoRoot, "packages/js/react/dist/styles.css"), "utf8"),
      "text/css",
    );
    const bundle = lab.asset("react.js", await wrapperBundle("react"));
    // The same way back as RESUME_SCRIPT, through `onState` and the props.
    const boot = `import "${bundle}";
const key = "lab.resume.${REFERENCE}";
let saved = null;
try { saved = JSON.parse(localStorage.getItem(key) ?? "null"); } catch {}
const resume = ${resume} && saved !== null
  ? { resumePaymentHash: saved.hash, ...(saved.rail === "lightning" ? { resumePaymentRail: "lightning" } : {}) }
  : {};
window.mountCheckout({
  reference: ${JSON.stringify(REFERENCE)},
  prefix: ${JSON.stringify(lab.prefix)},
  defaultTheme: "light",
  ...(${resume} ? { resumable: true } : {}),
  ...resume,
  onState: (state) => {
    if (${resume} && (state.rail === "swap" || state.rail === "lightning") && state.payment_hash && !state.settled) {
      localStorage.setItem(key, JSON.stringify({ hash: state.payment_hash, rail: state.rail }));
    }
  },
  onSettled: () => document.dispatchEvent(new Event("openreceive-settled")),
}, { strict: false });`;
    return documentHtml({
      head: `<link rel="stylesheet" href="${styles}">`,
      body: `<div id="app" style="width: 440px"></div><script type="module">${boot}</script>`,
    });
  },
  available: () => {
    try {
      readFileSync(path.join(repoRoot, "packages/js/react/dist/styles.css"));
      return true;
    } catch {
      return false;
    }
  },
  unavailable: "packages/js/react/dist/styles.css is not built (npm run build:packages)",
};

// ------------------------------------------------------------------- the visit

/**
 * One payer on one shop: a lab with one order, and a page on it. `lab`
 * options reach createLab (latency, gzip). Everything the case needs to act
 * and to look is on the returned object.
 */
async function visit(browser, surface, { resume = false, lab: labOptions = {} } = {}) {
  const lab = await createLab(labOptions);
  lab.stack.addOrder(REFERENCE, 21_000);
  const tab = await openTab(browser, lab, { viewport: { width: 520, height: 1100 } });
  await tab.context.addInitScript(recordPageLife);
  const url = lab.page(await surface.html(lab, { resume }));
  const scope = surface.scope(tab.page);
  const payer = {
    lab,
    tab,
    engine: browser.browserType().name(),
    page: tab.page,
    scope,
    url,
    surface,
    async load() {
      await tab.page.goto(url);
      await surface.bitcoin(scope).waitFor({ state: "visible", timeout: STEP_MS });
    },
    /** Reload; the caller waits for the screen it expects. */
    async reload() {
      await tab.page.reload({ waitUntil: "domcontentloaded" });
    },
    bitcoin: () => surface.bitcoin(scope),
    copyInvoice: () => scope.getByRole("button", { name: /Copy invoice/i }).first(),
    async invoiceOnScreen(timeout = STEP_MS) {
      await payer.copyInvoice().waitFor({ state: "visible", timeout });
    },
    coin: (name) => scope.getByRole("button", { name: new RegExp(`^${name}`) }).first(),
    next: () => scope.getByRole("button", { name: /^Continue/ }).first(),
    network: (coin, name) =>
      scope
        .getByRole("group", { name: `Choose ${coin} network` })
        .getByRole("button", { name, exact: true }),
    async paidOnScreen(timeout = PAID_MS) {
      await scope.getByText(PAID).first().waitFor({ state: "visible", timeout });
    },
    /** True once the receipt shows; false if it has not after `timeout`. */
    paidWithin: (timeout) =>
      scope
        .getByText(PAID)
        .first()
        .waitFor({ state: "visible", timeout })
        .then(() => true)
        .catch(() => false),
    /** The checkout's text as the payer reads it, shadow DOM included. */
    text: () =>
      tab.page.evaluate(
        (selector) => {
          const found = document.querySelector(selector);
          if (found === null) return "";
          const root = found.shadowRoot ?? found;
          return (
            [...root.children]
              .filter(
                (node) =>
                  node instanceof HTMLElement && !["STYLE", "SCRIPT"].includes(node.tagName),
              )
              // biome-ignore lint/performance/useDomNodeTextContent: what the payer reads is the rendered text.
              .map((node) => node.innerText)
              .join("\n")
          );
        },
        surface === ELEMENT ? "openreceive-checkout" : "[data-openreceive-root]",
      ),
    alerts: () => scope.getByRole("alert").filter({ visible: true }),
    /** The first error panel's words, as the payer reads them. */
    async alertText() {
      // biome-ignore lint/performance/useDomNodeTextContent: what the payer reads is the rendered text.
      const text = await payer.alerts().first().innerText();
      return text.replace(/\s+/g, " ").trim();
    },
    settledOnPage: () => tab.page.evaluate(() => window.labSettled ?? 0),
    shows: () => tab.page.evaluate(() => window.labShows()),
    uncaught: () => tab.seen.complaints.filter((line) => line.startsWith("uncaught:")),
    /** Payment hashes the shop handed out on POST /checkouts. */
    mintedHashes: () =>
      lab
        .servedTo("/checkouts")
        .filter((entry) => entry.status === 200 || entry.status === 201)
        .map((entry) => entry.body.checkout.payment_hash),
    /** Every payment hash any answer carried for a swap start. */
    swapHashes: () =>
      lab
        .servedTo("/swaps")
        .filter((entry) => entry.status === 200 || entry.status === 201)
        .map((entry) => entry.body.swap.checkout.payment_hash),
    async screenshot(what) {
      mkdirSync(SHOTS, { recursive: true });
      const name = `${payer.engine}-${surface === ELEMENT ? "element" : "react"}-${what}`;
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const file = path.join(SHOTS, `${slug}.png`);
      await tab.page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
      return file;
    },
    async close() {
      await tab.close().catch(() => undefined);
      await lab.close();
    },
  };
  return payer;
}

/** The order's one invoice, paid in the wallet. */
function settleOnly(payer) {
  const invoices = payer.lab.stack.wallet.listInvoices();
  assert.equal(invoices.length, 1, "the wallet holds one invoice for the order");
  payer.lab.stack.wallet.settleInvoice({ payment_hash: invoices[0].payment_hash });
  return invoices[0].payment_hash;
}

/** The end every case shares: paid on screen, once, and the shop told once. */
async function assertPaidOnce(payer, label) {
  await assert.doesNotReject(payer.paidOnScreen(), `${label}: the receipt must show`);
  assert.equal(await payer.settledOnPage(), 1, `${label}: the page says paid once`);
  assert.equal(payer.lab.stack.settlements.length, 1, `${label}: the shop is told once`);
  assert.equal(await payer.alerts().count(), 0, `${label}: no error left on the receipt`);
  assert.deepEqual(await payer.uncaught(), [], `${label}: no script error`);
}

async function assertPayerSafe(payer, label) {
  const text = await payer.text();
  assert.deepEqual(bannedWords(text), [], `${label}: the payer read ${JSON.stringify(text)}`);
}

/** Pick a one-network coin and press Continue: the swap's whole start. */
async function startSolSwap(payer) {
  await payer.coin("SOL").click();
  await payer.next().click();
}

async function solDepositOnScreen(payer, timeout = STEP_MS) {
  await payer.scope.getByText(SOL_DEPOSIT).first().waitFor({ state: "visible", timeout });
}

/** The deposit address on screen, read from the copy field the panel shows. */
function depositAddressOnScreen(payer) {
  return payer.scope.getByRole("textbox", { name: "Address", exact: true }).first().inputValue();
}

// ----------------------------------------------------------------- the reloads

/**
 * 1. The payer picked Bitcoin, the shop minted, and the page reloaded before
 * the answer arrived. The minted invoice is the order's: the payer who picks
 * Bitcoin again must get THAT one, not a second.
 */
async function reloadWhileMinting(surface, browser) {
  const payer = await visit(browser, surface, { resume: true });
  try {
    await payer.load();
    const mint = payer.lab.fault({ method: "POST", route: "/checkouts", hold: "after", times: 1 });
    await payer.bitcoin().click();
    await mint.reached();
    assert.equal(
      payer.lab.stack.wallet.listInvoices().length,
      1,
      "the shop minted before the reload",
    );
    await payer.reload();

    // Nothing reached the page, so nothing was remembered: the method grid.
    await payer.bitcoin().waitFor({ state: "visible", timeout: STEP_MS });
    assert.equal(await payer.alerts().count(), 0, "a reload is not an error");
    await payer.bitcoin().click();
    await payer.invoiceOnScreen();
    const minted = payer.mintedHashes();
    assert.equal(minted.length, 2, "the shop answered both picks");
    assert.equal(new Set(minted).size, 1, "both picks were handed the same invoice");
    assert.equal(payer.lab.stack.wallet.listInvoices().length, 1, "and the wallet holds one");

    settleOnly(payer);
    await assertPaidOnce(payer, "after the reload");
  } finally {
    await payer.close();
  }
}

/**
 * 2. Continue was pressed, the shop opened the order at the swap provider, and
 * the page reloaded before the deposit address arrived. Two deposit addresses
 * for one order is the worst outcome here: the payer who starts again must be
 * shown the deposit the provider already holds.
 */
async function reloadWhileStartingSwap(surface, browser) {
  const payer = await visit(browser, surface, { resume: true });
  try {
    await payer.load();
    const start = payer.lab.fault({ method: "POST", route: "/swaps", hold: "after", times: 1 });
    await startSolSwap(payer);
    await start.reached();
    const provider = payer.lab.stack.swapProvider;
    assert.equal(provider.createCalls, 1, "the provider holds the order before the reload");
    await payer.reload();

    await payer.coin("SOL").waitFor({ state: "visible", timeout: STEP_MS });
    assert.equal(await payer.alerts().count(), 0, "a reload is not an error");
    await startSolSwap(payer);
    await solDepositOnScreen(payer);
    assert.equal(provider.createCalls, 1, "starting again opened no second provider order");
    const hashes = payer.swapHashes();
    assert.equal(hashes.length, 2, "the shop answered both starts");
    assert.equal(new Set(hashes).size, 1, "both starts were handed the same swap");
    assert.equal(
      await depositAddressOnScreen(payer),
      payer.lab.servedTo("/swaps")[0].body.swap.deposit_address,
      "the payer is shown the deposit address the provider holds",
    );

    // The provider pays the swap's invoice: the order is paid, once.
    payer.lab.stack.wallet.settleInvoice({ payment_hash: hashes[0] });
    await assertPaidOnce(payer, "after the reload");
  } finally {
    await payer.close();
  }
}

/**
 * 1 and 2, a moment earlier: the shop is still waiting on its wallet (or the
 * swap provider) when the page reloads, so the payer's second pick reaches the
 * shop while the first is unfinished. Behind a wallet relay that answers in a
 * second or two this is an ordinary impatient reload. The payer must not be
 * told anything went wrong, and the order must still end with one invoice and,
 * for a swap, one provider order.
 */
async function reloadWhileShopWaits(surface, browser, t, { swap }) {
  const payer = await visit(browser, surface, { resume: true });
  const stack = payer.lab.stack;
  const waiting = swap
    ? holdCalls(stack.swapProvider, "createSwap")
    : holdCalls(stack.wallet, "makeInvoice");
  const route = swap ? "/swaps" : "/checkouts";
  try {
    await payer.load();
    const choose = swap ? () => startSolSwap(payer) : () => payer.bitcoin().click();
    await choose();
    await waiting.reached(1);
    await payer.reload();
    await payer.bitcoin().waitFor({ state: "visible", timeout: STEP_MS });
    await choose();
    await until(() => payer.lab.servedTo(route).length === 2, {
      timeoutMs: STEP_MS,
      label: `the second ${route} at the shop`,
    });
    // A second wallet (or provider) call, if the shop makes one, starts as
    // soon as the request is in; give it that moment, and no more.
    const second = await waiting
      .reached(2, { timeoutMs: 2_000 })
      .then(() => true)
      .catch(() => false);
    waiting.restore();
    // The payer's screen settles on one of two things: the payment
    // instructions, or an error.
    const instructions = swap ? payer.scope.getByText(SOL_DEPOSIT).first() : payer.copyInvoice();
    await instructions.or(payer.alerts().first()).waitFor({ state: "visible", timeout: STEP_MS });
    const seen = {
      error: (await payer.alerts().count()) > 0 ? await payer.alertText() : undefined,
      walletInvoices: stack.wallet.listInvoices().length,
      providerOrders: stack.swapProvider.createCalls,
      answers: payer.lab.servedTo(route).map((entry) => entry.status),
    };
    t.diagnostic(`second ${swap ? "provider" : "wallet"} call: ${second}; ${JSON.stringify(seen)}`);
    if (seen.error !== undefined) {
      t.diagnostic(
        `screenshot: ${await payer.screenshot(`reload-mid-create-${swap ? "swap" : "mint"}`)}`,
      );
    }
    await whileOpen(t, open("reload-mid-create"), async () => {
      assert.equal(seen.error, undefined, "the payer is shown no error for a reload");
      if (swap) assert.equal(seen.providerOrders, 1, "the provider holds one order");
      else assert.equal(seen.walletInvoices, 1, "the wallet holds one invoice");
    });
    await assertPayerSafe(payer, "after the second pick");

    // Whatever the screen said, the payer's next try lands on the order's one
    // committed attempt, and paying it reaches the screen once.
    if (seen.error !== undefined) {
      await payer.scope.getByRole("button", { name: "Try again" }).first().click();
      await instructions.waitFor({ state: "visible", timeout: STEP_MS });
    }
    const committed = swap ? payer.swapHashes() : payer.mintedHashes();
    assert.equal(new Set(committed).size, 1, "every instruction shown is the same attempt");
    stack.wallet.settleInvoice({ payment_hash: committed[0] });
    await assertPaidOnce(payer, "after the second pick");
  } finally {
    waiting.restore();
    await payer.close();
  }
}

/**
 * 3. Reloads before anything was started: on the network step, and with the
 * price quote still on its way. Nothing may have been opened for the payer,
 * and the checkout must work as new afterwards.
 */
async function reloadBeforeStarting(surface, browser) {
  const payer = await visit(browser, surface, { resume: true });
  try {
    await payer.load();
    const provider = payer.lab.stack.swapProvider;
    // On the network step: USDT asks which network before it can price.
    await payer.coin("USDT").click();
    await payer.network("USDT", "Tron").waitFor({ state: "visible", timeout: STEP_MS });
    await payer.reload();
    await payer.coin("SOL").waitFor({ state: "visible", timeout: STEP_MS });

    // With the quote on its way: the tile priced SOL and the answer is held.
    const quote = payer.lab.fault({
      method: "POST",
      route: "/swaps/quote",
      hold: "before",
      times: 1,
    });
    await payer.coin("SOL").click();
    await quote.reached();
    await payer.reload();
    await payer.coin("SOL").waitFor({ state: "visible", timeout: STEP_MS });
    assert.equal(await payer.alerts().count(), 0, "a reload is not an error");
    assert.equal(payer.lab.servedTo("/swaps").length, 0, "no swap was started");
    assert.equal(provider.createCalls, 0, "no order was opened at the provider");

    await startSolSwap(payer);
    await solDepositOnScreen(payer);
    assert.equal(provider.createCalls, 1, "Continue still opens exactly one");
    assert.deepEqual(await payer.uncaught(), []);
  } finally {
    await payer.close();
  }
}

/**
 * 4. The payer confirmed a refund address, the shop passed it to the swap
 * provider, and the page reloaded before the answer. The way back reopens the
 * swap: it must show the refund the provider already has, and must not ask for
 * (or send) a second one.
 */
async function reloadWhileRefunding(surface, browser) {
  const payer = await visit(browser, surface, { resume: true });
  const provider = payer.lab.stack.swapProvider;
  try {
    await payer.load();
    await payer.coin("USDT").click();
    await payer.network("USDT", "Tron").click();
    await payer.next().click();
    await payer.scope
      .getByText(/Pay [\d.]+ USDT to this address/)
      .first()
      .waitFor({ state: "visible", timeout: STEP_MS });
    // The deposit went wrong at the provider: it must be refunded.
    provider.forceRefundRequired({ providerOrderId: FIRST_PROVIDER_ORDER });
    await payer.scope
      .getByText("Refund needed")
      .first()
      .waitFor({ state: "visible", timeout: STEP_MS });
    await payer.scope.getByPlaceholder("Tron refund address").fill(TRON_REFUND_ADDRESS);
    await payer.scope.getByRole("button", { name: "Review refund address" }).click();
    await payer.scope
      .getByText(`Confirm refund to ${TRON_REFUND_ADDRESS}.`)
      .waitFor({ state: "visible", timeout: STEP_MS });

    const refund = payer.lab.fault({
      method: "POST",
      route: "/swaps/refunds",
      hold: "after",
      times: 1,
    });
    await payer.scope.getByRole("button", { name: "Confirm refund" }).click();
    await refund.reached();
    assert.equal(provider.refundCalls.length, 1, "the provider has the refund before the reload");
    await payer.reload();

    await assert.doesNotReject(
      payer.scope
        .getByText("Refund pending")
        .first()
        .waitFor({ state: "visible", timeout: STEP_MS }),
      "the way back opens on the refund the provider has",
    );
    assert.equal(
      await payer.scope
        .getByRole("button", { name: /Review refund address|Confirm refund/ })
        .count(),
      0,
      "and asks for no second refund",
    );
    assert.equal(provider.refundCalls.length, 1, "the refund was sent to the provider once");
    assert.deepEqual(
      provider.refundCalls.map((call) => call.refundAddress),
      [TRON_REFUND_ADDRESS],
    );
    assert.equal(payer.lab.servedTo("/swaps/refunds").length, 1, "and confirmed once");
    assert.equal(provider.createCalls, 1, "the reload opened no new swap");
    assert.equal(payer.lab.stack.settlements.length, 0, "a refunded swap is not a paid order");
    await assertPayerSafe(payer, "the refund screen after the reload");
    assert.deepEqual(await payer.uncaught(), []);
  } finally {
    await payer.close();
  }
}

/**
 * 5. The payer pays in their wallet and the page reloads before its next poll
 * lands, as a phone does when it reloads a tab it sent to the background while
 * the wallet app was open. The order is paid: the payer must land on the
 * receipt without picking a way to pay again.
 *
 * The case is made exact: a wallet scan runs just before the payment (another
 * open tab's poll, or this page's own last one), so the shop's next scan waits
 * for the reconcile gate (3 s for a young invoice, up to 12 s for one open
 * five minutes) and the reloaded page's first request finds the order unpaid.
 */
async function reloadAsItIsPaid(surface, browser, t, { resume }) {
  const payer = await visit(browser, surface, { resume });
  const stack = payer.lab.stack;
  try {
    await payer.load();
    await payer.bitcoin().click();
    await payer.invoiceOnScreen();
    const [hash] = payer.mintedHashes();

    const prepare = payer.lab.fault({
      method: "POST",
      route: "/checkouts/prepare",
      hold: "before",
      times: 1,
    });
    await payer.reload();
    await prepare.reached();
    // A scan of its own: the answer carries the wallet's `details` only when
    // this request's pass ran (the gate was free).
    await until(
      async () =>
        "details" in
        (await stack.postJson("/payments/check", { reference: REFERENCE, payment_hash: hash })),
      { timeoutMs: 15_000, stepMs: 250, label: "a wallet scan that claims the gate" },
    );
    stack.wallet.settleInvoice({ payment_hash: hash });
    prepare.release();

    let paid = false;
    await whileOpen(t, resume ? undefined : open("reload-after-pay"), async () => {
      paid = await payer.paidWithin(PAID_MS);
      if (!paid) {
        t.diagnostic(`the payer sees: ${(await payer.text()).replace(/\s+/g, " ").slice(0, 160)}`);
        t.diagnostic(`screenshot: ${await payer.screenshot("reload-after-pay")}`);
      }
      assert.equal(paid, true, "the paid order shows its receipt without another click");
    });
    if (!paid) {
      // Where the payer is left: they pick Bitcoin again. By now the shop has
      // seen the payment, so that answers "already paid", which the payer
      // reads as an error, and only a second reload shows the receipt.
      await payer.bitcoin().click();
      const receipt = payer.scope.getByText(PAID).first();
      await receipt.or(payer.alerts().first()).waitFor({ state: "visible", timeout: PAID_MS });
      if (!(await receipt.isVisible())) {
        const said = await payer.alertText();
        t.diagnostic(`picking Bitcoin again shows: ${said}`);
        await assertPayerSafe(payer, "picking Bitcoin again");
        await payer.reload();
      }
    }
    assert.equal(stack.wallet.listInvoices().length, 1, "nothing new was minted");
    await assertPaidOnce(payer, "after the reload");
  } finally {
    await payer.close();
  }
}

/**
 * Start a status check whose wallet scan claims the reconcile gate and then
 * waits on the wallet (`scan`, a hold on `listTransactions`). A check made
 * while the gate is still busy from an earlier scan answers at once without
 * scanning; those are retried until one scans. Returns `{ check }`, the held one.
 */
async function slowScan(stack, scan, hash) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const check = stack.postJson("/payments/check", { reference: REFERENCE, payment_hash: hash });
    const scanning = await Promise.race([
      check.then(() => false),
      scan.reached(1, { timeoutMs: 15_000 }).then(
        () => true,
        () => false,
      ),
    ]);
    // Wrapped: an async function returning the bare promise would wait for it.
    if (scanning) return { check };
    assert.ok(Date.now() < deadline, "no status check claimed the reconcile gate in 15 s");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * 5b. The same reload, and the payer, shown the coins and no sign of their
 * payment, picks SOL instead. An order that is paid must not be handed a
 * deposit address: a payer who sends to it has paid twice.
 *
 * The shop's last wallet scan started just before the payment and the wallet
 * is slow to answer it, so the scan holds the reconcile gate (its lease runs
 * up to 10 s) while the payer clicks. With a gate that only reopens every 12 s
 * once an invoice has been open five minutes, the same happens without a slow
 * wallet.
 */
async function paidThenCoin(surface, browser, t) {
  const payer = await visit(browser, surface, { resume: false });
  const stack = payer.lab.stack;
  let scan;
  try {
    await payer.load();
    await payer.bitcoin().click();
    await payer.invoiceOnScreen();
    const [hash] = payer.mintedHashes();
    const prepare = payer.lab.fault({
      method: "POST",
      route: "/checkouts/prepare",
      hold: "before",
      times: 1,
    });
    await payer.reload();
    await prepare.reached();
    scan = holdCalls(stack.wallet, "listTransactions");
    const { check: scanning } = await slowScan(stack, scan, hash);
    stack.wallet.settleInvoice({ payment_hash: hash });
    prepare.release();

    await payer.coin("SOL").waitFor({ state: "visible", timeout: STEP_MS });
    await startSolSwap(payer);
    const deposit = payer.scope.getByText(SOL_DEPOSIT).first();
    const receipt = payer.scope.getByText(PAID).first();
    await deposit
      .or(receipt)
      .or(payer.alerts().first())
      .waitFor({ state: "visible", timeout: STEP_MS });
    const shown = (await deposit.isVisible())
      ? "a deposit address"
      : (await receipt.isVisible())
        ? "the receipt"
        : `an error: ${await payer.alertText()}`;
    t.diagnostic(
      `picking SOL on a paid order shows ${shown}; provider orders: ${stack.swapProvider.createCalls}`,
    );
    if (shown === "a deposit address") {
      t.diagnostic(`screenshot: ${await payer.screenshot("paid-then-coin")}`);
    }
    scan.restore();
    await scanning;
    // Once the shop has seen the payment, the deposit screen still asks for
    // SOL: case 5c. Marked `sometimes` because the scan's lease (10 s) bounds
    // the window; on a machine slow enough to take longer over the clicks,
    // the shop sees the payment first and the check passes.
    await whileOpen(
      t,
      open("reload-after-pay"),
      async () => {
        assert.equal(stack.swapProvider.createCalls, 0, "a paid order opens no swap");
        assert.notEqual(shown, "a deposit address", "a paid order shows no deposit address");
      },
      { sometimes: true },
    );
    await assertPayerSafe(payer, "picking SOL on a paid order");

    // Wherever the payer was left, the next visit shows the receipt, and the
    // shop was told once.
    await payer.reload();
    await assertPaidOnce(payer, "the next visit");
  } finally {
    scan?.restore();
    await payer.close();
  }
}

/**
 * 5c. Why 5b leaves the payer stuck: a deposit screen that is open when the
 * order is paid some other way. The payer looked at the Lightning invoice,
 * switched to SOL, and the invoice was paid (from the wallet they had already
 * scanned it with, or in another tab). The shop sees the payment on the
 * screen's next poll; the screen must stop asking for SOL. And the way back
 * must not reopen the deposit of an order that is paid.
 */
async function paidElsewhereWhileSwapOpen(surface, browser, t) {
  const payer = await visit(browser, surface, { resume: true });
  const stack = payer.lab.stack;
  try {
    await payer.load();
    await payer.bitcoin().click();
    await payer.invoiceOnScreen();
    const [hash] = payer.mintedHashes();
    await payer.scope.getByRole("button", { name: "Switch payment method" }).first().click();
    await startSolSwap(payer);
    await solDepositOnScreen(payer);

    stack.wallet.settleInvoice({ payment_hash: hash });
    await until(() => stack.settlements.length === 1, {
      timeoutMs: PAID_MS,
      label: "the shop seeing the payment",
    });
    await whileOpen(t, open("swap-screen-misses-paid"), async () => {
      const noticed = await payer.paidWithin(PAID_MS);
      if (!noticed) t.diagnostic(`screenshot: ${await payer.screenshot("paid-while-swap-open")}`);
      assert.equal(noticed, true, "the deposit screen gives way to the receipt");
    });

    // The way back: the page kept the swap's hash and hands it back.
    await payer.reload();
    const deposit = payer.scope.getByText(SOL_DEPOSIT).first();
    const receipt = payer.scope.getByText(PAID).first();
    await deposit.or(receipt).waitFor({ state: "visible", timeout: STEP_MS });
    const reopened = await deposit.isVisible();
    t.diagnostic(
      `after a reload the way back shows ${reopened ? "the SOL deposit" : "the receipt"}`,
    );
    assert.equal(reopened, false, "the way back does not reopen a deposit for a paid order");
    assert.equal(stack.settlements.length, 1, "the shop is told once");
    assert.deepEqual(await payer.uncaught(), []);
  } finally {
    await payer.close();
  }
}

/**
 * 6. The payer leaves the page with the invoice open and comes back with the
 * Back button; then they pay. A browser may hand back the very page from its
 * back/forward cache (timers frozen and thawed, a request that was in flight
 * cancelled) or load it again. Either way the payment must reach the screen.
 * `inFlight` leaves while a status poll is still on its way.
 */
async function backForward(surface, browser, t, { inFlight, report }) {
  const payer = await visit(browser, surface, { resume: true });
  try {
    await payer.load();
    await payer.bitcoin().click();
    await payer.invoiceOnScreen();
    const elsewhere = payer.lab.page(documentHtml({ body: "<p>Another page of the shop</p>" }));
    if (inFlight) {
      const poll = payer.lab.fault({
        method: "POST",
        route: "/payments/check",
        hold: "before",
        times: 1,
      });
      await poll.reached();
      await payer.page.goto(elsewhere);
      poll.release();
    } else {
      // Between polls: right after one answered.
      await payer.page.waitForResponse((response) => response.url().endsWith("/payments/check"), {
        timeout: STEP_MS,
      });
      await payer.page.goto(elsewhere);
    }
    // A restore from the cache fires no load event, so wait for the commit only.
    await payer.page.goBack({ waitUntil: "commit" });
    await payer.copyInvoice().waitFor({ state: "visible", timeout: STEP_MS });
    const restored = (await payer.shows()).at(-1)?.persisted === true;
    report(restored);
    t.diagnostic(`back/forward cache restore: ${restored}`);

    settleOnly(payer);
    await assertPaidOnce(payer, restored ? "after a back/forward cache restore" : "after Back");
    assert.equal(payer.lab.stack.wallet.listInvoices().length, 1, "nothing new was minted");
  } finally {
    await payer.close();
  }
}

// ------------------------------------------------------------ the bad network

/** What nginx sends when the app behind it is down or too slow. */
const PROXY_502 =
  "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx</center></body></html>";
const PROXY_504 =
  "<!DOCTYPE html><html><head><title>504 Gateway Time-out</title></head><body><center><h1>504 Gateway Time-out</h1></center><hr><center>nginx</center></body></html>";
/** What a hotel or airport network answers, with 200, until the payer signs in. */
const CAPTIVE_PORTAL =
  "<!DOCTYPE html><html><head><title>Sign in to Wi-Fi</title></head><body><h1>Welcome to Airport Wi-Fi</h1><form><button>Connect</button></form></body></html>";

/**
 * 7. The shop did the work and the answer never arrived: the connection was
 * cut on the way back (`drop`), or a gateway gave up waiting and sent its own
 * 504 page (`504`). The payer's next try must land on the attempt the shop
 * already made, never a second invoice or a second provider order, and what
 * they read in between must be words for a payer.
 */
async function lostAnswer(surface, browser, t, { swap, how }) {
  const payer = await visit(browser, surface, { resume: true });
  const stack = payer.lab.stack;
  try {
    await payer.load();
    const route = swap ? "/swaps" : "/checkouts";
    // A browser that loses the answer on a kept-alive connection may send the
    // same POST again by itself (Chromium and Firefox do, up to twice), since it
    // cannot tell a dead connection from a lost answer. Losing three answers
    // makes sure the page hears of it.
    const lost = payer.lab.fault({
      method: "POST",
      route,
      ...(how === "drop"
        ? { drop: "after", times: 3 }
        : { respond: { status: 504, body: PROXY_504 }, handled: true, times: 1 }),
    });
    if (swap) await startSolSwap(payer);
    else await payer.bitcoin().click();
    await lost.reached();
    const instructions = swap ? payer.scope.getByText(SOL_DEPOSIT).first() : payer.copyInvoice();
    const tryAgain = payer.scope.getByRole("button", { name: "Try again" }).first();
    let tries = 0;
    for (;;) {
      await instructions.or(tryAgain).waitFor({ state: "visible", timeout: STEP_MS });
      if (!(await tryAgain.isVisible())) break;
      tries += 1;
      assert.ok(tries <= 3, "three lost answers cost the payer three tries at most");
      const said = await payer.alertText();
      t.diagnostic(`try ${tries}: the payer reads: ${said}`);
      await assertPayerSafe(payer, `lost answer ${tries}`);
      await tryAgain.click();
    }
    const arrived = payer.lab.arrivedAt(route).length;
    const asked = (await payer.tab.fetches(route)).filter((call) => call.method === "POST").length;
    t.diagnostic(
      `the payer pressed Try again ${tries} time(s); the page sent ${asked} POST ${route}, ` +
        `${arrived} reached the shop (${arrived - asked} resent by the browser itself)`,
    );
    const hashes = swap ? payer.swapHashes() : payer.mintedHashes();
    assert.ok(hashes.length >= 2, "the lost answer and the retry both reached the shop");
    assert.equal(
      new Set(hashes).size,
      1,
      "every retry was handed the attempt the shop already made",
    );
    assert.equal(stack.wallet.listInvoices().length, 1, "the wallet holds one invoice");
    if (swap) assert.equal(stack.swapProvider.createCalls, 1, "the provider holds one order");
    stack.wallet.settleInvoice({ payment_hash: hashes[0] });
    await assertPaidOnce(payer, "after the lost answer");
  } finally {
    await payer.close();
  }
}

/**
 * 8. Every answer from the shop arrives 2 to 4 s late, and the payer does not
 * wait: they double-click the tile (and Continue), then click again while the
 * spinner turns. One invoice; one swap.
 */
async function impatientOnSlowNetwork(surface, browser, t, { swap }) {
  const payer = await visit(browser, surface, { resume: true });
  const stack = payer.lab.stack;
  try {
    payer.lab.fault({ route: /.*/, answerDelayMs: (index) => 2_000 + (index % 3) * 1_000 });
    await payer.load();
    const spinner = payer.scope.locator('[part="spinner"]').filter({ visible: true }).first();
    if (swap) {
      await payer.coin("SOL").dblclick();
      await payer.next().dblclick();
      await spinner.waitFor({ state: "visible", timeout: STEP_MS }).catch(() => undefined);
      await payer
        .next()
        .click({ timeout: 2_000 })
        .catch(() => undefined);
      await solDepositOnScreen(payer, 40_000);
      assert.equal(stack.swapProvider.createCalls, 1, "the provider holds one order");
    } else {
      await payer.bitcoin().dblclick();
      await spinner.waitFor({ state: "visible", timeout: STEP_MS }).catch(() => undefined);
      await payer
        .bitcoin()
        .click({ timeout: 2_000 })
        .catch(() => undefined);
      await payer.invoiceOnScreen(40_000);
    }
    const route = swap ? "/swaps" : "/checkouts";
    const asked = (await payer.tab.fetches(route)).filter((call) => call.method === "POST");
    t.diagnostic(`the page sent ${asked.length} POST ${route}`);
    const hashes = swap ? payer.swapHashes() : payer.mintedHashes();
    assert.equal(new Set(hashes).size, 1, "every answer is the same attempt");
    assert.equal(stack.wallet.listInvoices().length, 1, "the wallet holds one invoice");
    assert.equal(await payer.alerts().count(), 0, "a slow network is not an error");
    stack.wallet.settleInvoice({ payment_hash: hashes[0] });
    await assert.doesNotReject(payer.paidOnScreen(40_000), "paid reaches the screen");
    assert.equal(stack.settlements.length, 1, "the shop is told once");
  } finally {
    await payer.close();
  }
}

/** How long a payer can be left with a request that never answers. */
const HANG_MS = 20_000;

/**
 * 9. A request that never answers: the connection stays open and nothing
 * comes back (a mobile network that lost the route, a proxy holding the
 * socket). The checkout sets no time limit of its own (no AbortSignal timeout
 * in @openreceive/browser), so the browser's is the only one, and none of the
 * three gave up within HANG_MS here. Within HANG_MS the payer must be offered
 * a way on; once the request does answer, the checkout carries on.
 */
async function neverAnswers(surface, browser, t, { route }) {
  const payer = await visit(browser, surface, { resume: true });
  const stack = payer.lab.stack;
  const tryAgain = payer.scope.getByRole("button", { name: "Try again" }).first();
  let hang;
  try {
    let wayOn = tryAgain;
    let after;
    if (route === "/checkouts/prepare") {
      hang = payer.lab.fault({ method: "POST", route, hold: "before", times: 1 });
      await payer.page.goto(payer.url);
      await hang.reached();
      after = payer.bitcoin();
    } else if (route === "/checkouts") {
      await payer.load();
      hang = payer.lab.fault({ method: "POST", route, hold: "before", times: 1 });
      await payer.bitcoin().click();
      await hang.reached();
      after = payer.copyInvoice();
    } else if (route === "/swaps") {
      await payer.load();
      hang = payer.lab.fault({ method: "POST", route, hold: "before", times: 1 });
      await startSolSwap(payer);
      await hang.reached();
      after = payer.scope.getByText(SOL_DEPOSIT).first();
    } else {
      await payer.load();
      await payer.bitcoin().click();
      await payer.invoiceOnScreen();
      hang = payer.lab.fault({ method: "POST", route, hold: "before", times: 1 });
      await hang.reached();
      settleOnly(payer);
      wayOn = payer.scope.getByText(PAID).first();
      after = wayOn;
    }
    const started = Date.now();
    await whileOpen(t, open("no-request-timeout"), async () => {
      const offered = await wayOn
        .waitFor({ state: "visible", timeout: HANG_MS })
        .then(() => true)
        .catch(() => false);
      if (!offered) {
        const busy = await payer.scope
          .locator('[part="spinner"]')
          .filter({ visible: true })
          .evaluateAll((spinners) =>
            spinners.map((spinner) =>
              // biome-ignore lint/performance/useDomNodeTextContent: what the payer reads is the rendered text.
              spinner.parentElement.innerText.replace(/\s+/g, " ").trim(),
            ),
          );
        t.diagnostic(
          `after ${Math.round((Date.now() - started) / 1000)} s the payer still sees: ` +
            (busy.filter((line) => line !== "").join(" | ") ||
              (await payer.text()).replace(/\s+/g, " ").trim().slice(0, 140)),
        );
        t.diagnostic(
          `screenshot: ${await payer.screenshot(`never-answers${route.replaceAll("/", "-")}`)}`,
        );
      }
      assert.equal(
        offered,
        true,
        route === "/payments/check"
          ? `a status poll that never answers must not keep a paid order off the screen past ${HANG_MS / 1000} s`
          : `a ${route} that never answers must give the payer a way on within ${HANG_MS / 1000} s`,
      );
    });
    // The network comes back: the held request reaches the shop and answers.
    hang.remove();
    if (await tryAgain.isVisible()) await tryAgain.click();
    await assert.doesNotReject(
      after.waitFor({ state: "visible", timeout: PAID_MS }),
      "once it answers, the checkout carries on",
    );
    assert.ok(stack.wallet.listInvoices().length <= 1, "never a second invoice");
    assert.ok(stack.swapProvider.createCalls <= 1, "never a second provider order");
    assert.deepEqual(await payer.uncaught(), []);
  } finally {
    hang?.remove();
    await payer.close();
  }
}

/**
 * 10. Proxies and portals answer the status poll instead of the shop: nginx's
 * 502 and 504 pages, and a captive portal's login page with a 200. The
 * checkout must not crash or show any of it, and once the shop answers again
 * the payment must reach the screen. `swap` does the same to /swaps/status.
 */
async function strangersAnswerThePoll(surface, browser, t, { swap }) {
  const payer = await visit(browser, surface, { resume: true });
  const stack = payer.lab.stack;
  try {
    await payer.load();
    let hash;
    if (swap) {
      await startSolSwap(payer);
      await solDepositOnScreen(payer);
      [hash] = payer.swapHashes();
    } else {
      await payer.bitcoin().click();
      await payer.invoiceOnScreen();
      [hash] = payer.mintedHashes();
    }
    const route = swap ? "/swaps/status" : "/payments/check";
    const strangers = [
      payer.lab.fault({ route, times: 1, respond: { status: 502, body: PROXY_502 } }),
      payer.lab.fault({ route, times: 1, respond: { status: 504, body: PROXY_504 } }),
      payer.lab.fault({ route, times: 1, respond: { status: 200, body: CAPTIVE_PORTAL } }),
    ];
    for (const [index, stranger] of strangers.entries()) {
      await stranger.reached(1, { timeoutMs: 40_000 });
      await assertPayerSafe(payer, `after stranger ${index + 1}`);
      assert.equal(await payer.alerts().count(), 0, `stranger ${index + 1}: no error panel`);
    }
    // The shop answers again. The payment was made meanwhile.
    stack.wallet.settleInvoice({ payment_hash: hash });
    const back = Date.now();
    await assert.doesNotReject(
      payer.paidOnScreen(40_000),
      "paid reaches the screen once the shop answers",
    );
    t.diagnostic(`paid on screen ${Date.now() - back} ms after the shop answered again`);
    assert.equal(await payer.settledOnPage(), 1);
    assert.equal(stack.settlements.length, 1);
    assert.equal(await payer.alerts().count(), 0, "no error left on the receipt");
    assert.deepEqual(await payer.uncaught(), [], "no script error");
  } finally {
    await payer.close();
  }
}

/**
 * 11. The connection comes and goes every 2 s for 20 s while the payer waits
 * on the invoice, and they pay in the middle of it. Once it holds, the paid
 * screen arrives, once, with no error panel left behind.
 */
async function flapping(surface, browser, t) {
  const payer = await visit(browser, surface, { resume: true });
  try {
    await payer.load();
    await payer.bitcoin().click();
    await payer.invoiceOnScreen();
    let settledAt;
    let paidAt;
    const paidSeen = payer.paidWithin(120_000).then((paid) => {
      if (paid) paidAt = Date.now();
    });
    for (let flip = 0; flip < 10; flip += 1) {
      const offline = flip % 2 === 0;
      await payer.tab.context.setOffline(offline);
      // Paid in the middle, while the connection is down.
      if (flip === 4) {
        settleOnly(payer);
        settledAt = Date.now();
      }
      // The flapping is the case: the network changes on the clock, not on the page.
      await payer.page.waitForTimeout(2_000);
      if (offline && paidAt === undefined) {
        await assertPayerSafe(payer, `offline ${flip / 2 + 1}`);
        assert.equal(await payer.alerts().count(), 0, `offline ${flip / 2 + 1}: no error panel`);
      }
    }
    await payer.tab.context.setOffline(false);
    const heldAt = Date.now();
    await paidSeen;
    assert.ok(paidAt !== undefined, "paid reaches the screen once the connection holds");
    t.diagnostic(
      `paid on screen ${((paidAt - settledAt) / 1000).toFixed(1)} s after the payment, ` +
        (paidAt <= heldAt
          ? "while the connection still flapped"
          : `${((paidAt - heldAt) / 1000).toFixed(1)} s after the connection held`),
    );
    await assertPaidOnce(payer, "after the flapping");
  } finally {
    await payer.close();
  }
}

/**
 * 11b. One longer outage: 45 s without a connection, paid in the middle of it.
 * Every failed status poll doubles the wait before the next (2, 4, 8, 16, 32,
 * then 60 s), and nothing listens for the browser coming back `online`, so
 * how soon the paid screen follows the connection depends on how long it was
 * gone. A payer who walked out of wifi range should see paid within 10 s of
 * being back.
 */
async function longOutage(surface, browser, t) {
  const payer = await visit(browser, surface, { resume: true });
  try {
    await payer.load();
    await payer.bitcoin().click();
    await payer.invoiceOnScreen();
    await payer.tab.context.setOffline(true);
    // The outage is the case: it lasts on the clock.
    await payer.page.waitForTimeout(20_000);
    settleOnly(payer);
    await payer.page.waitForTimeout(25_000);
    await assertPayerSafe(payer, "45 s offline");
    assert.equal(await payer.alerts().count(), 0, "an outage is not an error panel");
    await payer.tab.context.setOffline(false);
    const back = Date.now();
    assert.equal(await payer.paidWithin(90_000), true, "paid reaches the screen after the outage");
    const ms = Date.now() - back;
    t.diagnostic(`paid on screen ${(ms / 1000).toFixed(1)} s after the connection came back`);
    await assertPaidOnce(payer, "after the outage");
    await whileOpen(t, open("slow-after-outage"), async () => {
      assert.ok(
        ms <= 10_000,
        `paid arrived ${(ms / 1000).toFixed(1)} s after the connection came back, not within 10 s`,
      );
    });
  } finally {
    await payer.close();
  }
}

/**
 * 12. Chromium only: a whole Lightning walk on a slow 3G connection (Chrome
 * DevTools' "Slow 3G": 2 s round trip, 50 kB/s each way), with the checkout's
 * script sent gzipped as a shop's server would. Records how long each stage
 * took; asserts only that every stage finishes and nothing is doubled.
 */
async function slow3g(surface, browser, t) {
  const payer = await visit(browser, surface, { resume: true, lab: { gzip: true } });
  const stack = payer.lab.stack;
  try {
    const cdp = await payer.tab.context.newCDPSession(payer.page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 2_000,
      downloadThroughput: 50_000,
      uploadThroughput: 50_000,
    });
    const stages = {};
    let mark = Date.now();
    const lap = (name) => {
      const now = Date.now();
      stages[name] = now - mark;
      mark = now;
    };
    await payer.page.goto(payer.url, { timeout: 120_000 });
    await payer.bitcoin().waitFor({ state: "visible", timeout: 120_000 });
    lap("open the page to the tiles");
    await payer.bitcoin().click();
    await payer.invoiceOnScreen(120_000);
    lap("pick Bitcoin to the invoice");
    settleOnly(payer);
    await payer.paidOnScreen(120_000);
    lap("pay to the receipt");
    t.diagnostic(
      `slow 3G: ${Object.entries(stages)
        .map(([name, ms]) => `${name} ${(ms / 1000).toFixed(1)} s`)
        .join(", ")}`,
    );
    assert.equal(payer.mintedHashes().length, 1, "one mint");
    assert.equal(stack.wallet.listInvoices().length, 1);
    assert.equal(await payer.settledOnPage(), 1);
    assert.equal(stack.settlements.length, 1);
    assert.deepEqual(await payer.uncaught(), []);
  } finally {
    await payer.close();
  }
}

// -------------------------------------------------------------------- the runs

/** Run [surface, name, case] triples as concurrent subtests of `t`. */
function runCases(t, browser, cases) {
  return Promise.all(
    cases.map(([surface, name, run]) =>
      t.test(`${surface.name}: ${name}`, async (st) => {
        if (surface.available !== undefined && !surface.available()) {
          if (REQUIRE) assert.fail(surface.unavailable);
          return st.skip(surface.unavailable);
        }
        await run(surface, browser, st);
      }),
    ),
  );
}

const RELOADS = [
  [ELEMENT, "while the invoice is being made: the same invoice after it", reloadWhileMinting],
  [ELEMENT, "while the swap is being started: the same deposit after it", reloadWhileStartingSwap],
  [
    ELEMENT,
    "while the shop still waits on the wallet: one invoice, no error",
    (surface, browser, t) => reloadWhileShopWaits(surface, browser, t, { swap: false }),
  ],
  [
    ELEMENT,
    "while the shop still waits on the swap provider: one order, no error",
    (surface, browser, t) => reloadWhileShopWaits(surface, browser, t, { swap: true }),
  ],
  [ELEMENT, "on the network step and with a quote out: nothing was started", reloadBeforeStarting],
  [
    ELEMENT,
    "while the refund is being sent: the refund once, on screen after it",
    reloadWhileRefunding,
  ],
  [
    ELEMENT,
    "as the invoice is paid, on a bare page: the receipt without a click",
    (surface, browser, t) => reloadAsItIsPaid(surface, browser, t, { resume: false }),
  ],
  [
    ELEMENT,
    "as the invoice is paid, on a page with the way back: the receipt without a click",
    (surface, browser, t) => reloadAsItIsPaid(surface, browser, t, { resume: true }),
  ],
  [
    ELEMENT,
    "as the invoice is paid, then a coin: no deposit address for a paid order",
    paidThenCoin,
  ],
  [
    ELEMENT,
    "the invoice is paid while the SOL deposit is open: the receipt, there and after a reload",
    paidElsewhereWhileSwapOpen,
  ],
  [REACT, "while the invoice is being made: the same invoice after it", reloadWhileMinting],
  [REACT, "while the swap is being started: the same deposit after it", reloadWhileStartingSwap],
  [
    REACT,
    "as the invoice is paid, on a bare page: the receipt without a click",
    (surface, browser, t) => reloadAsItIsPaid(surface, browser, t, { resume: false }),
  ],
];

const BAD_NETWORK = [
  ...[
    [ELEMENT, false, "drop"],
    [ELEMENT, false, "504"],
    [ELEMENT, true, "drop"],
    [ELEMENT, true, "504"],
    [REACT, false, "drop"],
    [REACT, true, "drop"],
  ].map(([surface, swap, how]) => [
    surface,
    `the ${swap ? "swap start" : "mint"}'s answer is lost (${how === "drop" ? "connection cut" : "gateway 504"}): the retry gets the same attempt`,
    (s, browser, t) => lostAnswer(s, browser, t, { swap, how }),
  ]),
  [
    ELEMENT,
    "2-4 s answers and a double-clicking payer: one invoice",
    (surface, browser, t) => impatientOnSlowNetwork(surface, browser, t, { swap: false }),
  ],
  [
    ELEMENT,
    "2-4 s answers and a double-clicking payer: one swap",
    (surface, browser, t) => impatientOnSlowNetwork(surface, browser, t, { swap: true }),
  ],
  ...["/checkouts/prepare", "/checkouts", "/swaps", "/payments/check"].map((route) => [
    ELEMENT,
    `a ${route} that never answers`,
    (surface, browser, t) => neverAnswers(surface, browser, t, { route }),
  ]),
  [
    ELEMENT,
    "proxy pages and a captive portal answer the invoice's status poll",
    (surface, browser, t) => strangersAnswerThePoll(surface, browser, t, { swap: false }),
  ],
  [
    ELEMENT,
    "proxy pages and a captive portal answer the swap's status poll",
    (surface, browser, t) => strangersAnswerThePoll(surface, browser, t, { swap: true }),
  ],
  [ELEMENT, "the connection flaps for 20 s and the invoice is paid meanwhile", flapping],
  [ELEMENT, "45 s offline, paid meanwhile: paid soon after the connection is back", longOutage],
];

/** Which engines handed the page back from the back/forward cache, for the report. */
const bfcacheRestores = new Map();
test.after(() => {
  if (bfcacheRestores.size === 0) return;
  const lines = [...bfcacheRestores].map(([name, restored]) => `${name}: ${restored}`);
  process.stdout.write(`back/forward cache restores: ${lines.join("; ")}\n`);
});

/**
 * Playwright starts Chromium with its back/forward cache off
 * (`--disable-back-forward-cache`), and its default headless shell refuses the
 * cache anyway (`BackForwardCacheDisabledForDelegate`). Chrome ships with it
 * on. Case 6 runs on the full Chromium build in headless mode, started
 * without that switch, so it meets the cache a payer meets; where that build
 * is not installed, it runs on the lab's Chromium and says so.
 */
async function chromiumWithBfcache() {
  const { chromium } = await import("@playwright/test");
  try {
    return await chromium.launch({
      channel: "chromium",
      ignoreDefaultArgs: ["--disable-back-forward-cache"],
    });
  } catch {
    return undefined;
  }
}

for (const engine of requestedEngines()) {
  test(`${engine}: a reload in the middle of a step`, {
    concurrency: 4,
    timeout: 900_000,
  }, async (t) => {
    const { browser, skip } = await launchEngine(engine);
    if (skip !== undefined) return t.skip(skip);
    await runCases(t, browser, RELOADS);
  });

  test(`${engine}: Back to the open invoice`, { concurrency: 2, timeout: 300_000 }, async (t) => {
    const { browser: launched, skip } = await launchEngine(engine);
    if (skip !== undefined) return t.skip(skip);
    const own = engine === "chromium" ? await chromiumWithBfcache() : undefined;
    const browser = own ?? launched;
    try {
      await runCases(t, browser, [
        [
          ELEMENT,
          "left between two polls, then paid",
          (surface, b, st) =>
            backForward(surface, b, st, {
              inFlight: false,
              report: (restored) => bfcacheRestores.set(`${engine} (between polls)`, restored),
            }),
        ],
        [
          ELEMENT,
          "left with a poll in flight, then paid",
          (surface, b, st) =>
            backForward(surface, b, st, {
              inFlight: true,
              report: (restored) => bfcacheRestores.set(`${engine} (poll in flight)`, restored),
            }),
        ],
      ]);
    } finally {
      await own?.close();
    }
  });

  test(`${engine}: a bad network`, { concurrency: 6, timeout: 900_000 }, async (t) => {
    const { browser, skip } = await launchEngine(engine);
    if (skip !== undefined) return t.skip(skip);
    await runCases(t, browser, [
      ...BAD_NETWORK,
      ...(engine === "chromium"
        ? [[ELEMENT, "a whole Lightning walk on slow 3G (Chromium's network emulation)", slow3g]]
        : []),
    ]);
  });
}
