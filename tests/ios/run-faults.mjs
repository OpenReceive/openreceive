#!/usr/bin/env node
// A bad network, in real Safari on the iOS simulator: the checkout served by
// the browser lab (tests/helpers/real-browser-lab.mjs) with a request that
// hangs, a proxy's 502, a slow wallet scan, and a reload while the swap is
// being prepared. The same cases as tests/real-browser-interruptions.test.mjs,
// touched by a finger instead of Playwright's clicks. Each case must offer a
// way on (Try again) or reach the receipt; none may show an error page, a
// proxy's words or a second invoice.
//
//   IOS_UDID=<udid> node --import tsx tests/ios/run-faults.mjs
//   IOS_UDID=<udid> CASES=hung-create SURFACES=element node --import tsx tests/ios/run-faults.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wrapperBundle } from "../helpers/real-browser-bundles.mjs";
import {
  checkoutTag,
  createLab,
  documentHtml,
  holdCalls,
  STANDALONE_SCRIPT,
} from "../helpers/real-browser-lab.mjs";
import { Inspector, Phone, SAFARI, simctl, sleep, waitForValue } from "./ios-device.mjs";
import { PROBE } from "./page-probes.mjs";
import { createTouch, slug } from "./touch.mjs";

process.env.LOG_LEVEL ??= "error";
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const UDID = process.env.IOS_UDID;
if (!UDID) {
  console.error("set IOS_UDID to a booted simulator");
  process.exit(1);
}
const APPIUM_URL = process.env.APPIUM_URL ?? "http://127.0.0.1:4723";
const ALL_CASES = [
  "hung-create",
  "create-502",
  "slow-scan",
  "poll-strangers",
  "hung-poll",
  "reload-preparing",
];
const CASES = (process.env.CASES ?? ALL_CASES.join(",")).split(",").map((s) => s.trim());
const SURFACES = (process.env.SURFACES ?? "element,react").split(",").map((s) => s.trim());
const iosVersion = simctl("getenv", UDID, "SIMULATOR_RUNTIME_VERSION").trim();
const sim = Object.values(JSON.parse(simctl("list", "devices", "-j")).devices)
  .flat()
  .find((d) => d.udid === UDID);
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT =
  process.env.OUT ??
  path.join(
    here,
    "results",
    `${stamp}-${slug(sim.deviceTypeIdentifier.split(".").pop())}-ios${iosVersion}-faults`,
  );
mkdirSync(OUT, { recursive: true });

const REFERENCE = "order-ios-fault";
const HANG_MS = 35_000;
const PROXY_502 =
  "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx</center></body></html>";
const PROXY_504 =
  "<!DOCTYPE html><html><head><title>504 Gateway Time-out</title></head><body><center><h1>504 Gateway Time-out</h1></center><hr><center>nginx</center></body></html>";
const CAPTIVE_PORTAL =
  "<!DOCTYPE html><html><head><title>Sign in to Wi-Fi</title></head><body><h1>Welcome to Airport Wi-Fi</h1><form><button>Connect</button></form></body></html>";
/** Words a payer must not read when the network fails (tests/real-browser-interruptions.test.mjs). */
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
  ["status code", /\b(?:status|HTTP)\s*(?:code\s*)?[45]\d\d\b/i],
  ["field name", /\b(?:payment_hash|pay_in_asset|amount_msats|swap_data|bolt11)\b/],
];
const bannedWords = (text) => {
  const flat = text.replace(/\s+/g, " ");
  return BANNED.flatMap(([term, pattern]) => {
    const at = flat.search(pattern);
    return at < 0 ? [] : [`${term}: "…${flat.slice(Math.max(0, at - 40), at + 60)}…"`];
  });
};

const report = { started: new Date().toISOString(), device: {}, journeys: {}, problems: [] };
const t0 = Date.now();
const log = (...parts) =>
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...parts);
let shotIndex = 0;
const phone = new Phone(APPIUM_URL, UDID);
async function shot(name, { settleMs = 600 } = {}) {
  await sleep(settleMs);
  shotIndex += 1;
  const file = `${String(shotIndex).padStart(2, "0")}-${name}.png`;
  phone.screenshot(path.join(OUT, file));
  return file;
}
function problem(journey, step, what, screenshot, extra = {}) {
  report.problems.push({ journey, step, what, screenshot, ...extra });
  log(`PROBLEM [${journey} / ${step}] ${what}${screenshot ? ` (${screenshot})` : ""}`);
}

// ------------------------------------------------------------- the pages

/**
 * The probe goes into the page's own head. Listeners the Inspector adds after
 * load do not get touches on iOS (a page with no script of its own received
 * no pointerdown or touchstart at all), so the page must carry them from the start.
 */
const PROBE_TAG = `<script>(${PROBE})()</script>`;
const HEAD = `<p class="lab-head" style="margin:12px 16px;font:14px system-ui;color:#555">iOS fault lab</p>`;
/** The resume the guides document: keep the attempt, hand it back on the next visit. */
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

const SURFACE = {
  element: {
    name: "the element",
    async html(lab) {
      return documentHtml({
        head: PROBE_TAG,
        body: `${HEAD}${checkoutTag({ reference: REFERENCE, prefix: lab.prefix, resumable: "" })}
<script>${RESUME_SCRIPT}</script>
<script type="module" src="${STANDALONE_SCRIPT}"></script>`,
      });
    },
  },
  react: {
    name: "React's checkout",
    async html(lab) {
      const styles = lab.asset(
        "react-styles.css",
        readFileSync(path.join(repoRoot, "packages/js/react/dist/styles.css"), "utf8"),
        "text/css",
      );
      const bundle = lab.asset("react.js", await wrapperBundle("react"));
      const boot = `import "${bundle}";
const key = "lab.resume.${REFERENCE}";
let saved = null;
try { saved = JSON.parse(localStorage.getItem(key) ?? "null"); } catch {}
const resume = saved === null ? {} : { resumePaymentHash: saved.hash, ...(saved.rail === "lightning" ? { resumePaymentRail: "lightning" } : {}) };
window.mountCheckout({
  reference: ${JSON.stringify(REFERENCE)},
  prefix: ${JSON.stringify(lab.prefix)},
  defaultTheme: "light",
  resumable: true,
  ...resume,
  onState: (state) => {
    if ((state.rail === "swap" || state.rail === "lightning") && state.payment_hash && !state.settled) {
      localStorage.setItem(key, JSON.stringify({ hash: state.payment_hash, rail: state.rail }));
    }
  },
}, { strict: false });`;
      return documentHtml({
        head: `${PROBE_TAG}<link rel="stylesheet" href="${styles}">`,
        body: `${HEAD}<div id="app" style="margin: 0 12px"></div><script type="module">${boot}</script>`,
      });
    },
  },
};

const Q = {
  bitcoin: { sel: "button, [role=button]", name: "^Bitcoin", visible: true },
  sol: { sel: "button, [role=button]", name: "^SOL", visible: true },
  cont: { sel: "button", name: "^Continue", visible: true },
  preparing: { sel: "button", name: "^Preparing payment", visible: true },
  tryAgain: { sel: "button", name: "^Try again$", visible: true },
  copyInvoice: { sel: "button", name: "copy invoice", flags: "i", visible: true },
  paid: { sel: "*", ownText: "Payment (complete|received)", visible: true },
  solDeposit: { sel: "*", ownText: "SOL on the Solana network", visible: true },
  alert: { sel: "[role=alert]", visible: true },
};

// --------------------------------------------------------------- a visit

/** One payer on one shop: a fresh lab, its page open in Safari, and a finger on it. */
async function visit(surfaceName, labOptions = {}) {
  const lab = await createLab(labOptions);
  lab.stack.addOrder(REFERENCE, 21_000);
  const url = lab.page(await SURFACE[surfaceName].html(lab));
  const web = new Inspector(UDID, new URL(lab.origin).host);
  const touch = createTouch({
    phone,
    web,
    log,
    shot,
    problem,
    report,
    calibrateOn: { sel: ".lab-head", visible: true },
  });
  const payer = {
    lab,
    web,
    touch,
    url,
    async open() {
      simctl("openurl", UDID, url);
      await sleep(2000);
      await web.connect();
      await web.select(30_000);
      await waitForValue(() => web.ev("document.readyState === 'complete'"), 30_000);
      await touch.probe();
      await touch.calibrate();
    },
    /** What the payer reads in the checkout, shadow DOM included. */
    text: () =>
      web.ev(`(() => {
        const host = document.querySelector("openreceive-checkout") ?? document.querySelector("[data-openreceive-root]");
        if (!host) return document.body.innerText;
        const root = host.shadowRoot ?? host;
        return [...root.children].filter((n) => n instanceof HTMLElement && !["STYLE","SCRIPT"].includes(n.tagName)).map((n) => n.innerText).join("\\n");
      })()`),
    minted: () =>
      lab
        .servedTo("/checkouts")
        .filter((e) => e.status === 200 || e.status === 201)
        .map((e) => e.body.checkout.payment_hash),
    async close() {
      lab.clearFaults();
      await web.disconnect();
      await lab.close().catch(() => undefined);
    },
  };
  return payer;
}

/** Wait for any of the named screens; resolves the first name that shows. */
async function firstOf(touch, screens, timeoutMs) {
  return waitForValue(
    async () => {
      for (const [name, q] of Object.entries(screens)) if (await touch.exists(q)) return name;
      return undefined;
    },
    timeoutMs,
    400,
  );
}

async function safe(payer, j, label) {
  const text = await payer.text().catch(() => "");
  const bad = bannedWords(text);
  j.read ??= {};
  j.read[label] = text.replace(/\s+/g, " ").slice(0, 300);
  if (bad.length > 0)
    problem(
      j.name,
      label,
      `the payer reads: ${bad.join("; ")}`,
      await shot(`${slug(j.name)}-${label}-banned`),
    );
}

// --------------------------------------------------------------- the cases

const CASE = {
  /** POST /checkouts never answers: a way on within the checkout's own time limit. */
  async "hung-create"(payer, j) {
    const { touch, lab } = payer;
    const hang = lab.fault({ method: "POST", route: "/checkouts", hold: "before", times: 1 });
    await touch.realTap(Q.bitcoin, "Bitcoin", { journey: j.name });
    await hang.reached();
    const started = Date.now();
    const shown = await firstOf(touch, { tryAgain: Q.tryAgain, invoice: Q.copyInvoice }, HANG_MS);
    j.offered = { shown, afterMs: Date.now() - started };
    j.shots.push(await shot(`${slug(j.name)}-after-hang`));
    await safe(payer, j, "after the hang");
    if (shown === undefined) {
      problem(
        j.name,
        "hung request",
        `${HANG_MS / 1000} s after the request hung, the payer has no way on: ${(await payer.text()).replace(/\s+/g, " ").slice(0, 140)}`,
        j.shots.at(-1),
      );
      return;
    }
    if (shown === "tryAgain") {
      await touch.realTap(Q.tryAgain, "Try again", { journey: j.name });
      j.afterTryAgain = await firstOf(touch, { invoice: Q.copyInvoice, alert: Q.alert }, 20_000);
      j.shots.push(await shot(`${slug(j.name)}-after-try-again`));
      if (j.afterTryAgain !== "invoice")
        problem(
          j.name,
          "try again",
          `Try again led to ${j.afterTryAgain ?? "nothing within 20 s"}, not the invoice`,
          j.shots.at(-1),
        );
    }
    hang.remove();
    await sleep(1000);
    j.mintedHashes = [...new Set(payer.minted())];
    if (j.mintedHashes.length > 1)
      problem(
        j.name,
        "invoices",
        `the order got ${j.mintedHashes.length} different invoices`,
        j.shots.at(-1),
      );
  },

  /** A proxy answers POST /checkouts with its own 502 page. */
  async "create-502"(payer, j) {
    const { touch, lab } = payer;
    lab.fault({
      method: "POST",
      route: "/checkouts",
      times: 1,
      respond: { status: 502, body: PROXY_502 },
    });
    await touch.realTap(Q.bitcoin, "Bitcoin", { journey: j.name });
    const shown = await firstOf(touch, { tryAgain: Q.tryAgain, invoice: Q.copyInvoice }, 20_000);
    j.offered = shown;
    j.shots.push(await shot(`${slug(j.name)}-after-502`));
    await safe(payer, j, "after the 502");
    if (shown === undefined)
      problem(
        j.name,
        "502",
        "after the proxy's 502 the payer has neither Try again nor the invoice",
        j.shots.at(-1),
      );
    if (shown === "tryAgain") {
      await touch.realTap(Q.tryAgain, "Try again", { journey: j.name });
      j.afterTryAgain = await firstOf(touch, { invoice: Q.copyInvoice, alert: Q.alert }, 20_000);
      j.shots.push(await shot(`${slug(j.name)}-after-try-again`));
      if (j.afterTryAgain !== "invoice")
        problem(
          j.name,
          "try again",
          `Try again led to ${j.afterTryAgain ?? "nothing"}`,
          j.shots.at(-1),
        );
    }
    j.mintedHashes = [...new Set(payer.minted())];
    if (j.mintedHashes.length > 1)
      problem(
        j.name,
        "invoices",
        `the order got ${j.mintedHashes.length} different invoices`,
        j.shots.at(-1),
      );
  },

  /** The wallet scan takes 10 s while the invoice is paid: the receipt still comes. */
  async "slow-scan"(payer, j) {
    const { touch, lab } = payer;
    await touch.realTap(Q.bitcoin, "Bitcoin", { journey: j.name });
    await touch.waitShown(Q.copyInvoice, 20_000, "the invoice");
    const scan = holdCalls(lab.stack.wallet, "listTransactions");
    const [hash] = payer.minted();
    lab.stack.wallet.settleInvoice({ payment_hash: hash });
    await scan.reached(1, { timeoutMs: 20_000 }).catch(() => undefined);
    await sleep(10_000);
    j.duringHold = { alert: await touch.exists(Q.alert) };
    j.shots.push(await shot(`${slug(j.name)}-scan-held`));
    await safe(payer, j, "while the scan is slow");
    scan.restore();
    const released = Date.now();
    const shown = await firstOf(touch, { paid: Q.paid }, 30_000);
    j.paidAfterReleaseMs = shown ? Date.now() - released : undefined;
    j.shots.push(await shot(`${slug(j.name)}-after-scan`));
    if (!shown)
      problem(
        j.name,
        "slow scan",
        "30 s after the slow scan finished, the receipt has not shown",
        j.shots.at(-1),
      );
    if (j.duringHold.alert)
      problem(
        j.name,
        "slow scan",
        "a slow wallet scan put an error panel on the invoice screen",
        j.shots.at(-2),
      );
  },

  /** A 502, a 504 and a captive portal answer the status poll; then the shop answers again. */
  async "poll-strangers"(payer, j) {
    const { touch, lab } = payer;
    await touch.realTap(Q.bitcoin, "Bitcoin", { journey: j.name });
    await touch.waitShown(Q.copyInvoice, 20_000, "the invoice");
    const [hash] = payer.minted();
    const strangers = [
      lab.fault({ route: "/payments/check", times: 1, respond: { status: 502, body: PROXY_502 } }),
      lab.fault({ route: "/payments/check", times: 1, respond: { status: 504, body: PROXY_504 } }),
      lab.fault({
        route: "/payments/check",
        times: 1,
        respond: { status: 200, body: CAPTIVE_PORTAL },
      }),
    ];
    j.alerts = [];
    for (const [index, stranger] of strangers.entries()) {
      await stranger.reached(1, { timeoutMs: 40_000 });
      await sleep(500);
      j.alerts.push(await touch.exists(Q.alert));
      await safe(payer, j, `after stranger ${index + 1}`);
    }
    j.shots.push(await shot(`${slug(j.name)}-after-strangers`));
    if (j.alerts.some(Boolean))
      problem(
        j.name,
        "poll",
        `an error panel showed while strangers answered the poll (${j.alerts})`,
        j.shots.at(-1),
        { severity: "polish" },
      );
    lab.stack.wallet.settleInvoice({ payment_hash: hash });
    const back = Date.now();
    const shown = await firstOf(touch, { paid: Q.paid }, 40_000);
    j.paidAfterMs = shown ? Date.now() - back : undefined;
    j.shots.push(await shot(`${slug(j.name)}-receipt`));
    if (!shown)
      problem(
        j.name,
        "poll",
        "after the strangers, the paid order did not reach the receipt within 40 s",
        j.shots.at(-1),
      );
  },

  /** A status poll that never answers while the invoice is paid. */
  async "hung-poll"(payer, j) {
    const { touch, lab } = payer;
    await touch.realTap(Q.bitcoin, "Bitcoin", { journey: j.name });
    await touch.waitShown(Q.copyInvoice, 20_000, "the invoice");
    const [hash] = payer.minted();
    const hang = lab.fault({ method: "POST", route: "/payments/check", hold: "before", times: 1 });
    await hang.reached(1, { timeoutMs: 20_000 });
    lab.stack.wallet.settleInvoice({ payment_hash: hash });
    const started = Date.now();
    const shown = await firstOf(touch, { paid: Q.paid }, HANG_MS);
    j.paidAfterMs = shown ? Date.now() - started : undefined;
    j.shots.push(await shot(`${slug(j.name)}-after-hung-poll`));
    await safe(payer, j, "after the hung poll");
    if (!shown)
      problem(
        j.name,
        "hung poll",
        `with one status poll hung, the paid order is not on the receipt after ${HANG_MS / 1000} s`,
        j.shots.at(-1),
      );
    hang.remove();
  },

  /** Safari's reload button while Continue says "Preparing payment" (the swap start is held). */
  async "reload-preparing"(payer, j) {
    const { touch, lab, web } = payer;
    const start = lab.fault({ method: "POST", route: "/swaps", hold: "after", times: 1 });
    await touch.realTap(Q.sol, "SOL", { journey: j.name });
    await touch.realTap(Q.cont, "Continue", { journey: j.name });
    await start.reached();
    j.preparingShown = (await touch.waitFor(Q.preparing, 5000)) !== undefined;
    j.shots.push(await shot(`${slug(j.name)}-preparing`));
    const provider = lab.stack.swapProvider;
    j.createCallsBefore = provider.createCalls;
    const loadedAt = await web.ev("window.__lab.loadedAt");
    await phone.reload();
    await waitForValue(
      async () => {
        await web.select(5000).catch(() => undefined);
        const now = await web.ev("window.__lab?.loadedAt").catch(() => "gone");
        return now !== loadedAt && now !== "gone" ? true : undefined;
      },
      20_000,
      700,
    );
    await touch.probe();
    const after = await firstOf(
      touch,
      { grid: Q.sol, deposit: Q.solDeposit, alert: Q.alert },
      20_000,
    );
    j.afterReload = after;
    j.shots.push(await shot(`${slug(j.name)}-after-reload`));
    await safe(payer, j, "after the reload");
    if (after === "alert")
      problem(
        j.name,
        "reload",
        "a reload while the payment was being prepared left an error panel",
        j.shots.at(-1),
      );
    if (after === "grid") {
      await touch.realTap(Q.sol, "SOL", { journey: j.name });
      await touch.realTap(Q.cont, "Continue", { journey: j.name });
    }
    const deposit = await firstOf(touch, { deposit: Q.solDeposit, alert: Q.alert }, 20_000);
    j.shots.push(await shot(`${slug(j.name)}-deposit`));
    j.createCalls = provider.createCalls;
    if (deposit !== "deposit")
      problem(
        j.name,
        "reload",
        `after the reload and SOL again the payer sees ${deposit ?? "no deposit screen"}`,
        j.shots.at(-1),
      );
    if (provider.createCalls > 1)
      problem(
        j.name,
        "reload",
        `the reload opened ${provider.createCalls} provider orders for one order`,
        j.shots.at(-1),
      );
    const hashes = lab
      .servedTo("/swaps")
      .filter((e) => e.status === 200 || e.status === 201)
      .map((e) => e.body.swap.checkout.payment_hash);
    j.swapHashes = [...new Set(hashes)];
    if (j.swapHashes[0]) {
      lab.stack.wallet.settleInvoice({ payment_hash: j.swapHashes[0] });
      j.paid = (await firstOf(touch, { paid: Q.paid }, 30_000)) !== undefined;
      j.shots.push(await shot(`${slug(j.name)}-receipt`));
      if (!j.paid)
        problem(
          j.name,
          "reload",
          "the swap's invoice was paid; the receipt did not show within 30 s",
          j.shots.at(-1),
        );
    }
  },
};

// --------------------------------------------------------------- the run

log(`opening Appium session on ${sim.name} (iOS ${iosVersion})`);
await phone.open();
await phone.activate(SAFARI);
report.device = {
  name: sim.name,
  type: sim.deviceTypeIdentifier,
  ios: iosVersion,
  udid: UDID,
  screen: phone.size,
};
for (const surface of SURFACES) {
  for (const name of CASES) {
    if (!CASE[name]) throw new Error(`no case ${name}; cases: ${ALL_CASES.join(", ")}`);
    const key = `${surface}: ${name}`;
    const j = { name: key, shots: [], started: new Date().toISOString() };
    report.journeys[key] = j;
    log(`=== ${key}`);
    const payer = await visit(surface);
    const started = Date.now();
    try {
      await payer.open();
      await payer.touch.waitShown(Q.bitcoin, 30_000, "the checkout");
      await CASE[name](payer, j);
      j.ok = true;
    } catch (error) {
      j.ok = false;
      j.error = String(error?.stack ?? error).slice(0, 1500);
      problem(
        key,
        "harness",
        `case stopped: ${String(error).slice(0, 300)}`,
        await shot(`${slug(key)}-error`).catch(() => undefined),
      );
    } finally {
      j.seconds = Math.round((Date.now() - started) / 1000);
      j.fetches = await payer.web.ev("window.__lab?.fetches ?? []").catch(() => undefined);
      j.console = payer.web.console.filter((c) => c.level === "error");
      for (const c of j.console)
        problem(key, "console", `console error: ${c.text.slice(0, 200)}`, undefined, {
          severity: "info",
        });
      j.served = payer.lab.served.map(({ method, path: p, status, fault, handled }) => ({
        method,
        path: p,
        status,
        fault,
        handled,
      }));
      await payer.close();
    }
  }
}
report.finished = new Date().toISOString();
writeFileSync(path.join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
log(
  `report: ${path.relative(process.cwd(), OUT)}/report.json; ${report.problems.length} problem(s)`,
);
for (const p of report.problems)
  log(` - [${p.journey} / ${p.step}] ${p.what}${p.screenshot ? ` (${p.screenshot})` : ""}`);
await phone.close();
process.exit(0);
