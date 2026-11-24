// The iOS lab's two hands on one simulator:
//
//   Phone     every touch, through Appium's XCUITest driver (WebDriverAgent):
//             taps, long presses, finger drags, the edge swipe, Safari's own
//             toolbar, the software keyboard, app switches, rotation. XCTest
//             synthesizes the touches, so Safari receives them the way it
//             receives a finger: the page sees pointerType "touch".
//   Inspector what the page does, through Safari's Web Inspector socket
//             (appium-remote-debugger, as exrails' run-ios-sim.mjs does):
//             reading the DOM, rects, the console, the network. It never
//             clicks; a probe in the page reads back every pointerdown, so a
//             tap that lands on the wrong element is reported.
//
// Plus simctl for what the device itself does: screenshots, the pasteboard,
// appearance, Dynamic Type, opening a URL.
import { execFileSync } from "node:child_process";

export const DEVELOPER_DIR =
  process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const env = { ...process.env, DEVELOPER_DIR };
export const SAFARI = "com.apple.mobilesafari";
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function simctl(...args) {
  return execFileSync("xcrun", ["simctl", ...args], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export async function waitForValue(read, timeoutMs, everyMs = 200) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > until) return undefined;
    await sleep(everyMs);
  }
}

// ------------------------------------------------------------------ Appium

export class Phone {
  constructor(appiumUrl, udid) {
    this.appiumUrl = appiumUrl;
    this.udid = udid;
    this.sid = undefined;
  }

  async wd(method, route, body) {
    const response = await fetch(`${this.appiumUrl}${route}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(`appium ${method} ${route}: ${JSON.stringify(json).slice(0, 400)}`);
    return json.value;
  }

  s(route) {
    return `/session/${this.sid}${route}`;
  }

  /**
   * A native session on Safari's bundle: Appium only touches. It does not
   * attach to Safari's web content, which stays free for the Inspector.
   */
  async open() {
    for (const old of (await this.wd("GET", "/appium/sessions").catch(() => [])) ?? []) {
      if (old.capabilities?.udid === this.udid)
        await this.wd("DELETE", `/session/${old.id}`).catch(() => undefined);
    }
    const value = await this.wd("POST", "/session", {
      capabilities: {
        alwaysMatch: {
          platformName: "iOS",
          "appium:automationName": "XCUITest",
          "appium:udid": this.udid,
          "appium:bundleId": SAFARI,
          "appium:noReset": true,
          "appium:wdaLaunchTimeout": 900_000,
          "appium:wdaConnectionTimeout": 900_000,
          "appium:newCommandTimeout": 3600,
          "appium:connectHardwareKeyboard": false,
          "appium:includeSafariInWebviews": false,
          // Two simulators at once need two WebDriverAgent ports.
          ...(process.env.WDA_PORT ? { "appium:wdaLocalPort": Number(process.env.WDA_PORT) } : {}),
        },
      },
    });
    this.sid = value.sessionId;
    this.size = await this.wd("GET", this.s("/window/rect"));
    return value;
  }

  async close() {
    if (this.sid) await this.wd("DELETE", this.s("")).catch(() => undefined);
    this.sid = undefined;
  }

  async windowSize() {
    this.size = await this.wd("GET", this.s("/window/rect"));
    return this.size;
  }

  /** A finger: down at the first point, through the rest, up at the last. */
  async touch(points, { holdMs = 60, stepMs = 50, restMs = 0 } = {}) {
    const [first, ...rest] = points;
    const actions = [
      { type: "pointerMove", duration: 0, x: Math.round(first.x), y: Math.round(first.y) },
      { type: "pointerDown", button: 0 },
      { type: "pause", duration: holdMs },
      ...rest.map((p) => ({
        type: "pointerMove",
        duration: stepMs,
        x: Math.round(p.x),
        y: Math.round(p.y),
      })),
      ...(restMs > 0 ? [{ type: "pause", duration: restMs }] : []),
      { type: "pointerUp", button: 0 },
    ];
    await this.wd("POST", this.s("/actions"), {
      actions: [{ type: "pointer", id: "finger", parameters: { pointerType: "touch" }, actions }],
    });
    await this.wd("DELETE", this.s("/actions")).catch(() => undefined);
  }

  tap(x, y) {
    return this.touch([{ x, y }]);
  }

  longPress(x, y, ms = 1000) {
    return this.touch([{ x, y }], { holdMs: ms });
  }

  /** A drag with no fling: small steps, then a rest before lifting. */
  drag(from, to, { steps = 8, stepMs = 40, restMs = 300 } = {}) {
    const points = [from];
    for (let i = 1; i <= steps; i += 1)
      points.push({
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      });
    return this.touch(points, { holdMs: 30, stepMs, restMs });
  }

  /** Safari's Back gesture: a finger from the left edge of the screen. */
  async edgeSwipeBack() {
    const { width, height } = await this.windowSize();
    const y = height / 2;
    await this.touch(
      [
        { x: 1, y },
        { x: 30, y },
        { x: width * 0.35, y },
        { x: width * 0.7, y },
      ],
      { holdMs: 20, stepMs: 90 },
    );
  }

  /** A native element by an iOS predicate, or undefined. */
  async find(predicate) {
    try {
      const el = await this.wd("POST", this.s("/element"), {
        using: "-ios predicate string",
        value: predicate,
      });
      return Object.values(el)[0];
    } catch {
      return undefined;
    }
  }

  /** Every native element matching a predicate, as rects. */
  async findAll(predicate) {
    const els = await this.wd("POST", this.s("/elements"), {
      using: "-ios predicate string",
      value: predicate,
    }).catch(() => []);
    const out = [];
    for (const el of els.slice(0, 12)) {
      const rect = await this.rectOf(Object.values(el)[0]).catch(() => undefined);
      if (rect && rect.width > 0 && rect.height > 0) out.push(rect);
    }
    return out;
  }

  /**
   * Safari's accessibility tree for web content, by label: screen rects that
   * stay right while the keyboard opens and Safari scrolls the page under it,
   * when the page's own visualViewport numbers are mid-animation.
   */
  async webElements(label) {
    if (!label || label.length > 80 || /['\\]/.test(label)) return [];
    return this.findAll(
      `visible == 1 AND (type == 'XCUIElementTypeButton' OR type == 'XCUIElementTypeTextField' OR type == 'XCUIElementTypeLink') AND (label == '${label}' OR placeholderValue == '${label}')`,
    );
  }

  /** What covers the bottom of the screen while typing: the keyboard and Safari's form bar. */
  async keyboardTop() {
    const tops = [];
    for (const predicate of [
      "type == 'XCUIElementTypeKeyboard'",
      "type == 'XCUIElementTypeToolbar' AND name == 'Toolbar'",
    ]) {
      for (const r of await this.findAll(`visible == 1 AND ${predicate}`)) tops.push(r.y);
    }
    return tops.length === 0 ? undefined : Math.min(...tops);
  }

  async rectOf(id) {
    return this.wd("GET", this.s(`/element/${id}/rect`));
  }

  /** Tap a native element (Safari's toolbar, the keyboard) at its middle, by touch. */
  async tapNative(predicate, label = predicate) {
    const id = await waitForValue(() => this.find(predicate), 5000, 300);
    if (id === undefined) throw new Error(`no ${label} on screen`);
    const r = await this.rectOf(id);
    await this.tap(r.x + r.width / 2, r.y + r.height / 2);
    return r;
  }

  /**
   * Safari's own reload button, by touch. A minimized bar (Safari 18 after a
   * scroll) shows only the address; one tap on it brings the full bar back.
   */
  async reload() {
    const button = "name == 'ReloadButton' AND visible == 1";
    if ((await this.find(button)) === undefined) {
      await this.tapNative("name == 'TabBarItemTitle'", "Safari's minimized address bar");
      await sleep(800);
    }
    return this.tapNative(button, "Safari's reload button");
  }

  async source() {
    return this.wd("GET", this.s("/source"));
  }

  /** Safari's floating address bar (the capsule) on screen, or undefined. */
  async capsule() {
    const id = await this.find("name BEGINSWITH 'CapsuleNavigationBar'");
    return id === undefined ? undefined : this.rectOf(id).catch(() => undefined);
  }

  /** Safari's window name says whether its bars are minimized. */
  async safariBars() {
    const xml = await this.source();
    const name = xml.match(/name="SafariWindow\?([^"]*)"/)?.[1]?.replaceAll("&amp;", "&") ?? "";
    const capsule = xml.match(
      /<XCUIElementTypeOther[^>]*name="CapsuleNavigationBar[^"]*"[^>]*y="(\d+)"[^>]*height="(\d+)"/,
    );
    const address = xml.match(/name="TabBarItemTitle"[^>]*\by="(\d+)"[^>]*height="(\d+)"/);
    return {
      minimized: /BarsKeptMinimized=true/.test(name),
      window: name,
      capsuleTop: capsule ? Number(capsule[1]) : undefined,
      addressTop: address ? Number(address[1]) : undefined,
    };
  }

  async keyboardShown() {
    return Boolean(
      await this.wd("GET", this.s("/appium/device/is_keyboard_shown")).catch(() => false),
    );
  }

  /**
   * Type through the software keyboard (XCUIElement.typeText) into the field
   * `predicate` names. XCUITest does not report keyboard focus inside web
   * content, so the field is named rather than found by focus.
   */
  async type(text, predicate = "hasKeyboardFocus == 1") {
    const id = await this.find(predicate);
    if (id === undefined) throw new Error(`no text field matching ${predicate} to type into`);
    await this.wd("POST", this.s(`/element/${id}/value`), { text, value: [...text] });
  }

  /** Close the keyboard the way a payer does: the Done/✓ key on Safari's form bar. */
  async dismissKeyboard() {
    for (const predicate of [
      "type == 'XCUIElementTypeButton' AND (name == 'Done' OR label == 'Done')",
      "type == 'XCUIElementTypeButton' AND (name == 'checkmark' OR label == 'Done' OR label == 'Hide keyboard')",
    ]) {
      const id = await this.find(predicate);
      if (id !== undefined) {
        const r = await this.rectOf(id);
        await this.tap(r.x + r.width / 2, r.y + r.height / 2);
        return "Done key";
      }
    }
    await this.wd("POST", this.s("/appium/device/hide_keyboard"), {}).catch(() => undefined);
    return "hide_keyboard";
  }

  activate(bundleId) {
    return this.wd("POST", this.s("/execute/sync"), {
      script: "mobile: activateApp",
      args: [{ bundleId }],
    });
  }

  home() {
    return this.wd("POST", this.s("/execute/sync"), {
      script: "mobile: pressButton",
      args: [{ name: "home" }],
    });
  }

  async rotate(orientation) {
    await this.wd("POST", this.s("/orientation"), { orientation });
    await sleep(1800);
    // Back in portrait on the iPhone 16 Pro, the session kept mapping touches
    // as if the screen were still landscape: every later tap missed the page
    // until a new session. A fresh session costs a few seconds.
    if (orientation === "PORTRAIT") {
      await this.close();
      await this.open();
    }
    await this.windowSize();
  }

  screenshot(file) {
    simctl("io", this.udid, "screenshot", file);
  }

  pasteboard() {
    return simctl("pbpaste", this.udid);
  }
}

// --------------------------------------------------------------- Inspector

export class Inspector {
  constructor(udid, host) {
    this.udid = udid;
    this.host = host;
    this.client = undefined;
    this.console = [];
    this.network = [];
    this.requests = new Map();
  }

  async connect() {
    await this.disconnect();
    if (!process.env.IOS_LAB_DEBUG) process.env._TESTING = "1";
    const { createRemoteDebugger } = await import("appium-remote-debugger");
    this.client = createRemoteDebugger(
      {
        bundleId: SAFARI,
        isSafari: true,
        platformVersion: simctl("getenv", this.udid, "SIMULATOR_RUNTIME_VERSION").trim(),
        socketPath: simctl("getenv", this.udid, "RWI_LISTEN_SOCKET").trim(),
        pageLoadMs: 8000,
        garbageCollectOnExecute: false,
      },
      false,
    );
    this.client.setup();
    await this.client.connect(20_000);
  }

  async disconnect() {
    const client = this.client;
    this.client = undefined;
    if (client) await client.disconnect().catch(() => undefined);
  }

  /** Select the Safari page on our host; resolves its URL. */
  async select(timeoutMs = 30_000) {
    if (this.client === undefined) await this.connect();
    const until = Date.now() + timeoutMs;
    for (;;) {
      const pages = await this.client.selectApp(null, 3, false).catch(() => []);
      // Safari keeps other tabs on the same host: the one on screen is the payer's.
      // A suspended background tab never answers, so the check has a time limit,
      // and the newest tab (usually the payer's) goes first.
      const ours = pages.filter((p) => String(p.url).includes(this.host)).reverse();
      for (const page of ours) {
        const [app, id] = String(page.id).split(".");
        try {
          await this.client.selectPage(app, Number(id), true);
          const shown = await Promise.race([
            this.client.execute("document.visibilityState"),
            sleep(3000).then(() => "no answer"),
          ]);
          if (shown !== "visible" && ours.length > 1) continue;
        } catch {
          continue;
        }
        this.listen();
        return page.url;
      }
      if (Date.now() > until) throw new Error(`no Safari page on ${this.host}`);
      await sleep(800);
    }
  }

  listen() {
    const client = this.client;
    if (client.__labListening) return;
    client.__labListening = true;
    client.startConsole((_error, message) => {
      if (message?.level === "error" || message?.level === "warning")
        this.console.push({
          at: Date.now(),
          level: message.level,
          text: String(message.text ?? "").slice(0, 400),
          url: message.url,
        });
    });
    client.startNetwork((_error, params, method) => {
      if (method === "Network.requestWillBeSent")
        this.requests.set(params.requestId, {
          url: params.request?.url,
          method: params.request?.method,
          at: Date.now(),
        });
      else if (method === "Network.responseReceived") {
        const r = this.requests.get(params.requestId);
        if (r) r.status = params.response?.status;
      } else if (method === "Network.loadingFailed") {
        const r = this.requests.get(params.requestId) ?? {};
        this.network.push({
          at: Date.now(),
          url: r.url,
          method: r.method,
          failed: params.errorText ?? "failed",
          canceled: params.canceled,
        });
      } else if (method === "Network.loadingFinished") {
        const r = this.requests.get(params.requestId);
        if (r?.status >= 400) this.network.push({ at: Date.now(), ...r });
      }
    });
  }

  /** Evaluate an expression in the page; the value travels as JSON. */
  async ev(expression) {
    if (this.client === undefined) await this.select();
    const result = await this.client.execute(`JSON.stringify({ v: (${expression}) })`);
    return (typeof result === "string" ? JSON.parse(result) : result)?.v;
  }

  /** Call `fn(arg)` in the page. */
  call(fn, arg) {
    return this.ev(`(${fn})(${JSON.stringify(arg ?? null)})`);
  }

  /** ev, re-selecting the page once if a navigation took it away. */
  async evSafe(expression) {
    try {
      return await this.ev(expression);
    } catch {
      await this.select();
      return this.ev(expression);
    }
  }
}
