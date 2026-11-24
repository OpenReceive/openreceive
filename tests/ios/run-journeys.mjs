#!/usr/bin/env node
// Payer journeys in real Safari on the iOS simulator, against the Buy a
// Button shop in testkit wallet mode. The iOS twin of tests/android/run-journeys.mjs:
// the same journeys, the same measurements, the same report.json.
//
// The Inspector (Safari's Web Inspector socket) only OBSERVES: the DOM, rects,
// the console, the network. Every touch a payer makes goes through
// WebDriverAgent (Appium's XCUITest driver): taps, long presses, finger drags,
// the edge-swipe Back, Safari's reload button, the software keyboard, app
// switches and rotation. See README.md for how to run it.
//
//   IOS_UDID=<udid> node tests/ios/run-journeys.mjs
//   IOS_UDID=<udid> JOURNEYS=lightning,tutorial node tests/ios/run-journeys.mjs
//   IOS_UDID=<udid> FRAMEWORK=Vue node tests/ios/run-journeys.mjs
//
// Writes screenshots and report.json under
// tests/ios/results/<time>-<device>-<ios>-<tab>/.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Inspector, Phone, SAFARI, simctl, sleep, waitForValue } from "./ios-device.mjs";
import { CONTRAST } from "./page-probes.mjs";
import { createTouch, MIN_TAP_PT, slug } from "./touch.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const UDID = process.env.IOS_UDID;
if (!UDID) {
  console.error("set IOS_UDID to a booted simulator (xcrun simctl list devices booted)");
  process.exit(1);
}
const APPIUM_URL = process.env.APPIUM_URL ?? "http://127.0.0.1:4723";
const DEVICE_URL = process.env.DEVICE_URL ?? "http://localhost:4273";
const CONTROL_URL = process.env.CONTROL_URL ?? `http://127.0.0.1:${process.env.DEMO_PORT ?? 4273}`;
const FRAMEWORK = process.env.FRAMEWORK ?? "React";
const IN_WALLET_MS = Number(process.env.IN_WALLET_MS ?? 60_000);
const LONG_WALLET_MS = Number(process.env.LONG_WALLET_MS ?? 360_000);
const ALL = [
  "lightning",
  "swap",
  "swap-paid",
  "refund-typing",
  "tutorial",
  "reload",
  "wallet",
  "wallet-long",
  "layout",
  "big-text-dark",
];
const ONLY = (process.env.JOURNEYS ?? ALL.join(",")).split(",").map((s) => s.trim());

const deviceInfo = JSON.parse(simctl("list", "devices", "-j"));
const sim = Object.entries(deviceInfo.devices)
  .flatMap(([runtime, list]) => list.map((d) => ({ ...d, runtime })))
  .find((d) => d.udid === UDID);
if (sim?.state !== "Booted") {
  console.error(`simulator ${UDID} is not booted (xcrun simctl boot ${UDID})`);
  process.exit(1);
}
const iosVersion = simctl("getenv", UDID, "SIMULATOR_RUNTIME_VERSION").trim();
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT =
  process.env.OUT ??
  path.join(
    here,
    "results",
    `${stamp}-${slug(sim.deviceTypeIdentifier.split(".").pop())}-ios${iosVersion}-${FRAMEWORK.toLowerCase()}`,
  );
mkdirSync(OUT, { recursive: true });

// A checksum-valid Solana address (44 characters) that is not the testkit deposit address.
const SOLANA_REFUND_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
// A 43-character Solana address that starts with a lowercase letter. Its
// capitalized twin (V2Ua...) also decodes to a 32-byte key, so it is just as
// "valid": Solana addresses carry no checksum.
const LOWERCASE_SOLANA_ADDRESS = "v2Ua6NdL3Z6Rvb2jfj8p7oPGUGdco4SqJd3yR5AEmhW";

const report = { started: new Date().toISOString(), device: {}, journeys: {}, problems: [] };
let shotIndex = 0;
const t0 = Date.now();
const log = (...parts) =>
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...parts);

function problem(journey, step, what, shot, extra = {}) {
  report.problems.push({ journey, step, what, screenshot: shot, ...extra });
  log(`PROBLEM [${journey} / ${step}] ${what}${shot ? ` (${shot})` : ""}`);
}

const phone = new Phone(APPIUM_URL, UDID);
const web = new Inspector(UDID, new URL(DEVICE_URL).host);

async function shot(name, { settleMs = 700 } = {}) {
  await sleep(settleMs);
  shotIndex += 1;
  const file = `${String(shotIndex).padStart(2, "0")}-${name}.png`;
  phone.screenshot(path.join(OUT, file));
  return file;
}

// ---------------------------------------------------------- real touches

const touch = createTouch({
  phone,
  web,
  log,
  shot,
  problem,
  report,
  calibrateOn: { sel: ".or-shop-head p, .or-shop-head", visible: true },
});
const {
  state,
  probe,
  find,
  exists,
  waitFor,
  waitShown,
  geometry,
  toScreen,
  reachable,
  calibrate,
  swipeIntoView,
  realTap,
  measure,
  watchShifts,
} = touch;

// -------------------------------------------------------------- testkit

async function control(route, body) {
  const response = await fetch(`${CONTROL_URL}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(
      `${route} ${JSON.stringify(body)}: HTTP ${response.status} ${await response.text()}`,
    );
}

const testkitState = () =>
  fetch(`${CONTROL_URL}/__testkit/state`)
    .then((r) => r.json())
    .catch(() => undefined);

function findLast(value, key) {
  if (typeof value !== "object" || value === null) return undefined;
  let found;
  for (const [k, v] of Object.entries(value)) {
    if (k === key && typeof v === "string" && v.length > 0) found = v;
    else {
      const nested = findLast(v, key);
      if (nested !== undefined) found = nested;
    }
  }
  return found;
}

/** The answer to the page's last POST to `route`, read by the probe's fetch wrapper. */
async function minted(route, sinceCount) {
  const body = await waitForValue(
    () =>
      web.ev(
        `(() => { const a = window.__lab.answers.filter((x) => x.path === ${JSON.stringify(route)}); return a.length > ${sinceCount} ? a.at(-1) : undefined; })()`,
      ),
    30_000,
  );
  if (body === undefined) throw new Error(`no answer to POST ${route}`);
  return {
    status: body.status,
    hash: findLast(body.json, "payment_hash"),
    bolt11: findLast(body.json, "bolt11") ?? findLast(body.json, "invoice"),
    depositAddress: findLast(body.json, "deposit_address"),
    providerOrderId: findLast(body.json, "provider_order_id"),
  };
}

const answersTo = (route) =>
  web.ev(`window.__lab.answers.filter((x) => x.path === ${JSON.stringify(route)}).length`);

// -------------------------------------------------------------- the shop

const Q = {
  head: { sel: ".or-shop-head", visible: true },
  add: { sel: "button", name: "^Add$", visible: true },
  checkout: { sel: "button", name: "^Checkout$", visible: true },
  invoiceHeading: { sel: "h1, h2, h3", name: "^Pay this invoice$" },
  bitcoin: { sel: "button, [role=button]", name: "^Bitcoin", visible: true },
  copyInvoice: { sel: "button", name: "copy invoice|copied", flags: "i", visible: true },
  usdt: { sel: "button, [role=button]", name: "^USDT", visible: true },
  solana: {
    sel: "[role=group] button",
    name: "^Solana$",
    group: "Choose USDT network",
    visible: true,
  },
  cont: { sel: "button", name: "^Continue", visible: true },
  paid: { sel: ".or-shop-status-title", name: "^Payment received$", visible: true },
  refundInput: { sel: "input", placeholder: "refund address", flags: "i", visible: true },
  review: { sel: "button", name: "^Review refund address$", visible: true },
  confirm: { sel: "button", name: "^Confirm refund$", visible: true },
  howToPay: { sel: "button", name: "how to pay", flags: "i", visible: true },
  dialog: { sel: "[role=dialog], dialog[open]", visible: true },
  switchMethod: { sel: "button", name: "switch payment method", flags: "i", visible: true },
};
const text = (pattern, flags = "") => ({ sel: "*", ownText: pattern, flags, visible: true });

async function openShop() {
  await web.select().catch(async () => {
    simctl("openurl", UDID, DEVICE_URL);
    await sleep(3000);
    await web.select();
  });
  await web.ev(`(location.href = ${JSON.stringify(DEVICE_URL)}, true)`).catch(() => undefined);
  await sleep(1500);
  await web.select();
  await waitForValue(
    () =>
      web.ev(
        `document.readyState === "complete" && document.body.innerText.includes("Buy an OR button")`,
      ),
    60_000,
    500,
  );
  await probe();
  await waitShown(Q.head, 30_000, "the shop");
}

/** Shop → one Safety Orange → Checkout, all by touch. Returns the order URL. */
async function orderOneButton(journey) {
  await openShop();
  await calibrate();
  await realTap(Q.add, "Add", { journey });
  await waitShown({ sel: ".or-shop-footer", name: "1 button", visible: true }, 15_000, "the cart");
  await realTap(Q.checkout, "Checkout", { journey });
  await sleep(1200);
  await probe();
  await waitShown(Q.invoiceHeading, 60_000, "the order page");
  if (FRAMEWORK !== "React") {
    await realTap(
      { sel: ".or-shop-stage label", name: FRAMEWORK, visible: true },
      `${FRAMEWORK} tab`,
      { journey },
    );
    await sleep(800);
  }
  await waitShown(Q.bitcoin, 60_000, "the Bitcoin tile");
  return web.ev("location.href");
}

async function lightningInvoice(journey) {
  const before = await answersTo("/openreceive/checkouts");
  await realTap(Q.bitcoin, "Bitcoin tile", { journey });
  const invoice = await minted("/openreceive/checkouts", before);
  await waitShown(Q.copyInvoice, 30_000, "Copy invoice");
  return invoice;
}

async function startUsdtSolana(journey) {
  await realTap(Q.usdt, "USDT tile", { journey });
  await waitShown(Q.solana, 15_000, "the Solana network button");
  await realTap(Q.solana, "Solana network", { journey });
  await waitShown(text("≈ [\\d.]+ USDT"), 15_000, "the USDT quote");
}

/** The invoices the testkit wallet holds. */
const walletInvoices = async () => (await testkitState())?.wallet?.invoices ?? [];

/** The bolt11 the payer can see (inputs, copy rows), shadow DOM included. */
const shownBolt11 = () => web.ev("window.__lab.bolt11()");

/** The first of the named screens to show; resolves its name. */
const firstScreen = (screens, timeoutMs) =>
  waitForValue(
    async () => {
      for (const [name, q] of Object.entries(screens)) if (await exists(q)) return name;
      return undefined;
    },
    timeoutMs,
    300,
  );

async function reloadViaToolbar() {
  const before = await web.ev("window.__lab.loadedAt").catch(() => undefined);
  await phone.reload();
  return before;
}

async function waitNewDocument(beforeLoadedAt, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    await sleep(700);
    try {
      await web.select(5000);
      const state = await web.ev("({ lab: window.__lab?.loadedAt, ready: document.readyState })");
      if (state.lab === undefined || state.lab !== beforeLoadedAt) {
        if (state.ready === "complete" || state.ready === "interactive") {
          await probe();
          return true;
        }
      }
    } catch {}
    if (Date.now() > until) return false;
  }
}

// ------------------------------------------------------------- journeys

async function journeyRun(name, fn) {
  if (!ONLY.includes(name)) return;
  report.journeys[name] = { started: new Date().toISOString() };
  log(`=== ${name}`);
  const started = Date.now();
  const consoleFrom = web.console.length;
  const networkFrom = web.network.length;
  try {
    await fn(report.journeys[name]);
    report.journeys[name].ok = true;
  } catch (error) {
    report.journeys[name].ok = false;
    report.journeys[name].error = String(error?.stack ?? error).slice(0, 1500);
    const file = await shot(`${name}-error`).catch(() => undefined);
    problem(name, "harness", `journey stopped: ${String(error).slice(0, 300)}`, file);
  } finally {
    const j = report.journeys[name];
    j.seconds = Math.round((Date.now() - started) / 1000);
    j.fetches = await web.ev("window.__lab?.fetches ?? []").catch(() => undefined);
    j.console = web.console.slice(consoleFrom);
    j.network = web.network.slice(networkFrom);
    for (const c of j.console) {
      // Vite's own dev socket (the lab's dev server, not the shop) is not the checkout's.
      if (c.level === "error" && !/\[vite\]|React DevTools|ws:\/\/[^ ]*\?token=/.test(c.text))
        problem(name, "console", `console error: ${c.text.slice(0, 200)}`);
    }
    for (const n of j.network) {
      if (!/\/(openreceive|api)\//.test(n.url ?? "")) continue;
      if (n.canceled) continue;
      problem(
        name,
        "network",
        `${n.method} ${new URL(n.url).pathname} ${n.failed ? `failed: ${n.failed}` : `answered ${n.status}`}`,
      );
    }
    await resetSystem();
  }
}

const system = { appearance: "light", contentSize: "large" };
async function resetSystem() {
  if (await phone.keyboardShown()) await phone.dismissKeyboard().catch(() => undefined);
  if (state.orientation !== "PORTRAIT") {
    await phone.rotate("PORTRAIT").catch(() => undefined);
    state.orientation = "PORTRAIT";
  }
  if (system.appearance !== "light") {
    simctl("ui", UDID, "appearance", "light");
    system.appearance = "light";
  }
  if (system.contentSize !== "large") {
    simctl("ui", UDID, "content_size", "large");
    system.contentSize = "large";
  }
  await phone.activate(SAFARI).catch(() => undefined);
}

// ------------------------------------------------------------- setup

log(`opening Appium session on ${sim.name} (iOS ${iosVersion})`);
await phone.open();
simctl("ui", UDID, "appearance", "light");
simctl("ui", UDID, "content_size", "large");
await phone.rotate("PORTRAIT").catch(() => undefined);
await phone.activate(SAFARI);
await web.connect();
await web.select(5000).catch(async () => {
  simctl("openurl", UDID, DEVICE_URL);
  await sleep(3000);
  await web.select(60_000);
});
report.device = {
  name: sim.name,
  type: sim.deviceTypeIdentifier,
  ios: iosVersion,
  udid: UDID,
  screen: phone.size,
  safari: await web.ev("navigator.userAgent"),
  framework: FRAMEWORK,
};
log("device", JSON.stringify(report.device));

// (a) Lightning: the invoice fits and holds still; Copy invoice reaches iOS's pasteboard.
await journeyRun("lightning", async (j) => {
  j.orderUrl = await orderOneButton("lightning");
  await measure("method grid", "lightning");
  j.shots = [await shot("lightning-grid")];
  simctl("pbcopy", UDID); // an empty pasteboard, so a stale invoice cannot pass the check
  const invoice = await lightningInvoice("lightning");
  j.paymentHash = invoice.hash;
  await sleep(800);
  const m = await measure("invoice", "lightning");
  j.shots.push(await shot("lightning-invoice"));
  j.qr = await web.ev("window.__lab.qr()");
  if (j.qr === undefined) problem("lightning", "invoice", "no QR code found on the invoice screen");
  else {
    if (j.qr.right > m.width + 1 || j.qr.left < -1)
      problem(
        "lightning",
        "invoice",
        `the QR is cut off at the side: ${Math.round(j.qr.left)}..${Math.round(j.qr.right)} of ${m.width}px`,
        j.shots.at(-1),
      );
    if (j.qr.w < 160)
      problem(
        "lightning",
        "invoice",
        `the QR is ${Math.round(j.qr.w)} pt wide on a ${m.width} pt phone`,
        j.shots.at(-1),
        { severity: "polish" },
      );
  }
  if (!(await exists(text("10,000 sats"))))
    problem(
      "lightning",
      "invoice",
      "the amount (10,000 sats) is not visible on the invoice screen",
      j.shots.at(-1),
    );
  // Does the invoice screen hold still while the countdown ticks?
  j.shifts = await watchShifts(5000);
  if (j.shifts.moved.length > 0)
    problem(
      "lightning",
      "invoice",
      `controls move while the payer reaches for them (countdown ${j.shifts.countdown.join(", ")}): ${j.shifts.moved.slice(0, 4).join("; ")}`,
      j.shots.at(-1),
    );
  const copyBox = await find(Q.copyInvoice);
  j.copyButton = copyBox;
  if (copyBox && copyBox.height < MIN_TAP_PT)
    problem(
      "lightning",
      "invoice",
      `Copy invoice is ${Math.round(copyBox.height)} pt tall (Apple asks for 44 pt)`,
      j.shots.at(-1),
      { severity: "polish" },
    );
  await realTap(Q.copyInvoice, "Copy invoice", { journey: "lightning" });
  const copied = await waitFor(text("copied", "i"), 5000);
  j.shots.push(await shot("lightning-copied", { settleMs: 300 }));
  if (!copied)
    problem(
      "lightning",
      "copy",
      'tapping Copy invoice showed no "Copied" feedback',
      j.shots.at(-1),
    );
  const pasted = phone.pasteboard().trim();
  j.clipboard = {
    pasted: pasted.slice(0, 40),
    matches: pasted.toLowerCase() === invoice.bolt11?.toLowerCase(),
  };
  if (!j.clipboard.matches)
    problem(
      "lightning",
      "copy",
      `iOS's pasteboard did not hold the BOLT11 after Copy invoice (simctl pbpaste: ${JSON.stringify(pasted.slice(0, 60))})`,
      j.shots.at(-1),
    );
  // Paid: the receipt.
  await control("/__testkit/settle", { payment_hash: invoice.hash });
  const settledAt = Date.now();
  const paid = await waitFor(Q.paid, 30_000);
  j.paidAfterSettleMs = paid ? Date.now() - settledAt : undefined;
  j.shots.push(await shot("lightning-receipt"));
  if (!paid)
    problem(
      "lightning",
      "receipt",
      "the receipt did not show within 30 s of the payment",
      j.shots.at(-1),
    );
  else await measure("receipt", "lightning");
});

// (b) Swap with the software keyboard up: the refund address typed key by key.
await journeyRun("swap", async (j) => {
  j.orderUrl = await orderOneButton("swap");
  const shots = [];
  j.shots = shots;
  await startUsdtSolana("swap");
  shots.push(await shot("swap-quote"));
  await measure("swap quote", "swap");
  const before = await answersTo("/openreceive/swaps");
  await realTap(Q.cont, "Continue", { journey: "swap" });
  const swap = await minted("/openreceive/swaps", before);
  j.swap = swap;
  await waitShown(text("Pay [\\d.]+ USDT to this address"), 30_000, "the deposit screen");
  shots.push(await shot("swap-deposit"));
  await measure("deposit", "swap");
  j.totalsOnDeposit = await web.ev("window.__lab.visibleText(/\\$\\s?5\\.00/)");
  if (j.totalsOnDeposit.length > 0)
    problem(
      "swap",
      "deposit",
      `the order total ($5.00) is on screen beside the USDT deposit amount: ${j.totalsOnDeposit.join("; ")}`,
      shots.at(-1),
    );
  j.amountsOnDeposit = await web.ev("window.__lab.visibleText(/[\\d.]+\\s*USDT/)");
  await control("/__testkit/swap-step", {
    provider_order_id: swap.providerOrderId,
    state: "refund_required",
  });
  await waitShown(text("Refund needed"), 30_000, "Refund needed");
  shots.push(await shot("swap-refund-needed"));
  await measure("refund form", "swap");
  await realTap(Q.refundInput, "refund address field", { journey: "swap" });
  const kb = await waitForValue(() => phone.keyboardShown(), 5000);
  j.keyboardShown = Boolean(kb);
  j.zoomAfterFocus = await web.ev("visualViewport.scale");
  if (j.zoomAfterFocus > 1.01)
    problem(
      "swap",
      "refund address",
      `focusing the refund address zoomed the page to ${j.zoomAfterFocus.toFixed(2)}x (a field under 16px)`,
      undefined,
    );
  if (!kb)
    problem(
      "swap",
      "refund address",
      "tapping the refund address field did not bring up the software keyboard",
    );
  j.refundInputAttrs = await web.ev(
    `(() => { const el = window.__lab.findEl(${JSON.stringify(Q.refundInput)}); const a = (n) => el.getAttribute(n); return { type: el.type, name: a("name"), autocomplete: a("autocomplete"), autocapitalize: a("autocapitalize"), autocorrect: a("autocorrect"), spellcheck: a("spellcheck"), inputmode: a("inputmode"), enterkeyhint: a("enterkeyhint"), fontSize: getComputedStyle(el).fontSize }; })()`,
  );
  await phone.type(
    SOLANA_REFUND_ADDRESS,
    "type == 'XCUIElementTypeTextField' AND placeholderValue CONTAINS[c] 'refund address'",
  );
  await sleep(1000);
  j.typed = await web.ev(`window.__lab.value(${JSON.stringify(Q.refundInput)})`);
  shots.push(await shot("swap-keyboard-up"));
  if (j.typed !== SOLANA_REFUND_ADDRESS)
    problem(
      "swap",
      "refund address",
      `typing with the software keyboard produced ${JSON.stringify(j.typed)}, not the address`,
      shots.at(-1),
    );
  // Measured on Safari's accessibility rects: the page's own viewport numbers
  // are mid-animation while the keyboard opens.
  const reach = async (label) => {
    const r = await find(Q.review);
    const g = await geometry();
    const strip = await reachable();
    const [native] = await phone.webElements("Review refund address");
    const top = native ? native.y : toScreen(g, 0, r.top).y;
    const bottom = native ? native.y + native.height : toScreen(g, 0, r.bottom).y;
    // A finger needs the middle of the button clear, not every point of it.
    const middle = (top + bottom) / 2;
    return {
      label,
      inView: top >= strip.top - 8 && middle <= strip.bottom - 8,
      coveredBottomPt: Math.max(0, Math.round(bottom - (strip.bottom + 8))),
      top,
      bottom,
      strip: [strip.top, strip.bottom],
      keyboard: strip.keyboard,
      vvHeight: Math.round(g.vvHeight),
      innerHeight: g.innerHeight,
    };
  };
  j.reach = [await reach("keyboard up, portrait")];
  if (!j.reach[0].inView) {
    await swipeIntoView(Q.review);
    const after = await reach("keyboard up, after a swipe");
    j.reach.push(after);
    shots.push(await shot("swap-keyboard-scrolled"));
    if (!after.inView || !after.keyboard)
      problem(
        "swap",
        "refund address",
        `with the keyboard up, "Review refund address" cannot be reached by scrolling (${JSON.stringify(after)})`,
        shots.at(-1),
      );
  }
  j.cutWithKeyboard = (await measure("refund form, keyboard up", "swap")).cut;
  // SKIP_ROTATE=1: on the iPhone 16 Pro simulator a rotation round trip left
  // the lab's touches missing the page for the rest of the run (README, Limits).
  if (!process.env.SKIP_ROTATE) {
    await phone.rotate("LANDSCAPE");
    state.orientation = "LANDSCAPE";
    shots.push(await shot("swap-landscape"));
    j.landscape = {
      value: await web.ev(`window.__lab.value(${JSON.stringify(Q.refundInput)})`),
      measure: await measure("refund form, landscape", "swap"),
    };
    await calibrate().catch(() => undefined);
    j.landscape.reach = await reach("landscape");
    if (j.landscape.value !== SOLANA_REFUND_ADDRESS)
      problem(
        "swap",
        "rotate",
        "rotating to landscape lost the typed refund address",
        shots.at(-1),
      );
    if (!j.landscape.reach.inView)
      problem(
        "swap",
        "rotate",
        `in landscape with the keyboard up, "Review refund address" is off the visible strip (${JSON.stringify(j.landscape.reach)})`,
        shots.at(-1),
        { severity: "polish" },
      );
    await phone.rotate("PORTRAIT");
    state.orientation = "PORTRAIT";
    shots.push(await shot("swap-portrait-again"));
    j.portraitAgain = {
      value: await web.ev(`window.__lab.value(${JSON.stringify(Q.refundInput)})`),
    };
    if (j.portraitAgain.value !== SOLANA_REFUND_ADDRESS)
      problem(
        "swap",
        "rotate",
        "rotating back to portrait lost the typed refund address",
        shots.at(-1),
      );
  }
  j.keyboardClosedVia = await phone.dismissKeyboard();
  await sleep(800);
  await calibrate();
  await realTap(Q.review, "Review refund address", { journey: "swap" });
  await waitShown(
    text(`Confirm refund to ${SOLANA_REFUND_ADDRESS}\\.`),
    15_000,
    "the refund review",
  );
  shots.push(await shot("swap-refund-review"));
  await measure("refund review", "swap");
  await realTap(Q.confirm, "Confirm refund", { journey: "swap" });
  await waitShown(text("Refund pending"), 30_000, "Refund pending");
  shots.push(await shot("swap-refund-pending"));
});

// (c) A swap stepped to paid, then Safari's reload right after paying.
await journeyRun("swap-paid", async (j) => {
  j.orderUrl = await orderOneButton("swap-paid");
  const shots = [];
  j.shots = shots;
  await startUsdtSolana("swap-paid");
  const before = await answersTo("/openreceive/swaps");
  await realTap(Q.cont, "Continue", { journey: "swap-paid" });
  const swap = await minted("/openreceive/swaps", before);
  j.swap = swap;
  await waitShown(text("Pay [\\d.]+ USDT to this address"), 30_000, "the deposit screen");
  const copyAddress = { sel: "button", name: "copy", flags: "i", visible: true };
  if (await exists(copyAddress)) {
    simctl("pbcopy", UDID);
    await realTap(copyAddress, "copy deposit address", { journey: "swap-paid" });
    await sleep(600);
    j.depositClipboard = phone.pasteboard().trim();
    if (swap.depositAddress && j.depositClipboard !== swap.depositAddress)
      problem(
        "swap-paid",
        "copy",
        `the pasteboard holds ${JSON.stringify(j.depositClipboard.slice(0, 60))}, not the deposit address`,
        await shot("swap-paid-copied"),
      );
  }
  const selector = { provider_order_id: swap.providerOrderId };
  await control("/__testkit/swap-step", { ...selector, state: "confirming" });
  await waitShown(text("Confirming payment"), 30_000, "Confirming payment");
  shots.push(await shot("swap-paid-confirming"));
  await control("/__testkit/swap-step", { ...selector, state: "completed" });
  await control("/__testkit/settle", { payment_hash: swap.hash });
  // The payer reloads the moment they have paid: the order must land on the receipt.
  const loadedAt = await reloadViaToolbar();
  const fresh = await waitNewDocument(loadedAt);
  j.reloaded = fresh;
  const seen = [];
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const now = await web
      .ev(
        "({ deposit: /to this address/.test(document.body.innerText) || !!window.__lab.find({sel:'*', ownText:'to this address', visible:true}), paid: !!window.__lab.find(" +
          JSON.stringify(Q.paid) +
          ") })",
      )
      .catch(() => undefined);
    if (now) seen.push(now);
    if (now?.paid) break;
    await sleep(250);
  }
  j.afterReload = { sawDeposit: seen.some((s) => s.deposit), paid: seen.some((s) => s.paid) };
  shots.push(await shot("swap-paid-after-reload"));
  if (j.afterReload.sawDeposit)
    problem(
      "swap-paid",
      "reload",
      "reloading right after the swap was paid showed the deposit address again before the receipt",
      shots.at(-1),
    );
  if (!j.afterReload.paid)
    problem(
      "swap-paid",
      "reload",
      "after reloading a paid swap order, the receipt did not show within 30 s",
      shots.at(-1),
    );
  else await measure("swap receipt", "swap-paid");
});

// (c') A refund address typed key by key: does iOS capitalize its first letter?
// XCUIElement.typeText types exact characters and skips the keyboard's shift
// state, so the first letter is a real tap on the software keyboard's key.
await journeyRun("refund-typing", async (j) => {
  j.orderUrl = await orderOneButton("refund-typing");
  const shots = [];
  j.shots = shots;
  await startUsdtSolana("refund-typing");
  const before = await answersTo("/openreceive/swaps");
  await realTap(Q.cont, "Continue", { journey: "refund-typing" });
  const swap = await minted("/openreceive/swaps", before);
  await waitShown(text("Pay [\\d.]+ USDT to this address"), 30_000, "the deposit screen");
  await control("/__testkit/swap-step", {
    provider_order_id: swap.providerOrderId,
    state: "refund_required",
  });
  await waitShown(text("Refund needed"), 30_000, "Refund needed");
  await realTap(Q.refundInput, "refund address field", { journey: "refund-typing" });
  await waitForValue(() => phone.keyboardShown(), 5000);
  await sleep(500);
  const first = LOWERCASE_SOLANA_ADDRESS[0];
  const key = await phone.tapNative(
    `type == 'XCUIElementTypeKey' AND name ==[c] '${first}'`,
    `the ${first} key`,
  );
  j.firstKey = key;
  await sleep(400);
  j.afterFirstKey = await web.ev(`window.__lab.value(${JSON.stringify(Q.refundInput)})`);
  shots.push(await shot("refund-typing-first-key"));
  await phone.type(
    LOWERCASE_SOLANA_ADDRESS.slice(1),
    "type == 'XCUIElementTypeTextField' AND placeholderValue CONTAINS[c] 'refund address'",
  );
  await sleep(600);
  j.typed = await web.ev(`window.__lab.value(${JSON.stringify(Q.refundInput)})`);
  shots.push(await shot("refund-typing-typed"));
  if (j.typed !== LOWERCASE_SOLANA_ADDRESS)
    problem(
      "refund-typing",
      "refund address",
      `typing ${LOWERCASE_SOLANA_ADDRESS} on the software keyboard produced ${j.typed}: iOS capitalized the first letter (the field has no autocapitalize="off")`,
      shots.at(-1),
    );
  // With the keyboard up, which rows of "Review refund address" take a tap?
  // Each probe tap starts with the field focused; the page's click and submit
  // are held back meanwhile, so the form stays as it is.
  const FIELD =
    "type == 'XCUIElementTypeTextField' AND placeholderValue CONTAINS[c] 'refund address'";
  const focusField = async () => {
    const [field] = await phone.findAll(`visible == 1 AND ${FIELD}`);
    await phone.tap(field.x + 30, field.y + field.height / 2);
    await waitForValue(() => phone.keyboardShown(), 4000);
    await sleep(900);
  };
  await web.ev(
    `(window.__labHold = (e) => { e.preventDefault(); e.stopPropagation(); }, window.__labDowns = [], window.__labDown = (e) => window.__labDowns.push(e.clientY), addEventListener("pointerdown", window.__labDown, true), addEventListener("click", window.__labHold, true), addEventListener("submit", window.__labHold, true), true)`,
  );
  j.band = [];
  try {
    for (let dy = 4; ; dy += 4) {
      await focusField();
      const [button] = await phone.webElements("Review refund address");
      if (button === undefined || dy > button.height - 2) break;
      const capsule = await phone.capsule();
      await web.ev("(window.__labDowns.length = 0, true)");
      await phone.tap(button.x + 30, button.y + dy);
      await sleep(700);
      const reached = (await web.ev("window.__labDowns.length")) > 0;
      j.band.push({
        y: button.y + dy,
        button: [button.y, button.y + button.height],
        capsuleTop: capsule?.y,
        keyboardTop: await phone.keyboardTop().catch(() => undefined),
        reached,
        keyboardAfter: await phone.keyboardShown(),
      });
    }
    // The keyboard's Return key: does it submit the form (the way around a dead tap)?
    await focusField();
    await web.ev(
      `(window.__labSubmits = 0, window.__labSubmit = () => { window.__labSubmits += 1; }, addEventListener("submit", window.__labSubmit, true), true)`,
    );
    j.returnKey = await phone
      .tapNative(
        "type == 'XCUIElementTypeButton' AND (name == 'Return' OR label ==[c] 'return' OR label ==[c] 'go' OR label ==[c] 'done')",
        "the Return key",
      )
      .then(async () => {
        await sleep(600);
        return { submitsForm: (await web.ev("window.__labSubmits")) > 0 };
      })
      .catch((error) => ({ error: String(error) }));
  } finally {
    await web.ev(
      `(removeEventListener("pointerdown", window.__labDown, true), removeEventListener("click", window.__labHold, true), removeEventListener("submit", window.__labHold, true), removeEventListener("submit", window.__labSubmit ?? (() => {}), true), true)`,
    );
  }
  log(
    "refund-typing band",
    JSON.stringify(j.band.map((b) => `${b.y}:${b.reached ? "page" : "SAFARI"}`)),
  );
  const swallowed = j.band.filter((b) => !b.reached);
  // The payer's own tap: the middle of the button, the keyboard up.
  await focusField();
  const [button] = await phone.webElements("Review refund address");
  shots.push(await shot("refund-typing-keyboard-up"));
  await web.ev("(window.__lab.tap = undefined, true)");
  await phone.tap(button.x + button.width / 2, button.y + button.height / 2);
  await sleep(1500);
  j.middleTap = {
    at: [Math.round(button.x + button.width / 2), Math.round(button.y + button.height / 2)],
    reachedPage: (await web.ev("window.__lab.tap")) !== undefined,
    reviewOpened: await exists(text("Confirm refund to ")),
    keyboardAfter: await phone.keyboardShown(),
  };
  shots.push(await shot("refund-typing-after-middle-tap"));
  if (!j.middleTap.reachedPage)
    problem(
      "refund-typing",
      "refund address",
      `with the keyboard up, a tap on the middle of "Review refund address" (y ${j.middleTap.at[1]}) never reaches the page: Safari closes the keyboard and shows its address bar, and the payer has to tap again. Rows that went to Safari: ${swallowed.map((b) => b.y).join(", ")} of the button's ${button.y}..${button.y + button.height} (the minimized address bar starts at ${swallowed[0]?.capsuleTop})`,
      shots.at(-1),
    );
  if (!j.middleTap.reviewOpened)
    await realTap(Q.review, "Review refund address", { journey: "refund-typing" });
  await sleep(1500);
  shots.push(await shot("refund-typing-review"));
  j.review = {
    confirmsTyped: await exists(text(`Confirm refund to ${j.typed}\\.`)),
    confirmsIntended: await exists(text(`Confirm refund to ${LOWERCASE_SOLANA_ADDRESS}\\.`)),
    alert: await web.ev("window.__lab.visibleText(/invalid|not a valid|check the address/i)"),
  };
  if (j.typed !== LOWERCASE_SOLANA_ADDRESS && j.review.confirmsTyped)
    problem(
      "refund-typing",
      "refund review",
      `the checkout accepted the capitalized address and asks to confirm a refund to ${j.typed}, a different Solana account from the one the payer typed`,
      shots.at(-1),
    );
});

// (d) The wallet walkthrough, and Safari's edge-swipe Back with it open.
await journeyRun("tutorial", async (j) => {
  j.orderUrl = await orderOneButton("tutorial");
  const shots = [];
  j.shots = shots;
  const first = await lightningInvoice("tutorial");
  j.firstHash = first.hash;
  await sleep(800);
  j.invoiceMeasure = await measure("invoice (phone audit)", "tutorial");
  if (j.invoiceMeasure.small.length > 0)
    problem(
      "tutorial",
      "invoice",
      `tap targets under 44 pt: ${j.invoiceMeasure.small.slice(0, 10).join("; ")}`,
      undefined,
      { severity: "polish" },
    );
  if (j.invoiceMeasure.cut.length > 0)
    problem(
      "tutorial",
      "invoice",
      `text cut off on a ${j.invoiceMeasure.width} pt phone: ${j.invoiceMeasure.cut.slice(0, 8).join("; ")}`,
      undefined,
      { severity: "polish" },
    );
  await realTap(Q.howToPay, "How To Pay (first wallet)", { journey: "tutorial" });
  await waitShown(Q.dialog, 15_000, "the walkthrough dialog");
  await sleep(800);
  shots.push(await shot("tutorial-open"));
  j.tutorial = await web.ev("window.__lab.dialogGeometry()");
  if (j.tutorial.box && (j.tutorial.box[1] < 0 || j.tutorial.box[0] > j.tutorial.vvHeight))
    problem(
      "tutorial",
      "walkthrough",
      `"How To Pay" opened the walkthrough off-screen: the dialog box sits at y ${j.tutorial.box[0]}..${j.tutorial.box[1]} of a ${Math.round(j.tutorial.vvHeight)} pt screen (${JSON.stringify(j.tutorial.containers)})`,
      shots.at(-1),
    );
  const bigImage = (j.tutorial.images ?? []).find((img) => img.alt);
  if (bigImage && bigImage.h > j.tutorial.vvHeight * 0.8)
    problem(
      "tutorial",
      "walkthrough",
      `the walkthrough picture is ${bigImage.h} pt tall on a ${Math.round(j.tutorial.vvHeight)} pt screen`,
      shots.at(-1),
      { severity: "polish" },
    );
  j.closeWatcher = await web.ev("typeof CloseWatcher");
  const before = await web.ev("location.href");
  const loadedAt = await web.ev("window.__lab.loadedAt");
  await phone.edgeSwipeBack();
  await sleep(2000);
  shots.push(await shot("tutorial-after-edge-swipe"));
  await web.select(10_000).catch(() => undefined);
  const after = await web
    .ev(
      "({ url: location.href, loadedAt: window.__lab?.loadedAt, dialog: !!window.__lab?.find(" +
        JSON.stringify(Q.dialog) +
        "), text: document.body.innerText.slice(0, 200) })",
    )
    .catch((e) => ({ error: String(e) }));
  j.edgeSwipe = { before, ...after, sameDocument: after.loadedAt === loadedAt };
  if (after.url !== before)
    problem(
      "tutorial",
      "edge swipe",
      `the edge-swipe Back with the walkthrough open left the checkout (${new URL(before).pathname} → ${after.url ? new URL(after.url).pathname : "?"}) instead of closing the walkthrough (Safari has no CloseWatcher: typeof CloseWatcher = ${j.closeWatcher})`,
      shots.at(-1),
    );
  else if (after.dialog)
    problem(
      "tutorial",
      "edge swipe",
      "the edge-swipe Back with the walkthrough open did nothing",
      shots.at(-1),
      { severity: "polish" },
    );
  // Forward again: a swipe from the right edge. The same invoice, and no second one.
  if (after.url !== before) {
    const { width, height } = await phone.windowSize();
    await phone.touch(
      [
        { x: width - 1, y: height / 2 },
        { x: width - 30, y: height / 2 },
        { x: width * 0.6, y: height / 2 },
        { x: width * 0.25, y: height / 2 },
      ],
      { holdMs: 20, stepMs: 90 },
    );
    await sleep(2500);
    await web.select(10_000).catch(() => undefined);
    await probe().catch(() => undefined);
    shots.push(await shot("tutorial-after-forward"));
    j.forward = await web
      .ev(
        "({ url: location.href, restored: window.__lab.events.some((e) => e.type === 'pageshow:bfcache'), loadedAt: window.__lab.loadedAt })",
      )
      .catch((e) => ({ error: String(e) }));
    j.forward.bolt11 = (await shownBolt11().catch(() => undefined))?.slice(0, 30);
    const invoices = await walletInvoices();
    j.forward.walletInvoices = invoices.length;
    if (j.forward.url !== before)
      problem(
        "tutorial",
        "edge swipe",
        `a swipe from the right edge did not bring the checkout back (${j.forward.url})`,
        shots.at(-1),
        { severity: "info" },
      );
  }
});

// (e) Reloads: Safari's reload button and pull-to-refresh on the invoice, and right after paying.
await journeyRun("reload", async (j) => {
  j.orderUrl = await orderOneButton("reload");
  const shots = [];
  j.shots = shots;
  const first = await lightningInvoice("reload");
  j.firstHash = first.hash;
  const invoicesBefore = (await walletInvoices()).length;
  // 1. The reload button in Safari's address bar.
  let loadedAt = await reloadViaToolbar();
  j.toolbarReloaded = await waitNewDocument(loadedAt);
  await firstScreen({ invoice: Q.copyInvoice, grid: Q.bitcoin }, 20_000);
  shots.push(await shot("reload-after-toolbar-reload"));
  j.afterToolbar = {
    screen: (await exists(Q.copyInvoice))
      ? "invoice"
      : (await exists(Q.bitcoin))
        ? "method grid"
        : "other",
  };
  // The grid is fine (as on Android) if Bitcoin again gives back the same invoice.
  if (j.afterToolbar.screen === "method grid") {
    await calibrate().catch(() => undefined);
    const again = await lightningInvoice("reload");
    j.afterToolbar.hashAgain = again.hash;
    if (again.hash !== first.hash)
      problem(
        "reload",
        "reload button",
        "after Safari's reload button and Bitcoin again, the checkout minted a second invoice for the same order",
        shots.at(-1),
      );
  } else if (j.afterToolbar.screen !== "invoice")
    problem(
      "reload",
      "reload button",
      `after Safari's reload button the payer sees neither the invoice nor the method grid`,
      shots.at(-1),
    );
  j.afterToolbar.bolt11 = (await shownBolt11())?.slice(0, 30);
  // 2. Pull-to-refresh: a slow finger drag down from the top of the page.
  await calibrate().catch(() => undefined);
  await web.ev("(scrollTo(0, 0), true)");
  await sleep(400);
  loadedAt = await web.ev("window.__lab.loadedAt");
  const strip = await reachable();
  await phone.drag(
    { x: strip.width / 2, y: strip.top + 30 },
    { x: strip.width / 2, y: strip.top + 330 },
    { steps: 14, stepMs: 50, restMs: 400 },
  );
  j.pullToRefreshReloaded = await waitNewDocument(loadedAt, 10_000);
  if ((await firstScreen({ invoice: Q.copyInvoice, grid: Q.bitcoin }, 20_000)) === "grid") {
    await calibrate().catch(() => undefined);
    const again = await lightningInvoice("reload");
    if (again.hash !== first.hash)
      problem(
        "reload",
        "pull to refresh",
        "after pull-to-refresh and Bitcoin again, the checkout minted a second invoice for the same order",
      );
  }
  shots.push(await shot("reload-after-pull-to-refresh"));
  j.afterPull = { bolt11: (await shownBolt11())?.slice(0, 30) };
  if (!j.pullToRefreshReloaded)
    problem(
      "reload",
      "pull to refresh",
      "a finger pull down from the top of the checkout did not reload it",
      shots.at(-1),
      { severity: "info" },
    );
  const now = await shownBolt11();
  if (now && first.bolt11 && now.toLowerCase() !== first.bolt11.toLowerCase())
    problem(
      "reload",
      "reload",
      "after the reloads the invoice on screen is not the one minted first",
      shots.at(-1),
    );
  // Informational: the testkit wallet's invoices carry no order reference, so
  // with two runs on one demo this counts the other run's invoices too. The
  // per-order check is the payment hash Bitcoin gives back above.
  j.walletInvoicesAdded = (await walletInvoices()).length - invoicesBefore;
  // 3. Right after paying: settle, and reload before the page has polled.
  await control("/__testkit/settle", { payment_hash: first.hash });
  loadedAt = await reloadViaToolbar();
  await waitNewDocument(loadedAt);
  const seen = [];
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    const s = await web
      .ev(
        "({ invoice: !!window.__lab.find(" +
          JSON.stringify(Q.copyInvoice) +
          "), grid: !!window.__lab.find(" +
          JSON.stringify(Q.bitcoin) +
          "), deposit: /to this address/.test(document.body.innerText), paid: !!window.__lab.find(" +
          JSON.stringify(Q.paid) +
          ") })",
      )
      .catch(() => undefined);
    if (s) seen.push({ ...s, at: Date.now() });
    if (s?.grid && !j.gridShot)
      j.gridShot = await shot("reload-after-paying-grid", { settleMs: 0 });
    if (s?.paid) break;
    await sleep(250);
  }
  const gridSamples = seen.filter((s) => s.grid);
  j.gridVisibleMs = gridSamples.length ? gridSamples.at(-1).at - gridSamples[0].at + 250 : 0;
  j.paidAfterReloadMs = seen.find((s) => s.paid)
    ? seen.find((s) => s.paid).at - seen[0].at
    : undefined;
  shots.push(await shot("reload-after-paying"));
  j.afterPaying = {
    sawInvoice: seen.some((s) => s.invoice),
    sawGrid: seen.some((s) => s.grid),
    sawDeposit: seen.some((s) => s.deposit),
    paid: seen.some((s) => s.paid),
    samples: seen.length,
  };
  if (!j.afterPaying.paid)
    problem(
      "reload",
      "after paying",
      "reloading right after paying did not reach the receipt within 30 s",
      shots.at(-1),
    );
  if (j.afterPaying.sawDeposit || j.afterPaying.sawGrid)
    problem(
      "reload",
      "after paying",
      `reloading right after paying showed ${j.afterPaying.sawGrid ? `the payment method grid for about ${(j.gridVisibleMs / 1000).toFixed(1)} s` : "a deposit address"} before the receipt`,
      j.gridShot ?? shots.at(-1),
    );
});

// (f) The app switch: Photos in front while the payer pays, Safari back later.
async function walletTrip(name, j, awayMs) {
  j.orderUrl = await orderOneButton(name);
  const invoice = await lightningInvoice(name);
  j.paymentHash = invoice.hash;
  await sleep(1500);
  await web.ev("(window.__lab.events.length = 0, window.__lab.ticks = [], true)");
  const loadedAt = await web.ev("window.__lab.loadedAt");
  await web.ev(
    "(window.__lab.tick = setInterval(() => window.__lab.ticks.push(Date.now()), 1000), true)",
  );
  // Detached while away: an Inspector client may keep the page awake.
  await web.disconnect();
  await phone.activate("com.apple.mobileslideshow");
  const leftAt = Date.now();
  j.shots = [await shot(`${name}-photos`)];
  await sleep(3000);
  await control("/__testkit/settle", { payment_hash: invoice.hash });
  const settledAt = Date.now();
  log(`settled 3 s after leaving; Safari stays behind Photos until ${awayMs / 1000} s`);
  await sleep(Math.max(0, awayMs - (Date.now() - leftAt)));
  await phone.activate(SAFARI);
  const backAt = Date.now();
  j.shots.push(await shot(`${name}-return-0s`, { settleMs: 200 }));
  await web.connect();
  await web.select(20_000);
  const kept = await web.ev("window.__lab?.loadedAt").catch(() => undefined);
  if (kept !== loadedAt) await probe();
  const paid = await waitForValue(() => web.ev("window.__lab?.paidAt"), 30_000, 100);
  const lab = await web
    .ev(
      "({ events: window.__lab.events, paidAt: window.__lab.paidAt, loadedAt: window.__lab.loadedAt, ticks: window.__lab.ticks ?? [], now: Date.now() })",
    )
    .catch(() => undefined);
  j.lab = { ...lab, ticks: undefined };
  j.shots.push(await shot(`${name}-return-after`));
  const skew = lab ? lab.now - Date.now() : 0;
  const visible = lab?.events.findLast((e) => e.type === "visibility:visible");
  const ticksAway = (lab?.ticks ?? []).filter(
    (t) => t - skew > leftAt + 2000 && t - skew < backAt,
  ).length;
  j.timing = {
    awayS: Math.round((backAt - leftAt) / 1000),
    settledAfterLeavingS: Math.round((settledAt - leftAt) / 1000),
    keptDocument: kept === loadedAt,
    restoredFromBfcache: lab?.events.some((e) => e.type === "pageshow:bfcache") ?? false,
    pageSawHidden: lab?.events.some((e) => e.type === "visibility:hidden") ?? false,
    timerTicksWhileAway: ticksAway,
    paidOnScreenAfterReturnMs: paid === undefined ? undefined : Math.round(paid - skew - backAt),
    paidWhileHidden: paid !== undefined && visible !== undefined && paid < visible.at,
  };
  log(
    `${name} timing`,
    JSON.stringify(j.timing),
    "lifecycle:",
    JSON.stringify(
      lab?.events.map((e) => `${e.type}@${Math.round((e.at - skew - leftAt) / 100) / 10}s`),
    ),
  );
  if (paid === undefined)
    problem(
      name,
      "return",
      `back from the wallet app, the page still waits 30 s after the return; the invoice was paid ${Math.round((backAt - settledAt) / 1000)} s before it`,
      j.shots.at(-1),
    );
  else if (!j.timing.paidWhileHidden && j.timing.paidOnScreenAfterReturnMs > 3000)
    problem(
      name,
      "return",
      `back from the wallet app, the paid screen took ${(j.timing.paidOnScreenAfterReturnMs / 1000).toFixed(1)} s to appear`,
      j.shots.at(-1),
    );
  if (paid !== undefined) await measure("receipt", name);
}
await journeyRun("wallet", (j) => walletTrip("wallet", j, IN_WALLET_MS));
await journeyRun("wallet-long", (j) => walletTrip("wallet-long", j, LONG_WALLET_MS));

// (g) Layout: Safari's bar collapsing while scrolling, what sits under it, landscape.
await journeyRun("layout", async (j) => {
  j.orderUrl = await orderOneButton("layout");
  const shots = [];
  j.shots = shots;
  await lightningInvoice("layout");
  await sleep(800);
  await calibrate();
  j.barsAtTop = await phone.safariBars();
  const g0 = await geometry();
  const strip = await reachable();
  // Scroll down by finger: Safari minimizes its bar.
  for (let i = 0; i < 3; i += 1) {
    await phone.drag(
      { x: strip.width * 0.9, y: strip.bottom - 40 },
      { x: strip.width * 0.9, y: strip.top + 60 },
    );
    await sleep(400);
  }
  const g1 = await geometry();
  j.barsScrolled = await phone.safariBars();
  shots.push(await shot("layout-scrolled-bar-minimized"));
  j.viewport = {
    atTop: { innerHeight: g0.innerHeight, vvHeight: g0.vvHeight },
    scrolled: { innerHeight: g1.innerHeight, vvHeight: g1.vvHeight, scrollY: g1.scrollY },
  };
  // At the bottom of the page: is anything the payer needs under Safari's bar?
  const under = async () => {
    const bars = await phone.safariBars();
    const g = await geometry();
    const els = await web.ev("window.__lab.interactive()");
    const barTop = bars.capsuleTop;
    if (barTop === undefined) return { bars, hidden: [] };
    const hidden = els
      .filter((e) => {
        const top = toScreen(g, 0, e.top).y;
        const bottom = toScreen(g, 0, e.bottom).y;
        return bottom > barTop + 4 && top < barTop + 48;
      })
      .map((e) => e.name);
    return { bars, hidden };
  };
  j.underBarScrolled = await under();
  // A finger drag up: Safari shows its bar again.
  await phone.drag(
    { x: strip.width * 0.9, y: strip.top + 100 },
    { x: strip.width * 0.9, y: strip.top + 220 },
  );
  await sleep(600);
  j.underBarExpanded = await under();
  shots.push(await shot("layout-bar-expanded"));
  const g2 = await geometry();
  j.viewport.expanded = { innerHeight: g2.innerHeight, vvHeight: g2.vvHeight, scrollY: g2.scrollY };
  const maxScroll = await web.ev("document.documentElement.scrollHeight - innerHeight");
  j.maxScroll = maxScroll;
  if (j.underBarExpanded.hidden.length > 0 && g2.scrollY >= maxScroll - 2)
    problem(
      "layout",
      "Safari bar",
      `at the bottom of the page, under Safari's bar and out of reach: ${j.underBarExpanded.hidden.join(", ")}`,
      shots.at(-1),
    );
  if (!process.env.SKIP_ROTATE) {
    // Landscape.
    await phone.rotate("LANDSCAPE");
    state.orientation = "LANDSCAPE";
    await sleep(800);
    shots.push(await shot("layout-landscape"));
    j.landscape = await measure("invoice, landscape", "layout");
    await calibrate().catch(() => undefined);
    j.landscapeCopy = await find(Q.copyInvoice);
    await phone.rotate("PORTRAIT");
    state.orientation = "PORTRAIT";
  }
  j.lowPowerMode = "not offered by the simulator (no simctl switch, Settings > Battery is absent)";
});

// (h) The largest Dynamic Type size and dark appearance, set before Safari opens the shop.
await journeyRun("big-text-dark", async (j) => {
  simctl("ui", UDID, "appearance", "dark");
  system.appearance = "dark";
  simctl("ui", UDID, "content_size", "accessibility-extra-extra-extra-large");
  system.contentSize = "accessibility-extra-extra-extra-large";
  await sleep(1500);
  const shots = [];
  j.shots = shots;
  j.orderUrl = await orderOneButton("big-text-dark");
  j.settings = await web.ev(
    "({ prefersDark: matchMedia('(prefers-color-scheme: dark)').matches, bodyFont: getComputedStyle(document.body).fontSize, appleBody: (() => { const p = document.createElement('p'); p.style.font = '-apple-system-body'; document.body.append(p); const s = getComputedStyle(p).fontSize; p.remove(); return s; })() })",
  );
  shots.push(await shot("big-text-dark-grid"));
  await measure("method grid, largest text", "big-text-dark");
  await lightningInvoice("big-text-dark");
  shots.push(await shot("big-text-dark-invoice"));
  const m = await measure("invoice, largest text", "big-text-dark");
  if (m.cut.length > 0) j.cut = m.cut;
  await realTap(Q.switchMethod, "Switch payment method", { journey: "big-text-dark" });
  await startUsdtSolana("big-text-dark");
  shots.push(await shot("big-text-dark-quote"));
  await realTap(Q.cont, "Continue", { journey: "big-text-dark" });
  await waitShown(text("Pay [\\d.]+ USDT to this address"), 30_000, "the deposit screen");
  shots.push(await shot("big-text-dark-deposit"));
  await measure("deposit, largest text", "big-text-dark");
  j.lowContrast = await web.call(CONTRAST);
  if (j.lowContrast.length > 0)
    problem(
      "big-text-dark",
      "deposit",
      `text under 3:1 contrast with the phone in dark mode: ${j.lowContrast.slice(0, 6).join("; ")}`,
      shots.at(-1),
    );
});

report.finished = new Date().toISOString();
writeFileSync(path.join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
log(
  `report: ${path.relative(process.cwd(), OUT)}/report.json; ${report.problems.length} problem(s)`,
);
for (const p of report.problems)
  log(` - [${p.journey} / ${p.step}] ${p.what}${p.screenshot ? ` (${p.screenshot})` : ""}`);
await web.disconnect();
await phone.close();
process.exit(0);
