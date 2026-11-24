// The lab's finger: aiming at page elements, scrolling them into reach with
// real drags, and tapping them through WebDriverAgent, with the in-page probe
// confirming what each touch hit. Shared by run-journeys.mjs and run-faults.mjs.

import { sleep, waitForValue } from "./ios-device.mjs";
import { MEASURE, PROBE } from "./page-probes.mjs";

export const MIN_TAP_PT = 44;
export const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * `calibrateOn` names a harmless element (no action on tap) the lab taps once
 * per orientation to learn where the web content sits on screen.
 */
export function createTouch({ phone, web, log, shot, problem, report, calibrateOn }) {
  const state = { orientation: "PORTRAIT" };
  // ------------------------------------------------------------- the page

  /** Install the probe in the current document (no init scripts over the Inspector). */
  async function probe() {
    await web.evSafe(`(${PROBE})(), true`);
  }

  /** Find an element (shadow roots included) and mark it; resolves its rect or undefined. */
  const find = (q) => web.ev(`window.__lab.find(${JSON.stringify(q)})`);
  const exists = async (q) => (await find(q).catch(() => undefined)) !== undefined;
  const waitFor = (q, timeoutMs = 30_000) => waitForValue(() => find(q), timeoutMs, 300);

  async function waitShown(q, timeoutMs, what) {
    const found = await waitFor(q, timeoutMs);
    if (found === undefined) throw new Error(`${what ?? JSON.stringify(q)} never showed`);
    return found;
  }

  const geometry = () =>
    web.ev(`({
      innerWidth, innerHeight, scrollY,
      vvTop: visualViewport.offsetTop, vvLeft: visualViewport.offsetLeft,
      vvHeight: visualViewport.height, vvWidth: visualViewport.width, scale: visualViewport.scale,
      scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
    })`);

  // ---------------------------------------------------------- real touches

  /** Screen points of the visual viewport's top-left corner, learned from real taps. */
  const origin = { left: 0, top: undefined, orientation: "PORTRAIT" };

  const toScreen = (g, cx, cy) => ({
    x: Math.round(origin.left + (cx - g.vvLeft) * g.scale),
    y: Math.round(origin.top + (cy - g.vvTop) * g.scale),
  });

  function learnOrigin(x, y, tap) {
    origin.left = x - (tap.clientX - tap.vvLeft) * tap.scale;
    origin.top = y - (tap.clientY - tap.vvTop) * tap.scale;
    origin.orientation = state.orientation;
  }

  /** The strip of screen a finger can use: below the status bar, above Safari's bar or the keyboard. */
  async function reachable() {
    const size = await phone.windowSize();
    const bars = await phone.capsule();
    const keyboard = await phone.keyboardShown();
    const g = await geometry();
    let bottom = bars?.y ?? size.height - 90;
    if (keyboard)
      bottom = Math.min(bottom, (await phone.keyboardTop()) ?? origin.top + g.vvHeight * g.scale);
    return { top: (origin.top ?? 20) + 8, bottom: bottom - 8, width: size.width, keyboard, bars };
  }

  /** Tap the shop's eyebrow line once and learn where the web content sits on screen. */
  async function calibrate() {
    await web.ev(`(window.__lab.tap = undefined, true)`);
    // The target must be on screen: a tap clamped to the top edge lands on the
    // status bar, which iOS turns into "scroll to top" and never gives the page.
    // Setup, like the Android lab's scrollIntoView before calibrating.
    await web.ev(
      `(window.__lab.findEl(${JSON.stringify(calibrateOn)})?.scrollIntoView({ block: "center" }), true)`,
    );
    await sleep(500);
    const target = await find(calibrateOn);
    const g = await geometry();
    const size = await phone.windowSize();
    if (origin.top === undefined || origin.orientation !== state.orientation) {
      origin.left = 0;
      origin.top = state.orientation === "PORTRAIT" ? (size.height > 700 ? 62 : 20) : 0;
    }
    const cx = target.left + Math.min(40, target.width / 2);
    const cy = target.top + target.height / 2;
    const p = toScreen(g, cx, cy);
    await phone.tap(p.x, Math.max(30, p.y));
    let tap = await waitForValue(() => web.ev("window.__lab.tap"), 3000);
    if (tap === undefined) {
      // After a rotation on the iPhone 16 Pro the Inspector went on reading a
      // page that was not the one on screen: connect again and look once more.
      log("calibration tap not seen; reconnecting the Inspector");
      await web.connect();
      await web.select(15_000);
      await probe();
      await web.ev(`(window.__lab.tap = undefined, true)`);
      await phone.tap(p.x, Math.max(30, p.y));
      tap = await waitForValue(() => web.ev("window.__lab.tap"), 3000);
    }
    if (tap === undefined) throw new Error("calibration tap never reached the page");
    learnOrigin(p.x, Math.max(30, p.y), tap);
    log(`calibrated (${state.orientation}): web content top at ${Math.round(origin.top)} pt`);
  }

  /**
   * Bring an element into the reachable strip with real finger drags. Safari
   * carries a drag on with momentum even after the finger rests (a 200 pt drag
   * scrolls 300 to 500 pt), so the distance per drag is learned as it goes.
   */
  async function swipeIntoView(q) {
    let ratio = 2;
    for (let i = 0; i < 10; i += 1) {
      const r = await find(q);
      if (r === undefined) return;
      const g = await geometry();
      const strip = await reachable();
      // Safari's accessibility rect when it names the element: the page's own

      // numbers are wrong while the keyboard is up (they swing by 500 pt).

      let top = toScreen(g, 0, r.top).y;

      let bottom = toScreen(g, 0, r.bottom).y;

      const natives = await phone.webElements(r.name);

      if (natives.length > 0) {
        natives.sort((a, b) => Math.abs(a.y - top) - Math.abs(b.y - top));

        top = natives[0].y;

        bottom = natives[0].y + natives[0].height;
      }
      if (top >= strip.top + 8 && bottom <= strip.bottom - 8) return;
      const mid = (strip.top + strip.bottom) / 2;
      const want = top < strip.top + 8 ? top - mid : bottom - mid; // page points to scroll
      const span = (strip.bottom - strip.top) * 0.7;
      const finger = Math.max(-span, Math.min(span, want / ratio));
      if (Math.abs(finger) < 12) {
        // A nudge too small for a drag to register as a scroll.
        await web.ev(`(scrollBy(0, ${Math.round(want)}), true)`);
        await sleep(300);
        continue;
      }
      const x = strip.width * 0.9;
      await phone.drag({ x, y: mid + finger / 2 }, { x, y: mid - finger / 2 });
      await sleep(500);
      const moved = (await geometry()).scrollY - g.scrollY;
      if (process.env.IOS_LAB_TRACE)
        log(
          `drag ${Math.round(finger)} pt (want ${Math.round(want)}): page scrolled ${Math.round(moved)}, element top ${top} -> ${Math.round(toScreen(await geometry(), 0, (await find(q))?.top ?? 0).y)}, keyboard ${strip.keyboard}`,
        );
      if (Math.abs(moved) > 4) ratio = Math.min(4, Math.max(0.8, Math.abs(moved / finger)));
    }
  }

  async function settle(q) {
    let last = "";
    for (let i = 0; i < 20; i += 1) {
      const r = await find(q).catch(() => undefined);
      const g = await geometry().catch(() => ({}));
      const now = `${Math.round(r?.top)},${Math.round(r?.left)},${Math.round(g.vvTop)},${g.innerHeight}`;
      if (now === last) return;
      last = now;
      await sleep(200);
    }
  }

  /**
   * Tap the middle of an element with a real finger. The pointerdown the page
   * receives proves which element the finger hit; a miss is reported, never
   * replaced with a scripted click.
   */
  async function realTap(q, label, { journey, swipe = true, pressMs } = {}) {
    const t = Date.now();
    await waitShown(q, 30_000, label);
    if (swipe) await swipeIntoView(q);
    if (process.env.IOS_LAB_TRACE) log(`aim "${label}" (${Date.now() - t} ms to find and scroll)`);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await settle(q);
      const box = await web.ev(`window.__lab.aim(${JSON.stringify(q)})`);
      if (box === undefined) throw new Error(`${label} is gone`);
      const g = await geometry();
      let p = toScreen(g, box.x, box.y);
      // Aim with Safari's accessibility rect when it names this element: it stays
      // right while the keyboard animates. The nearest one if the label repeats.
      const natives = await phone.webElements(box.name);
      if (natives.length > 0) {
        const centers = natives.map((r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 }));
        centers.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y));
        p = { x: Math.round(centers[0].x), y: Math.round(centers[0].y), via: "accessibility" };
      }
      if (pressMs) await phone.longPress(p.x, p.y, pressMs);
      else await phone.tap(p.x, p.y);
      const tap = await waitForValue(() => web.ev("window.__lab?.tap"), 2500).catch(
        () => undefined,
      );
      if (tap === undefined) {
        log(`tap "${label}" at ${p.x},${p.y}: no pointerdown read back (navigated?)`);
        return { x: p.x, y: p.y, box };
      }
      if (p.via === undefined) learnOrigin(p.x, p.y, tap);
      if (tap.hit) return { x: p.x, y: p.y, box, hit: true, via: p.via ?? "page geometry" };
      const moved = tap.expectRect ? Math.round(tap.expectRect.top - box.top) : undefined;
      const scrolled = Math.round(tap.scrollY - box.scrollY);
      const file = await shot(`mistap-${slug(label)}`);
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

  // ------------------------------------------------------------ measures

  async function measure(screen, journey) {
    const result = await web.call(MEASURE, MIN_TAP_PT);
    report.journeys[journey].measures ??= {};
    report.journeys[journey].measures[screen] = result;
    if (result.scrollWidth > result.width + 1)
      problem(
        journey,
        screen,
        `the page scrolls sideways: ${result.scrollWidth} px of content in a ${result.width} px screen (${result.over.slice(0, 4).join(", ")})`,
      );
    else if (result.overCount > 0)
      problem(
        journey,
        screen,
        `${result.overCount} element(s) run past the ${result.width} px screen edge and are cut off (${result.over.slice(0, 4).join(", ")})`,
      );
    return result;
  }

  /** WebKit has no layout-shift API: sample where the checkout's controls sit, in page coordinates. */
  async function watchShifts(ms) {
    await web.ev("window.__lab.trackStart()");
    await sleep(ms);
    return web.ev("window.__lab.trackStop()");
  }

  return {
    state,
    origin,
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
  };
}
