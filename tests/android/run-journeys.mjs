#!/usr/bin/env node
// Payer journeys on a real Chrome for Android (the emulator from start.sh),
// against the Buy a Button shop in testkit wallet mode.
//
// Playwright only OBSERVES here (locators, rects, requests, console). Every
// touch a payer makes goes through Android's own input pipeline: taps and
// long-presses via `input tap` / `input swipe`, finger drags via `input
// motionevent`, text via `input text` into the focused field with Gboard up,
// BACK/HOME via key events, rotation, font scale and dark mode via system
// settings. See README.md for how to run it.
//
//   node tests/android/run-journeys.mjs                 # every journey
//   JOURNEYS=lightning,wallet node tests/android/run-journeys.mjs
//
// Writes screenshots and report.json under
// tests/android/results/<time>-adb<port>-<tab>/.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _android as android, chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const ADB_PORT = Number(process.env.ADB_PORT ?? 15037);
const DEVICE_URL = process.env.DEVICE_URL ?? "http://localhost:4173";
const CONTROL_URL = process.env.CONTROL_URL ?? `http://127.0.0.1:${process.env.DEMO_PORT ?? 4273}`;
const FRAMEWORK = process.env.FRAMEWORK ?? "React";
const IN_WALLET_MS = Number(process.env.IN_WALLET_MS ?? 60_000);
const ALL = [
  "lightning",
  "wallet",
  "wallet-late",
  "swap",
  "swap-paid",
  "big-text-dark",
  "back-reload",
  "phone",
];
const ONLY = (process.env.JOURNEYS ?? ALL.join(",")).split(",").map((s) => s.trim());
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT =
  process.env.OUT ??
  path.join(here, "results", `${stamp}-adb${ADB_PORT}-${FRAMEWORK.toLowerCase()}`);
mkdirSync(OUT, { recursive: true });

// A checksum-valid Solana address that is not the testkit deposit address.
const SOLANA_REFUND_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const MIN_TAP_CSS_PX = 44;

const report = { started: new Date().toISOString(), device: {}, journeys: {}, problems: [] };
let shotIndex = 0;
const t0 = Date.now();
const log = (...parts) =>
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...parts);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function problem(journey, step, what, shot, extra = {}) {
  report.problems.push({ journey, step, what, screenshot: shot, ...extra });
  log(`PROBLEM [${journey} / ${step}] ${what}${shot ? ` (${shot})` : ""}`);
}

// ------------------------------------------------------------------ device

const [device] = await android.devices({ port: ADB_PORT, omitDriverInstall: true });
if (device === undefined)
  throw new Error(
    `no device on the adb server at 127.0.0.1:${ADB_PORT}; run tests/android/start.sh`,
  );
const sh = async (command) => (await device.shell(command)).toString().replace(/\r/g, "").trim();

async function shot(name, { settleMs = 900 } = {}) {
  // The emulator's screen trails the DOM by a few hundred ms (software GL):
  // a screencap right after a DOM change can show the previous frame.
  await sleep(settleMs);
  shotIndex += 1;
  const file = `${String(shotIndex).padStart(2, "0")}-${name}.png`;
  await device.screenshot({ path: path.join(OUT, file) });
  return file;
}

const key = (code) => sh(`input keyevent ${code}`);

async function keyboardShown() {
  const out = await sh("dumpsys input_method | grep -m1 -E 'mInputShown|isInputViewShown'");
  return /=true/.test(out);
}

/** Every node of the current window hierarchy (uiautomator sees Chrome's web content too). */
async function uiNodes() {
  const xml = await sh(
    "uiautomator dump --windows /sdcard/lab-ui.xml >/dev/null 2>&1; cat /sdcard/lab-ui.xml",
  );
  const nodes = [];
  for (const match of xml.matchAll(/<node [^>]*>/g)) {
    const attr = (name) => match[0].match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? "";
    const b = attr("bounds").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (b === null) continue;
    nodes.push({
      text: attr("text"),
      desc: attr("content-desc"),
      id: attr("resource-id"),
      pkg: attr("package"),
      x1: +b[1],
      y1: +b[2],
      x2: +b[3],
      y2: +b[4],
    });
  }
  return nodes;
}

async function tapNode(predicate, label) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const node = (await uiNodes()).find(predicate);
    if (node !== undefined) {
      await sh(
        `input tap ${Math.round((node.x1 + node.x2) / 2)} ${Math.round((node.y1 + node.y2) / 2)}`,
      );
      return node;
    }
    await sleep(700);
  }
  throw new Error(`no ${label} on screen`);
}

// ------------------------------------------------------------- page probes

/** Installed in every document: the last real pointerdown, page lifecycle, paid moment. */
const PROBE = () => {
  if (window.__lab) return;
  const lab = {
    events: [],
    tap: undefined,
    expect: undefined,
    paidAt: undefined,
    loadedAt: Date.now(),
  };
  window.__lab = lab;
  const note = (type) => lab.events.push({ type, at: Date.now(), state: document.visibilityState });
  addEventListener(
    "pointerdown",
    (event) => {
      const path = event.composedPath();
      lab.tap = {
        clientX: event.clientX,
        clientY: event.clientY,
        screenX: event.screenX,
        screenY: event.screenY,
        vvTop: visualViewport.offsetTop,
        vvLeft: visualViewport.offsetLeft,
        scale: visualViewport.scale,
        hit: lab.expect !== undefined && path.some((node) => node.__labMark === lab.expect),
        expectRect: lab.expectEl?.getBoundingClientRect().toJSON(),
        scrollY,
        target: (path[0]?.outerHTML ?? "").slice(0, 120),
        at: Date.now(),
      };
    },
    true,
  );
  lab.shifts = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.hadRecentInput || entry.value < 0.001) continue;
        lab.shifts.push({
          at: Date.now(),
          value: Number(entry.value.toFixed(4)),
          sources: (entry.sources ?? []).slice(0, 3).map((source) => {
            const n = source.node;
            const text = (n?.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 50);
            return `${n?.nodeName ?? "?"} "${text}" ${Math.round(source.previousRect.top)}->${Math.round(source.currentRect.top)}`;
          }),
        });
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}
  document.addEventListener("visibilitychange", () =>
    note(`visibility:${document.visibilityState}`),
  );
  document.addEventListener("freeze", () => note("freeze"));
  document.addEventListener("resume", () => note("resume"));
  addEventListener("pagehide", () => note("pagehide"));
  addEventListener("pageshow", (event) => note(event.persisted ? "pageshow:bfcache" : "pageshow"));
  const paid = () =>
    [...document.querySelectorAll(".or-shop-status-title")].some(
      (el) => el.textContent.trim() === "Payment received",
    );
  const check = () => {
    if (lab.paidAt === undefined && paid()) {
      lab.paidAt = Date.now();
      note("paid-on-screen");
    }
  };
  const start = () => {
    check();
    new MutationObserver(check).observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
};

function watchNetwork(page, journey, calls) {
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/openreceive/") && !url.pathname.startsWith("/api/")) return;
    calls.push({ method: request.method(), path: url.pathname, at: Date.now(), request });
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/@") || url.pathname.includes("/node_modules/")) return;
    const reason = request.failure()?.errorText ?? "";
    const entry = calls.find((call) => call.request === request);
    if (entry) entry.failed = reason;
    if (url.pathname.startsWith("/openreceive/") || url.pathname.startsWith("/api/")) {
      problem(
        journey(),
        "network",
        `${request.method()} ${url.pathname} failed in the browser: ${reason}`,
      );
    }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    const entry = calls.find((call) => call.request === response.request());
    if (entry) entry.status = response.status();
    if (response.status() === 404) {
      report.notFound ??= [];
      report.notFound.push({ journey: journey(), url: url.pathname });
    }
    if (response.status() >= 500)
      problem(
        journey(),
        "network",
        `${response.request().method()} ${url.pathname} answered ${response.status()}`,
      );
  });
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      const text = message.text();
      if (/\[vite\]|Download the React DevTools/.test(text)) return;
      if (/Failed to load resource: .*404/.test(text)) return; // listed under notFound with its URL
      report.console ??= [];
      report.console.push({ journey: journey(), type: message.type(), text: text.slice(0, 400) });
      if (message.type() === "error")
        problem(journey(), "console", `console error: ${text.slice(0, 200)}`);
    }
  });
  page.on("pageerror", (error) =>
    problem(journey(), "pageerror", `uncaught: ${String(error).slice(0, 200)}`),
  );
}

// ------------------------------------------------------------- real taps

/** Device pixels of the layout viewport's (0,0), kept per orientation. */
const origin = { x: 0, bottom: undefined };

async function geometry(page) {
  return page.evaluate(() => ({
    dpr: devicePixelRatio,
    innerWidth,
    innerHeight,
    vvTop: visualViewport.offsetTop,
    vvLeft: visualViewport.offsetLeft,
    vvHeight: visualViewport.height,
    vvWidth: visualViewport.width,
    scale: visualViewport.scale,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

function toDevice(g, cx, cy) {
  const top = origin.bottom - g.innerHeight * g.dpr;
  return {
    x: Math.round(origin.x + (cx - g.vvLeft) * g.scale * g.dpr),
    y: Math.round(top + (cy - g.vvTop) * g.scale * g.dpr),
  };
}

function learnOrigin(g, deviceX, deviceY, tap) {
  origin.x = deviceX - (tap.clientX - tap.vvLeft) * tap.scale * g.dpr;
  const top = deviceY - (tap.clientY - tap.vvTop) * tap.scale * g.dpr;
  origin.bottom = top + g.innerHeight * g.dpr;
}

/**
 * Tap a harmless element (the shop's eyebrow line) once and learn where the
 * web content sits on screen from the pointerdown Chrome reports back.
 */
async function calibrate(page) {
  const target = page.locator(".or-shop-head p, .or-shop-head").first();
  await target.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await sleep(300);
  const g = await geometry(page);
  const box = await target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 };
  });
  const size = (await sh("wm size")).match(/(\d+)x(\d+)\s*$/);
  const [w, h] = rotation % 2 === 0 ? [+size[1], +size[2]] : [+size[2], +size[1]];
  if (origin.bottom === undefined || origin.rotation !== rotation) {
    // First guess: content fills the screen down to a gesture bar.
    origin.x = 0;
    origin.bottom = h - Math.round(24 * g.dpr);
  }
  origin.rotation = rotation;
  await page.evaluate(() => {
    window.__lab.tap = undefined;
  });
  const p = toDevice(g, box.x, box.y);
  await sh(`input tap ${Math.min(Math.max(p.x, 1), w - 1)} ${Math.min(Math.max(p.y, 1), h - 1)}`);
  const tap = await waitForValue(() => page.evaluate(() => window.__lab.tap), 3000);
  if (tap === undefined) throw new Error("calibration tap never reached the page");
  learnOrigin(g, Math.min(Math.max(p.x, 1), w - 1), Math.min(Math.max(p.y, 1), h - 1), tap);
  log(
    `calibrated: rotation ${rotation}, content top ${Math.round(origin.bottom - g.innerHeight * g.dpr)} px, bottom ${Math.round(origin.bottom)} px`,
  );
}

async function waitForValue(read, timeoutMs, everyMs = 150) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > until) return undefined;
    await sleep(everyMs);
  }
}

/**
 * A finger drag with no fling: down, a few moves, a rest, up. `input swipe`
 * releases at speed and the page keeps scrolling after the measurement.
 */
async function drag(from, to, steps = 6) {
  const moves = [];
  for (let i = 1; i <= steps; i += 1) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
    moves.push(`input motionevent MOVE ${x} ${y}`);
  }
  await sh(
    `input motionevent DOWN ${from.x} ${from.y}; ${moves.join("; ")}; sleep 0.3; input motionevent UP ${to.x} ${to.y}`,
  );
}

/** Wait until the element stops moving (scroll settling, layout shifts). */
async function settle(locator) {
  let last = "";
  for (let i = 0; i < 20; i += 1) {
    const now = await locator
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return `${Math.round(r.top)},${Math.round(r.left)},${Math.round(r.height)},${Math.round(visualViewport.offsetTop)},${innerHeight}`;
      })
      .catch(() => "");
    if (now === last) return;
    last = now;
    await sleep(200);
  }
}

/** Bring an element into the visual viewport with real finger swipes, as a payer scrolls. */
async function swipeIntoView(page, locator) {
  for (let i = 0; i < 12; i += 1) {
    const g = await geometry(page);
    const r = await locator.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom };
    });
    const top = r.top - g.vvTop;
    const bottom = r.bottom - g.vvTop;
    const margin = 24;
    if (top >= margin && bottom <= g.vvHeight - margin) return;
    const deltaCss = top < margin ? top - g.vvHeight / 3 : bottom - (g.vvHeight * 2) / 3;
    const step = Math.max(-g.vvHeight * 0.6, Math.min(g.vvHeight * 0.6, deltaCss));
    const midY = g.vvHeight / 2;
    const from = toDevice(g, g.innerWidth * 0.85, g.vvTop + midY + step / 2);
    const to = toDevice(g, g.innerWidth * 0.85, g.vvTop + midY - step / 2);
    await drag(from, to);
    await sleep(250);
  }
  // A layout the finger cannot scroll to (e.g. inside a fixed box): fall back.
  await locator.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await sleep(300);
}

/**
 * Tap the middle of `locator` on the real touchscreen. The pointerdown the page
 * receives proves which element the finger hit; a miss is reported, never
 * papered over with a synthetic click.
 */
async function realTap(page, locator, label, { journey, swipe = true, pressMs } = {}) {
  await locator.first().waitFor({ state: "visible", timeout: 30_000 });
  const target = locator.first();
  if (swipe) await swipeIntoView(page, target);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await settle(target);
    const mark = `m${Date.now()}${Math.random()}`;
    const box = await target.evaluate((el, m) => {
      el.__labMark = m;
      window.__lab.expect = m;
      window.__lab.expectEl = el;
      window.__lab.tap = undefined;
      const r = el.getBoundingClientRect();
      return {
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        w: r.width,
        h: r.height,
        top: r.top,
        scrollY,
      };
    }, mark);
    const g = await geometry(page);
    const p = toDevice(g, box.x, box.y);
    await sh(
      pressMs ? `input swipe ${p.x} ${p.y} ${p.x} ${p.y} ${pressMs}` : `input tap ${p.x} ${p.y}`,
    );
    const tap = await waitForValue(() => page.evaluate(() => window.__lab?.tap), 2500);
    if (tap === undefined) {
      // The tap may have navigated the document before we could read it back.
      log(`tap "${label}" at ${p.x},${p.y}: no pointerdown read back (navigated?)`);
      return { x: p.x, y: p.y, box };
    }
    learnOrigin(g, p.x, p.y, tap);
    if (tap.hit) return { x: p.x, y: p.y, box, hit: true };
    const moved = tap.expectRect ? Math.round(tap.expectRect.top - box.top) : undefined;
    const scrolled = Math.round(tap.scrollY - box.scrollY);
    const file = await shot(`mistap-${label.replace(/\W+/g, "-")}`);
    const why =
      moved === undefined
        ? "the element was gone"
        : moved === 0
          ? "the element had not moved: the harness aimed wrong"
          : scrolled !== 0
            ? `the page scrolled ${scrolled} px between aiming and the touch`
            : `the element moved ${moved} px with no scroll (a layout shift) between aiming and the touch`;
    report.mistaps ??= [];
    report.mistaps.push({ journey, label, attempt, landedOn: tap.target, why, screenshot: file });
    log(`mistap "${label}" (attempt ${attempt}): landed on ${tap.target.slice(0, 80)}; ${why}`);
    if (attempt === 2)
      problem(
        journey ?? "?",
        `tap ${label}`,
        `two taps aimed at "${label}" missed it: ${why}`,
        file,
      );
  }
  return { hit: false };
}

// ----------------------------------------------------------- page measures

/** What a phone exposes: overflow, small tap targets, truncated text, fixed boxes. */
async function measure(page, screen, journey) {
  const result = await page.evaluate((minTap) => {
    const roots = [document];
    const all = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        all.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    const width = document.documentElement.clientWidth;
    const visible = (el) => {
      const s = getComputedStyle(el);
      if (s.visibility === "hidden" || s.display === "none") return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const name = (el) =>
      (
        el.getAttribute("aria-label") ||
        el.textContent ||
        el.getAttribute("placeholder") ||
        el.localName
      )
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 40);
    const over = [];
    const small = [];
    const cut = [];
    const fixed = [];
    for (const el of all) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (r.right > width + 1 || r.left < -1) {
        if (!el.closest?.("[aria-hidden=true]"))
          over.push(
            `${el.localName}.${String(el.className).split(" ")[0]} ${Math.round(r.left)}..${Math.round(r.right)}`,
          );
      }
      const interactive = el.matches(
        "button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=radio], [role=tab], label[for]",
      );
      if (interactive && (r.height < minTap || r.width < minTap))
        small.push(`${name(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      if (
        el.children.length === 0 &&
        el.textContent.trim() &&
        s.textOverflow === "ellipsis" &&
        el.scrollWidth > el.clientWidth + 1
      )
        cut.push(`${name(el)} (${el.scrollWidth}>${el.clientWidth})`);
      if ((s.position === "fixed" || s.position === "sticky") && r.height > 0)
        fixed.push(
          `${s.position} ${el.localName}.${String(el.className).split(" ")[0]} ${Math.round(r.top)}..${Math.round(r.bottom)}`,
        );
    }
    // Clipped text that is not an ellipsis: overflow hidden on a single line.
    for (const el of all) {
      if (!visible(el)) continue;
      const s = getComputedStyle(el);
      if (
        s.overflowX === "hidden" &&
        s.whiteSpace === "nowrap" &&
        s.textOverflow !== "ellipsis" &&
        el.scrollWidth > el.clientWidth + 1 &&
        el.textContent.trim()
      )
        cut.push(`${name(el)} clipped (${el.scrollWidth}>${el.clientWidth})`);
    }
    return {
      width,
      scrollWidth: document.documentElement.scrollWidth,
      innerHeight,
      vvHeight: visualViewport.height,
      bodyFont: getComputedStyle(document.body).fontSize,
      over: [...new Set(over)].slice(0, 12),
      overCount: over.length,
      small: [...new Set(small)],
      cut: [...new Set(cut)],
      fixed: [...new Set(fixed)],
      roots: roots.length,
    };
  }, MIN_TAP_CSS_PX);
  report.journeys[journey].measures ??= {};
  report.journeys[journey].measures[screen] = result;
  if (result.scrollWidth > result.width + 1) {
    problem(
      journey,
      screen,
      `the page scrolls sideways: ${result.scrollWidth} px of content in a ${result.width} px screen (${result.over.slice(0, 4).join(", ")})`,
    );
  } else if (result.overCount > 0) {
    // No sideways scroll, so something clips it: the payer sees it cut off.
    problem(
      journey,
      screen,
      `${result.overCount} element(s) run past the ${result.width} px screen edge and are cut off (${result.over.slice(0, 4).join(", ")})`,
    );
  }
  return result;
}

async function textOf(page) {
  // biome-ignore lint/performance/useDomNodeTextContent: the rendered text, as the payer reads it
  return page.evaluate(() => document.body.innerText.replace(/\s+\n/g, "\n"));
}

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

async function minted(page, routePath, action) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => new URL(r.url()).pathname === routePath && r.request().method() === "POST",
      { timeout: 30_000 },
    ),
    action(),
  ]);
  const body = await response.json();
  return {
    status: response.status(),
    hash: findLast(body, "payment_hash"),
    bolt11: findLast(body, "bolt11") ?? findLast(body, "invoice"),
    depositAddress: findLast(body, "deposit_address"),
    providerOrderId: findLast(body, "provider_order_id"),
  };
}

// -------------------------------------------------------------- the shop

// Chrome is started the way a payer's Chrome runs: by an intent, with no
// debugger. Playwright attaches over Chrome's DevTools socket only while it
// looks, and DETACHES while the payer is in their wallet app: with a DevTools
// client attached, Chrome keeps a backgrounded tab "visible" and its timers at
// full speed (measured: 20 ticks of a 1 s interval in 20 s behind HOME, and
// no visibilitychange), which is not what a payer's phone does.
// `_android.launchBrowser()` stays attached for the whole run, so it is not used.
const CDP_PORT = Number(process.env.CDP_PORT ?? 15222);
const DEVTOOLS_SOCKET = "lab_devtools_remote";
let browser;
let context;
let page;
let current = "setup";
const calls = [];
const watched = new WeakSet();

async function startChrome() {
  await sh("am force-stop com.android.chrome");
  // A clean profile per run: no restored tabs from the last run.
  await sh("pm clear com.android.chrome >/dev/null");
  await sh("pm grant com.android.chrome android.permission.POST_NOTIFICATIONS");
  await sh(
    `echo '_ --disable-fre --no-default-browser-check --no-first-run --remote-debugging-socket-name=${DEVTOOLS_SOCKET}' > /data/local/tmp/chrome-command-line`,
  );
  await sh(
    `am start -a android.intent.action.VIEW -d '${DEVICE_URL}' com.android.chrome >/dev/null`,
  );
  await attach();
}

async function attach() {
  const until = Date.now() + 60_000;
  for (;;) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, { timeout: 5000 });
      break;
    } catch (error) {
      if (Date.now() > until)
        throw new Error(
          `no Chrome DevTools on 127.0.0.1:${CDP_PORT} (adb forward to ${DEVTOOLS_SOCKET}): ${error}`,
        );
      await sleep(1000);
    }
  }
  context = browser.contexts()[0];
  await context.addInitScript(PROBE);
  const host = new URL(DEVICE_URL).host;
  page = await waitForValue(
    async () => context.pages().find((p) => p.url().includes(host)),
    15_000,
  );
  page ??= context.pages().at(-1) ?? (await context.newPage());
  if (!watched.has(page)) {
    watched.add(page);
    watchNetwork(page, () => current, calls);
  }
  // Playwright emulates prefers-color-scheme: light (and reduced-motion:
  // no-preference) on every page it attaches to. Give the page the phone's own.
  await page
    .emulateMedia({ colorScheme: null, reducedMotion: null, forcedColors: null })
    .catch(() => undefined);
  await page.evaluate(PROBE).catch(() => undefined);
}

/** Let go of Chrome without closing it: what the payer's phone runs is Chrome alone. */
async function detach() {
  await browser?.close().catch(() => undefined);
  browser = undefined;
}

async function openShop() {
  await page.goto(DEVICE_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByText("Buy an OR button").first().waitFor({ timeout: 90_000 });
  await page.locator(".or-shop-head").first().waitFor();
  await page.evaluate(PROBE);
}

/** Shop → one Safety Orange → Checkout, all by touch. Returns the order URL. */
async function orderOneButton(journey) {
  await openShop();
  await calibrate(page);
  await realTap(page, page.getByRole("button", { name: "Add" }), "Add", { journey });
  await page
    .locator(".or-shop-footer")
    .filter({ hasText: "1 button" })
    .waitFor({ timeout: 15_000 });
  await realTap(page, page.getByRole("button", { name: "Checkout" }), "Checkout", { journey });
  await page.getByRole("heading", { name: "Pay this invoice" }).waitFor({ timeout: 60_000 });
  if (FRAMEWORK !== "React") {
    await realTap(
      page,
      page.locator(".or-shop-stage label", { hasText: FRAMEWORK }),
      `${FRAMEWORK} tab`,
      { journey },
    );
    await page.getByRole("radio", { name: FRAMEWORK, exact: true }).waitFor({ state: "attached" });
  }
  await page
    .getByRole("button", { name: /^Bitcoin/ })
    .first()
    .waitFor({ timeout: 60_000 });
  await page.evaluate(PROBE);
  return page.url();
}

async function lightningInvoice(journey) {
  const bitcoin = page.getByRole("button", { name: /^Bitcoin/ });
  const invoice = await minted(page, "/openreceive/checkouts", () =>
    realTap(page, bitcoin, "Bitcoin tile", { journey }),
  );
  await page
    .getByRole("button", { name: /copy invoice/i })
    .first()
    .waitFor({ timeout: 30_000 });
  return invoice;
}

const copyButton = () =>
  page
    .getByRole("button", { name: /copy invoice|copied/i })
    .filter({ visible: true })
    .first();
const paidTitle = () =>
  page.locator(".or-shop-status-title").filter({ hasText: /^Payment received$/ });

async function journeyRun(name, fn) {
  if (!ONLY.includes(name)) return;
  current = name;
  report.journeys[name] = { started: new Date().toISOString() };
  log(`=== ${name}`);
  const started = Date.now();
  try {
    if (!browser?.isConnected()) await startChrome();
    await fn(report.journeys[name]);
    report.journeys[name].ok = true;
  } catch (error) {
    report.journeys[name].ok = false;
    report.journeys[name].error = String(error?.stack ?? error).slice(0, 1500);
    const file = await shot(`${name}-error`).catch(() => undefined);
    problem(name, "harness", `journey stopped: ${String(error).slice(0, 300)}`, file);
  } finally {
    report.journeys[name].seconds = Math.round((Date.now() - started) / 1000);
    report.journeys[name].layoutShifts = await page
      .evaluate(() => window.__lab?.shifts ?? [])
      .catch(() => undefined);
    report.journeys[name].calls = calls
      .filter((call) => call.at >= started)
      .map(({ method, path: p, status, failed, at }) => ({
        method,
        path: p,
        status,
        failed,
        at: at - started,
      }));
    await resetSystem();
  }
}

let rotation = 0;
/** Rotate the display (0 portrait, 1 landscape), as turning the phone does with auto-rotate on. */
async function rotate(to) {
  await sh(`cmd window user-rotation lock ${to}`);
  rotation = to;
  await sleep(2500);
}

const system = { fontScale: "1.0", night: false };
/** Font size and dark theme as Settings sets them. Chrome restarts on either change. */
async function setSystem({ fontScale = "1.0", night = false }) {
  if (fontScale === system.fontScale && night === system.night) return false;
  await sh(`settings put system font_scale ${fontScale}; cmd uimode night ${night ? "yes" : "no"}`);
  system.fontScale = fontScale;
  system.night = night;
  await sleep(1500);
  return true;
}

async function resetSystem() {
  if (rotation !== 0) await rotate(0).catch(() => undefined);
  if (await setSystem({}).catch(() => false)) await detach();
}

// ------------------------------------------------------------- journeys

report.device = {
  model: device.model(),
  serial: device.serial(),
  android: await sh("getprop ro.build.version.release"),
  sdk: await sh("getprop ro.build.version.sdk"),
  chrome: (
    await sh("dumpsys package com.android.chrome 2>/dev/null | grep -m1 versionName")
  ).replace("versionName=", ""),
  screen: await sh("wm size"),
  density: await sh("wm density"),
  ime: await sh("settings get secure default_input_method"),
};
log("device", JSON.stringify(report.device));
await resetSystem();
await startChrome();

// (a) Lightning: invoice fits, Copy invoice really reaches Android's clipboard.
await journeyRun("lightning", async (j) => {
  j.orderUrl = await orderOneButton("lightning");
  await measure(page, "method grid", "lightning");
  j.shots = [await shot("lightning-grid")];
  const invoice = await lightningInvoice("lightning");
  j.paymentHash = invoice.hash;
  await sleep(800);
  const m = await measure(page, "invoice", "lightning");
  j.shots.push(await shot("lightning-invoice"));
  // QR and amount on screen without scrolling sideways.
  const qr = await page.evaluate(() => {
    // The QR: a square SVG/canvas/img of real size and many modules.
    const find = (root) => {
      for (const el of root.querySelectorAll("canvas, svg, img")) {
        const r = el.getBoundingClientRect();
        const square = r.width > 40 && Math.abs(r.width - r.height) < 4;
        const dense = el.localName !== "svg" || el.innerHTML.length > 600;
        if (square && dense)
          return {
            w: r.width,
            h: r.height,
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
          };
      }
      for (const el of root.querySelectorAll("*"))
        if (el.shadowRoot) {
          const f = find(el.shadowRoot);
          if (f) return f;
        }
      return undefined;
    };
    return find(document);
  });
  j.qr = qr;
  if (qr === undefined) {
    j.qrCandidates = await page.evaluate(() =>
      [...document.querySelectorAll("svg, canvas, img")]
        .map((el) => {
          const r = el.getBoundingClientRect();
          return `${el.localName} ${Math.round(r.width)}x${Math.round(r.height)} html=${el.innerHTML.length}`;
        })
        .filter((d) => !/ 0x0 /.test(d))
        .slice(0, 20),
    );
    problem("lightning", "invoice", "no QR code found on the invoice screen");
  } else {
    if (qr.right > m.width + 1 || qr.left < -1)
      problem(
        "lightning",
        "invoice",
        `the QR is cut off at the side: ${Math.round(qr.left)}..${Math.round(qr.right)} of ${m.width}px`,
        j.shots.at(-1),
      );
    if (qr.w < 160)
      problem(
        "lightning",
        "invoice",
        `the QR is ${Math.round(qr.w)} CSS px (${Math.round(qr.w * 3)} device px, about ${((qr.w / 160) * 2.54).toFixed(1)} cm) wide on a ${m.width} px phone; another phone has to scan it from a small square`,
        j.shots.at(-1),
        { severity: "polish" },
      );
  }
  const amountVisible = await page
    .getByText(/10,000 sats/)
    .first()
    .isVisible()
    .catch(() => false);
  if (!amountVisible)
    problem(
      "lightning",
      "invoice",
      "the amount (10,000 sats) is not visible on the invoice screen",
      j.shots.at(-1),
    );
  // Does the invoice screen hold still? Watch Copy invoice for a few seconds.
  const copyTops = [];
  for (let i = 0; i < 8; i += 1) {
    copyTops.push(
      await copyButton().evaluate((el) => ({
        top: Math.round(el.getBoundingClientRect().top + scrollY),
        text: el
          .closest("[class]")
          ?.parentElement?.textContent?.match(/expires in\s*([\d:]+)/i)?.[1],
      })),
    );
    await sleep(400);
  }
  j.copyTops = copyTops;
  const tops = [...new Set(copyTops.map((c) => c.top))];
  if (tops.length > 1) {
    j.shots.push(await shot("lightning-invoice-after-shift"));
    problem(
      "lightning",
      "invoice",
      `Copy invoice jumps while the payer reaches for it: page y ${tops.join(" -> ")} within 3 s of the invoice appearing (countdown ${copyTops
        .map((c) => c.text)
        .filter(Boolean)
        .join(", ")})`,
      j.shots.at(-1),
    );
  }
  // The layout-shift log catches a jump that happened before the loop above.
  const jumps = await page.evaluate(() =>
    (window.__lab?.shifts ?? []).filter((shift) =>
      shift.sources.some((source) => /Copy invoice/.test(source)),
    ),
  );
  j.copyInvoiceShifts = jumps;
  if (jumps.length > 0 && tops.length <= 1) {
    problem(
      "lightning",
      "invoice",
      `Copy invoice jumped while the invoice screen settled (layout shift ${jumps.map((jump) => jump.value).join(", ")}: ${jumps[0].sources.join("; ")}; rects in device px)`,
      j.shots.at(-1),
    );
  }
  // Copy invoice by touch.
  const copy = copyButton();
  const copyBox = await copy.boundingBox();
  j.copyButton = copyBox;
  if (copyBox && copyBox.height < MIN_TAP_CSS_PX)
    problem(
      "lightning",
      "invoice",
      `Copy invoice is ${Math.round(copyBox.height)} CSS px tall (Android asks for 48 dp, Apple 44 pt)`,
      j.shots.at(-1),
      { severity: "polish" },
    );
  await realTap(page, copy, "Copy invoice", { journey: "lightning" });
  const copied = await waitForValue(
    async () =>
      (await page
        .getByText(/copied/i)
        .filter({ visible: true })
        .count()) > 0
        ? true
        : undefined,
    5000,
  );
  await sleep(400);
  j.shots.push(await shot("lightning-copied"));
  if (!copied)
    problem(
      "lightning",
      "copy",
      'tapping Copy invoice showed no "Copied" feedback',
      j.shots.at(-1),
    );
  // Paste it back through Android: a textarea of our own, long-press, Paste.
  await page.evaluate(() => {
    const area = document.createElement("textarea");
    area.id = "lab-paste";
    area.setAttribute(
      "style",
      "position:fixed;left:8px;right:8px;top:25%;height:96px;z-index:2147483647;font-size:16px;background:#ffe;border:2px solid #c00",
    );
    document.body.append(area);
  });
  const area = page.locator("#lab-paste");
  await realTap(page, area, "paste box", { journey: "lightning", swipe: false });
  await waitForValue(() => keyboardShown(), 4000);
  await sleep(800);
  await realTap(page, area, "paste box (long press)", {
    journey: "lightning",
    swipe: false,
    pressMs: 1100,
  });
  j.shots.push(await shot("lightning-paste-menu", { settleMs: 600 }));
  let how = "long-press Paste";
  try {
    await tapNode(
      (n) => /^paste$/i.test(n.text) || /^paste$/i.test(n.desc),
      "Paste in the long-press menu",
    );
  } catch {
    how = "KEYCODE_PASTE";
    const focused = await page.evaluate(() => document.activeElement?.id);
    if (focused !== "lab-paste")
      await realTap(page, area, "paste box", { journey: "lightning", swipe: false });
    await sh("input keyevent 279");
  }
  const pasted = await waitForValue(() => area.inputValue().then((v) => v || undefined), 4000);
  j.clipboard = {
    how,
    pasted: pasted?.slice(0, 40),
    matches: pasted?.trim().toLowerCase() === invoice.bolt11?.toLowerCase(),
  };
  j.shots.push(await shot("lightning-pasted"));
  if (!j.clipboard.matches)
    problem(
      "lightning",
      "copy",
      `Android's clipboard did not hold the BOLT11 after Copy invoice (pasted via ${how}: ${JSON.stringify(pasted?.slice(0, 60))})`,
      j.shots.at(-1),
    );
  await area.evaluate((el) => el.remove());
  if (await keyboardShown()) await key("KEYCODE_BACK");
  await sleep(500);
});

// (b) The wallet app switch: HOME, pay in the "wallet", come back a minute later.
// "wallet": the payer pays at once and lingers in the wallet app; "wallet-late":
// they pay just before coming back, so the page must catch up after the return.
async function walletTrip(name, j, settleAfterMs) {
  j.orderUrl = await orderOneButton(name);
  const invoice = await lightningInvoice(name);
  j.paymentHash = invoice.hash;
  await sleep(1500);
  await page.evaluate(() => {
    window.__lab.events.length = 0;
  });
  // Detached while away: the page's own requests are not seen here; the in-page
  // probe records the lifecycle (visibility, freeze/resume) and the paid moment.
  await detach();
  await key("KEYCODE_HOME");
  const leftAt = Date.now();
  j.shots = [await shot(`${name}-home-screen`)];
  await sleep(Math.max(0, settleAfterMs - (Date.now() - leftAt)));
  await control("/__testkit/settle", { payment_hash: invoice.hash });
  const settledAt = Date.now();
  log(
    `settled ${settleAfterMs / 1000}s after leaving; Chrome stays in the background until ${IN_WALLET_MS / 1000}s`,
  );
  await sleep(Math.max(0, IN_WALLET_MS - (Date.now() - leftAt)));
  // Back the way a payer comes back: Chrome's launcher icon (resumes the task),
  // or RETURN_VIA=recents for the overview screen.
  if ((process.env.RETURN_VIA ?? "launcher") === "recents") {
    await key("KEYCODE_APP_SWITCH");
    await sleep(1200);
    j.shots.push(await shot(`${name}-recents`, { settleMs: 300 }));
    await sh("input tap 540 1170");
  } else {
    await sh("monkey -p com.android.chrome -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1");
  }
  const backAt = Date.now();
  j.shots.push(await shot(`${name}-return-0s`, { settleMs: 300 }));
  await attach();
  const paid = await waitForValue(() => page.evaluate(() => window.__lab?.paidAt), 30_000, 100);
  const lab = await page
    .evaluate(() => ({
      events: window.__lab.events,
      paidAt: window.__lab.paidAt,
      loadedAt: window.__lab.loadedAt,
      now: Date.now(),
    }))
    .catch(() => undefined);
  j.lab = lab;
  j.shots.push(await shot(`${name}-return-after`));
  const hidden = lab?.events.find((e) => e.type === "visibility:hidden");
  const visible = lab?.events.findLast((e) => e.type === "visibility:visible");
  // Device clock: read every moment relative to the page's own clock.
  const skew = lab ? lab.now - Date.now() : 0;
  j.timing = {
    hiddenForS: Math.round((backAt - leftAt) / 1000),
    settledAfterLeavingS: Math.round((settledAt - leftAt) / 1000),
    pageSawHidden: hidden !== undefined,
    paidOnScreenAfterLeavingS:
      paid === undefined ? undefined : Math.round((paid - skew - leftAt) / 100) / 10,
    paidAfterVisibleMs: paid !== undefined && visible !== undefined ? paid - visible.at : undefined,
    paidWhileHidden: paid !== undefined && visible !== undefined && paid < visible.at,
    reloaded: lab !== undefined && lab.loadedAt - skew > leftAt,
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
  else if (!j.timing.paidWhileHidden && j.timing.paidAfterVisibleMs > 3000)
    problem(
      name,
      "return",
      `back from the wallet app, the paid screen took ${(j.timing.paidAfterVisibleMs / 1000).toFixed(1)} s to appear`,
      j.shots.at(-1),
    );
  if (paid !== undefined) await measure(page, "receipt", name);
}
await journeyRun("wallet", (j) => walletTrip("wallet", j, 3_000));
await journeyRun("wallet-late", (j) =>
  walletTrip("wallet-late", j, Math.max(0, IN_WALLET_MS - 3_000)),
);

// (c) Swap with the keyboard up: refund address, rotation, font scale, dark mode.
await journeyRun("swap", async (j) => {
  j.orderUrl = await orderOneButton("swap");
  const shots = [];
  j.shots = shots;
  await realTap(page, page.getByRole("button", { name: /^USDT/ }), "USDT tile", {
    journey: "swap",
  });
  // Two network panels exist (a narrow and a wide layout); the payer sees one.
  const group = page
    .getByRole("group", { name: /Choose USDT network/ })
    .filter({ visible: true })
    .first();
  await group.waitFor({ timeout: 15_000 });
  await realTap(page, group.getByRole("button", { name: "Solana" }), "Solana network", {
    journey: "swap",
  });
  await page
    .getByText(/≈ [\d.]+ USDT/)
    .first()
    .waitFor({ timeout: 15_000 });
  shots.push(await shot("swap-quote"));
  await measure(page, "swap quote", "swap");
  const swap = await minted(page, "/openreceive/swaps", () =>
    realTap(page, page.getByRole("button", { name: "Continue" }), "Continue", { journey: "swap" }),
  );
  j.swap = swap;
  await page
    .getByText(/Pay [\d.]+ USDT to this address/)
    .first()
    .waitFor({ timeout: 30_000 });
  await sleep(800);
  shots.push(await shot("swap-deposit"));
  await measure(page, "deposit", "swap");
  // One amount: the order's own $5.00 must not sit beside the deposit amount.
  const visibleTotals = await page.evaluate(() => {
    const hits = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!/\$\s?5\.00/.test(n.textContent)) continue;
      const el = n.parentElement;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none")
        hits.push(
          `${el.localName}.${String(el.className).split(" ")[0]} "${n.textContent.trim().slice(0, 40)}" at y=${Math.round(r.top)}`,
        );
    }
    return hits;
  });
  j.totalsOnDeposit = visibleTotals;
  if (visibleTotals.length > 0)
    problem(
      "swap",
      "deposit",
      `the order total ($5.00) is on screen beside the USDT deposit amount: ${visibleTotals.join("; ")}`,
      shots.at(-1),
    );
  // The provider wants a refund address (the deposit came in but cannot convert).
  await control("/__testkit/swap-step", {
    provider_order_id: swap.providerOrderId,
    state: "refund_required",
  });
  await page.getByText("Refund needed").first().waitFor({ timeout: 30_000 });
  await sleep(500);
  shots.push(await shot("swap-refund-needed"));
  await measure(page, "refund form", "swap");
  const input = page.getByPlaceholder(/refund address/i).first();
  await realTap(page, input, "refund address field", { journey: "swap" });
  const kb = await waitForValue(() => keyboardShown(), 5000);
  j.keyboardShown = Boolean(kb);
  if (!kb)
    problem(
      "swap",
      "refund address",
      "tapping the refund address field did not bring up the on-screen keyboard",
    );
  await sh(`input text ${SOLANA_REFUND_ADDRESS}`);
  await sleep(1200);
  const typed = await input.inputValue();
  j.typed = typed;
  shots.push(await shot("swap-keyboard-up"));
  if (typed !== SOLANA_REFUND_ADDRESS)
    problem(
      "swap",
      "refund address",
      `typing with the keyboard produced ${JSON.stringify(typed)}, not the address`,
      shots.at(-1),
    );
  const review = page.getByRole("button", { name: "Review refund address" }).first();
  const reach = async (label) => {
    const g = await geometry(page);
    const r = await review.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, height: b.height };
    });
    const top = r.top - g.vvTop;
    const bottom = r.bottom - g.vvTop;
    const inView = top >= 0 && bottom <= g.vvHeight;
    return {
      label,
      inView,
      top: Math.round(top),
      bottom: Math.round(bottom),
      vvHeight: Math.round(g.vvHeight),
      innerHeight: g.innerHeight,
      keyboard: await keyboardShown(),
    };
  };
  j.reach = [await reach("keyboard up, portrait")];
  if (!j.reach[0].inView) {
    // Can the payer scroll to it without closing the keyboard?
    await swipeIntoView(page, review);
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
  // Turn the phone to landscape with the keyboard up, and back.
  await rotate(1);
  shots.push(await shot("swap-landscape"));
  j.landscape = {
    value: await input.inputValue(),
    measure: await measure(page, "refund form, landscape", "swap"),
    reach: await reach("landscape"),
  };
  if (j.landscape.value !== SOLANA_REFUND_ADDRESS)
    problem("swap", "rotate", "rotating to landscape lost the typed refund address", shots.at(-1));
  if (!j.landscape.reach.inView)
    problem(
      "swap",
      "rotate",
      `in landscape with the keyboard up, "Review refund address" is off the visible strip (${JSON.stringify(j.landscape.reach)})`,
      shots.at(-1),
      { severity: "polish" },
    );
  await rotate(0);
  shots.push(await shot("swap-portrait-again"));
  j.portraitAgain = { value: await input.inputValue(), reach: await reach("back to portrait") };
  if (j.portraitAgain.value !== SOLANA_REFUND_ADDRESS)
    problem(
      "swap",
      "rotate",
      "rotating back to portrait lost the typed refund address",
      shots.at(-1),
    );
  if (await keyboardShown()) await key("KEYCODE_BACK");
  await sleep(800);
  await calibrate(page);
  // Review, then confirm, by touch.
  await realTap(page, review, "Review refund address", { journey: "swap" });
  await page
    .getByText(`Confirm refund to ${SOLANA_REFUND_ADDRESS}.`)
    .first()
    .waitFor({ timeout: 15_000 });
  shots.push(await shot("swap-refund-review"));
  await measure(page, "refund review", "swap");
  await realTap(
    page,
    page.getByRole("button", { name: "Confirm refund" }).first(),
    "Confirm refund",
    { journey: "swap" },
  );
  await page.getByText("Refund pending").first().waitFor({ timeout: 30_000 });
  shots.push(await shot("swap-refund-pending"));
});

// (c') A swap stepped all the way to paid.
await journeyRun("swap-paid", async (j) => {
  j.orderUrl = await orderOneButton("swap-paid");
  const shots = [];
  j.shots = shots;
  await realTap(page, page.getByRole("button", { name: /^USDT/ }), "USDT tile", {
    journey: "swap-paid",
  });
  const group = page
    .getByRole("group", { name: /Choose USDT network/ })
    .filter({ visible: true })
    .first();
  await realTap(page, group.getByRole("button", { name: "Solana" }), "Solana network", {
    journey: "swap-paid",
  });
  await page
    .getByText(/≈ [\d.]+ USDT/)
    .first()
    .waitFor({ timeout: 15_000 });
  const swap = await minted(page, "/openreceive/swaps", () =>
    realTap(page, page.getByRole("button", { name: "Continue" }), "Continue", {
      journey: "swap-paid",
    }),
  );
  j.swap = swap;
  await page
    .getByText(/Pay [\d.]+ USDT to this address/)
    .first()
    .waitFor({ timeout: 30_000 });
  // The deposit address copy row, by touch, and back through the clipboard.
  const copyAddress = page.getByRole("button", { name: /copy/i }).filter({ visible: true }).first();
  if ((await copyAddress.count()) > 0) {
    await realTap(page, copyAddress, "copy deposit address", { journey: "swap-paid" });
    await sleep(600);
    shots.push(await shot("swap-paid-address-copied"));
  }
  const selector = { provider_order_id: swap.providerOrderId };
  await control("/__testkit/swap-step", { ...selector, state: "confirming" });
  await page.getByText("Confirming payment").first().waitFor({ timeout: 30_000 });
  shots.push(await shot("swap-paid-confirming"));
  await control("/__testkit/swap-step", { ...selector, state: "completed" });
  await page.getByText("Finalizing checkout").first().waitFor({ timeout: 30_000 });
  shots.push(await shot("swap-paid-finalizing"));
  await control("/__testkit/settle", { payment_hash: swap.hash });
  const started = Date.now();
  await paidTitle().first().waitFor({ timeout: 30_000 });
  j.paidAfterSettleMs = Date.now() - started;
  await sleep(600);
  shots.push(await shot("swap-paid-receipt"));
  await measure(page, "swap receipt", "swap-paid");
});

// (c'') Large text and dark theme, set in Settings before the payer opens the shop.
await journeyRun("big-text-dark", async (j) => {
  await detach();
  await setSystem({ fontScale: process.env.FONT_SCALE ?? "1.3", night: true });
  await startChrome();
  const shots = [];
  j.shots = shots;
  j.settings = await page.evaluate(() => ({
    prefersDark: matchMedia("(prefers-color-scheme: dark)").matches,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    bodyColor: getComputedStyle(document.body).color,
  }));
  j.orderUrl = await orderOneButton("big-text-dark");
  shots.push(await shot("big-text-dark-grid"));
  await measure(page, "method grid, large text", "big-text-dark");
  await lightningInvoice("big-text-dark");
  shots.push(await shot("big-text-dark-invoice"));
  const m = await measure(page, "invoice, large text", "big-text-dark");
  if (m.cut.length > 0) j.cut = m.cut;
  await realTap(
    page,
    page.getByRole("button", { name: /switch payment method/i }).first(),
    "Switch payment method",
    { journey: "big-text-dark" },
  );
  await realTap(page, page.getByRole("button", { name: /^USDT/ }), "USDT tile", {
    journey: "big-text-dark",
  });
  const group = page
    .getByRole("group", { name: /Choose USDT network/ })
    .filter({ visible: true })
    .first();
  await realTap(page, group.getByRole("button", { name: "Solana" }), "Solana network", {
    journey: "big-text-dark",
  });
  await page
    .getByText(/≈ [\d.]+ USDT/)
    .first()
    .waitFor({ timeout: 15_000 });
  shots.push(await shot("big-text-dark-quote"));
  await minted(page, "/openreceive/swaps", () =>
    realTap(page, page.getByRole("button", { name: "Continue" }), "Continue", {
      journey: "big-text-dark",
    }),
  );
  await page
    .getByText(/Pay [\d.]+ USDT to this address/)
    .first()
    .waitFor({ timeout: 30_000 });
  shots.push(await shot("big-text-dark-deposit"));
  await measure(page, "deposit, large text", "big-text-dark");
  // Low-contrast text in the dark theme: the checkout's own colors, measured.
  j.lowContrast = await page.evaluate(() => {
    // Computed colors come back as oklch()/color-mix() from Tailwind 4 and
    // daisyUI 5: let a canvas turn any CSS color into sRGB bytes.
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    const rgba = (css) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const lum = ([r, g, b]) => {
      const f = (v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    // The first background behind the text that paints at least half-opaque.
    const bg = (el) => {
      for (let n = el; n; n = n.parentElement ?? n.getRootNode()?.host) {
        const c = rgba(getComputedStyle(n).backgroundColor);
        if (c[3] > 0.5) return c;
      }
      return rgba(getComputedStyle(document.documentElement).backgroundColor || "#fff");
    };
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const text = t.textContent.trim();
      if (!text) continue;
      const el = t.parentElement;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden") continue;
      const fg = rgba(getComputedStyle(el).color);
      const [l1, l2] = [lum(fg), lum(bg(el))].sort((x, y) => y - x);
      const ratio = (l1 + 0.05) / (l2 + 0.05);
      if (ratio < 3) out.push(`"${text.slice(0, 40)}" ${ratio.toFixed(2)}:1`);
    }
    return [...new Set(out)].slice(0, 15);
  });
  if (j.lowContrast.length > 0)
    problem(
      "big-text-dark",
      "deposit",
      `text under 3:1 contrast with the phone in dark mode: ${j.lowContrast.slice(0, 6).join("; ")}`,
      shots.at(-1),
    );
  await setSystem({});
  await detach();
});

// (d) BACK and reload in the middle of a checkout: the same invoice comes back.
await journeyRun("back-reload", async (j) => {
  const url = await orderOneButton("back-reload");
  j.orderUrl = url;
  const shots = [];
  j.shots = shots;
  const first = await lightningInvoice("back-reload");
  j.firstHash = first.hash;
  const shown = async () =>
    page.evaluate(() => {
      const values = [];
      const visit = (root) => {
        for (const el of root.querySelectorAll("input, textarea")) values.push(el.value);
        for (const el of root.querySelectorAll("*")) if (el.shadowRoot) visit(el.shadowRoot);
      };
      visit(document);
      return values.find((v) => /^ln(bc|tb|bcrt)/i.test(v)) ?? null;
    });
  j.firstShownBolt11 = (await shown())?.slice(0, 30);
  const createdBefore = calls.filter(
    (c) => c.path === "/openreceive/checkouts" && c.method === "POST",
  ).length;
  // Pull-to-refresh: a real downward drag from the top of the page.
  await page.evaluate(() => scrollTo(0, 0));
  await sleep(500);
  const g = await geometry(page);
  const from = toDevice(g, g.innerWidth / 2, 40);
  const nav = page.waitForEvent("framenavigated", { timeout: 10_000 }).catch(() => undefined);
  // A slow drag that rests before lifting, as a thumb pulls: a fast
  // `input swipe` reads as a fling and Chrome does not refresh.
  await drag(from, { x: from.x, y: from.y + 1200 }, 12);
  let reloaded = await nav;
  if (!reloaded) {
    // Chrome's menu, then its Refresh button.
    const again = page.waitForEvent("framenavigated", { timeout: 10_000 }).catch(() => undefined);
    await tapNode(
      (n) => n.pkg === "com.android.chrome" && /id\/menu_button$/.test(n.id),
      "Chrome menu",
    ).catch(() => undefined);
    await sleep(800);
    await tapNode((n) => /^(refresh|reload)$/i.test(n.desc), "Refresh in Chrome's menu").catch(
      () => undefined,
    );
    reloaded = await again;
    j.reloadVia = reloaded ? "Chrome menu Refresh" : "none";
  } else {
    j.reloadVia = "pull to refresh";
  }
  j.pullToRefreshReloaded = reloaded !== undefined;
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await sleep(4000);
  shots.push(await shot("back-reload-after-pull-to-refresh"));
  j.afterReload = {
    url: page.url(),
    text: (await textOf(page)).slice(0, 300),
    bolt11: (await shown())?.slice(0, 30),
  };
  j.overscroll = await page.evaluate(() => ({
    html: getComputedStyle(document.documentElement).overscrollBehaviorY,
    body: getComputedStyle(document.body).overscrollBehaviorY,
  }));
  if (!reloaded)
    problem(
      "back-reload",
      "reload",
      "neither pull-to-refresh nor Chrome's Refresh reloaded the checkout",
      shots.at(-1),
      { severity: "info" },
    );
  // Whatever screen came back: if it is the grid, pick Bitcoin again.
  await page.evaluate(PROBE);
  await calibrate(page).catch(() => undefined);
  if ((await copyButton().count()) === 0) {
    j.afterReload.screen = "method grid";
    const again = await lightningInvoice("back-reload");
    j.afterReload.hash = again.hash;
    if (again.hash !== first.hash)
      problem(
        "back-reload",
        "reload",
        "after a reload and Bitcoin again, the checkout minted a second invoice for the same order",
        shots.at(-1),
      );
  } else {
    j.afterReload.screen = "invoice";
  }
  const bolt11Now = await shown();
  if (bolt11Now && first.bolt11 && bolt11Now.toLowerCase() !== first.bolt11.toLowerCase())
    problem(
      "back-reload",
      "reload",
      "after a reload the invoice on screen is not the one minted first",
      shots.at(-1),
    );
  // Android BACK from the invoice.
  const beforeBack = page.url();
  await key("KEYCODE_BACK");
  await sleep(2500);
  shots.push(await shot("back-reload-after-back"));
  j.afterBack = {
    url: page.url(),
    sameUrl: page.url() === beforeBack,
    text: (await textOf(page).catch(() => "")).slice(0, 300),
  };
  // Forward again through Chrome's own menu (the arrow at the top of ⋮).
  try {
    await tapNode(
      (n) => n.pkg === "com.android.chrome" && /id\/menu_button$/.test(n.id),
      "Chrome menu",
    );
    await sleep(800);
    await tapNode(
      (n) => /id\/forward_menu_id$/.test(n.id) || /^forward$/i.test(n.desc),
      "Forward in Chrome's menu",
    );
    await sleep(4000);
    j.afterForward = { url: page.url() };
  } catch (error) {
    j.afterForward = { error: String(error) };
    await key("KEYCODE_BACK").catch(() => undefined);
  }
  await page.evaluate(PROBE).catch(() => undefined);
  shots.push(await shot("back-reload-after-forward"));
  if (
    (await copyButton().count()) === 0 &&
    (await page.getByRole("button", { name: /^Bitcoin/ }).count()) > 0
  ) {
    await calibrate(page).catch(() => undefined);
    const again = await lightningInvoice("back-reload");
    j.afterForward.hash = again.hash;
    if (again.hash !== first.hash)
      problem(
        "back-reload",
        "back/forward",
        "after BACK, forward and Bitcoin again, the checkout minted a second invoice for the same order",
        shots.at(-1),
      );
  }
  const bolt11AfterForward = await shown();
  j.afterForward.bolt11 = bolt11AfterForward?.slice(0, 30);
  if (
    bolt11AfterForward &&
    first.bolt11 &&
    bolt11AfterForward.toLowerCase() !== first.bolt11.toLowerCase()
  )
    problem(
      "back-reload",
      "back/forward",
      "after BACK and forward the invoice on screen is not the one minted first",
      shots.at(-1),
    );
  const created = calls.filter((c) => c.path === "/openreceive/checkouts" && c.method === "POST");
  j.createRequests = created.length;
  j.createdAfterFirst = created.length - createdBefore;
  const state = await fetch(`${CONTROL_URL}/__testkit/state`)
    .then((r) => r.json())
    .catch(() => undefined);
  j.walletInvoices = state?.wallet?.invoices?.length ?? state?.invoices?.length;
});

// (e) What only a phone shows: the tutorial dialog, BACK on a dialog, tap sizes.
await journeyRun("phone", async (j) => {
  j.orderUrl = await orderOneButton("phone");
  const shots = [];
  j.shots = shots;
  await lightningInvoice("phone");
  await sleep(800);
  j.invoiceMeasure = await measure(page, "invoice (phone audit)", "phone");
  // Text autosizing: the same "How To Pay" button rendered at different sizes.
  j.howToPay = await page.evaluate(() => {
    const out = [];
    const visit = (root) => {
      for (const el of root.querySelectorAll("button")) {
        if (!/how to pay/i.test(el.textContent)) continue;
        const r = el.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(el);
        const t = range.getBoundingClientRect();
        out.push({
          h: Math.round(r.height),
          w: Math.round(r.width),
          textH: Math.round(t.height),
          font: getComputedStyle(el).fontSize,
        });
      }
      for (const el of root.querySelectorAll("*")) if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(document);
    return out;
  });
  const heights = [...new Set(j.howToPay.map((b) => b.h))];
  if (heights.length > 1)
    problem(
      "phone",
      "wallet list",
      `the "How To Pay" buttons render at ${heights.length} different heights (${heights.join(", ")} px) with one CSS font size (${[...new Set(j.howToPay.map((b) => b.font))].join(", ")}): Chrome's text autosizing boosts some rows`,
      undefined,
      { severity: "polish" },
    );
  // Truncated wallet names and labels with Roboto's widths.
  if (j.invoiceMeasure.cut.length > 0)
    problem(
      "phone",
      "invoice",
      `text cut off on a 360 px phone: ${j.invoiceMeasure.cut.slice(0, 8).join("; ")}`,
      undefined,
      { severity: "polish" },
    );
  // Open Cash App's walkthrough by touch.
  const opener = page
    .getByRole("button", { name: /how to pay/i })
    .filter({ visible: true })
    .first();
  await realTap(page, opener, "How To Pay (first wallet)", { journey: "phone" });
  const dialog = page.getByRole("dialog").filter({ visible: true }).first();
  await dialog.waitFor({ timeout: 15_000 });
  await sleep(800);
  shots.push(await shot("phone-tutorial"));
  const tutorialGeometry = () =>
    dialog.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const box = el.firstElementChild?.getBoundingClientRect();
      const containers = [];
      for (
        let n = el.parentElement ?? el.getRootNode().host;
        n;
        n = n.parentElement ?? n.getRootNode()?.host
      ) {
        const cs = getComputedStyle(n);
        if (cs.containerType !== "normal" || cs.transform !== "none" || cs.contain !== "none")
          containers.push(
            `${n.localName}.${String(n.className).split(" ")[0]} container-type:${cs.containerType}`,
          );
      }
      const images = [...el.querySelectorAll("img")].map((img) => ({
        alt: img.alt.slice(0, 40),
        w: Math.round(img.getBoundingClientRect().width),
        h: Math.round(img.getBoundingClientRect().height),
        natural: img.naturalWidth,
        src: img.src.slice(0, 22),
      }));
      return {
        position: getComputedStyle(el).position,
        overlay: [Math.round(r.top), Math.round(r.bottom)],
        box: box ? [Math.round(box.top), Math.round(box.bottom)] : undefined,
        containers,
        scrollable: el.scrollHeight > el.clientHeight,
        images,
        vvHeight: visualViewport.height,
      };
    });
  j.tutorial = await tutorialGeometry();
  if (j.tutorial.box && (j.tutorial.box[1] < 0 || j.tutorial.box[0] > j.tutorial.vvHeight)) {
    problem(
      "phone",
      "tutorial",
      `"How To Pay" opened the walkthrough off-screen: the dimmed overlay covers the page, the dialog box sits at y ${j.tutorial.box[0]}..${j.tutorial.box[1]} of a ${Math.round(j.tutorial.vvHeight)} px screen. Its position:${j.tutorial.position} overlay is ${j.tutorial.overlay[1] - j.tutorial.overlay[0]} px tall: a ${j.tutorial.containers[0] ?? "?"} ancestor is its containing block in this Chrome`,
      shots.at(-1),
    );
  }
  const copyInDialog = dialog.getByRole("button", { name: /copy invoice/i }).first();
  if ((await copyInDialog.count()) > 0) {
    await realTap(page, copyInDialog, "Copy invoice in the walkthrough", { journey: "phone" });
    await sleep(1000);
    shots.push(await shot("phone-tutorial-copied"));
  }
  j.tutorial.afterCopy = await tutorialGeometry();
  const bigImage = j.tutorial.afterCopy.images.find((img) => img.alt);
  if (bigImage && bigImage.h > j.tutorial.afterCopy.vvHeight * 0.8)
    problem(
      "phone",
      "tutorial",
      `the walkthrough picture is ${bigImage.h} px tall on a ${Math.round(j.tutorial.afterCopy.vvHeight)} px screen; its caption and the next step sit below the fold`,
      shots.at(-1),
      { severity: "polish" },
    );
  // Android BACK with the walkthrough open: a payer expects it to close the dialog.
  const before = page.url();
  await key("KEYCODE_BACK");
  await sleep(2000);
  shots.push(await shot("phone-tutorial-after-back"));
  const stillOpen = (await page.getByRole("dialog").filter({ visible: true }).count()) > 0;
  const urlAfter = page.url();
  j.backOnDialog = { before, after: urlAfter, dialogStillOpen: stillOpen };
  if (urlAfter !== before)
    problem(
      "phone",
      "tutorial",
      `Android BACK with the wallet walkthrough open left the checkout (${before} → ${urlAfter}) instead of closing the walkthrough`,
      shots.at(-1),
    );
  else if (stillOpen)
    problem(
      "phone",
      "tutorial",
      "Android BACK with the wallet walkthrough open did nothing",
      shots.at(-1),
      { severity: "polish" },
    );
});

report.finished = new Date().toISOString();
writeFileSync(path.join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
log(
  `report: ${path.relative(process.cwd(), OUT)}/report.json; ${report.problems.length} problem(s)`,
);
for (const p of report.problems)
  log(` - [${p.journey} / ${p.step}] ${p.what}${p.screenshot ? ` (${p.screenshot})` : ""}`);
await detach();
await device.close();
process.exit(0);
