import { mkdir } from "node:fs/promises";
import type {
  Browser,
  BrowserContextOptions,
  Frame,
  Locator,
  Page,
  Request,
} from "@playwright/test";
import { SWAP_PRODUCT } from "./live.ts";
import {
  type ApiCall,
  bannedPayerWordsInContext,
  bitcoinTile,
  CREATE_SWAP,
  checkoutRendered,
  chooseSwap,
  continueButton,
  describeCall,
  hashOf,
  invoiceQr,
  lastCall,
  lightningInvoice,
  message,
  Outcome,
  oneLine,
  order,
  PAGE_HELPERS,
  PAGE_TIMEOUT_MS,
  PAID_BUDGET_MS,
  PAID_TIMEOUT_MS,
  type PayerTarget,
  PRODUCT,
  readCheckout,
  SWAP_TIMEOUT_MS,
  sameInvoice,
  saysPaid,
  type Visit,
  visit,
  type Walk,
  waitFor,
  watchPage,
} from "./payer.ts";
import type { Check, Severity } from "./types.ts";
import { startWebkit } from "./wallet.ts";

// The payer's trip after the first screen. A person reloads, opens a second
// tab, loses signal in a lift, goes to their wallet app and comes back, opens
// the order again next week on another device. Issue #122 (a paid order that
// offered to be paid again) and the videos' 16 s lag both live here, and a
// walk that sits on one desktop page for one payment meets none of them.

const IDS = {
  reload: "payer_reload_keeps_invoice",
  tabs: "payer_two_tabs_both_paid",
  back: "payer_back_after_paid",
  reopen: "payer_reopen_paid",
  otherBrowser: "payer_reopen_paid_other_browser",
  offline: "payer_network_drop_recovers",
  wallet: "payer_back_from_wallet_app",
  double: "payer_lightning_then_swap",
  sees: "payer_swap_view_sees_lightning_paid",
  fits: "payer_phone_fits",
  phonePaid: "payer_phone_paid",
  tap: "payer_phone_copy_button",
  tutorial: "payer_tutorial_copy",
  refused: "payer_tutorial_copy_refused",
  safari: "payer_safari_paid",
  translated: "payer_translated_page_paid",
  keyboard: "payer_keyboard_only",
  axe: "payer_accessibility",
  rtl: "payer_dark_rtl_fits",
  scripts: "payer_no_script_errors",
} as const;

/** Offline this long, the checkout's polls have failed several times. */
const OFFLINE_MS = 12_000;
/** The payer spends this long in their wallet app with the checkout's tab asleep. */
const IN_WALLET_MS = 15_000;
/** Three of the checkout's polls and a slow scan. */
const SIBLING_SEEN_MS = 30_000;
const QUIET_STATE_MS = 15_000;
/** The narrowest phone in use, where a fixed width first breaks. */
const NARROW_PHONE = { width: 320, height: 640 } as const;
/** Apple's and Google's smallest comfortable tap is 44 and 48 px; well under 40 is a miss. */
const MIN_TAP_PX = 40;
const WALLET_LIST_WAIT_MS = 15_000;

interface Spec {
  readonly id: string;
  readonly summary: string;
  readonly severity?: Severity;
}

type Stage = { stage: string };

/** One visit whose checks fail with the place it stopped, if it stops. */
async function journey(
  browser: Browser,
  walk: Walk,
  name: string,
  specs: readonly Spec[],
  body: (state: Visit, outcome: Outcome, at: Stage) => Promise<void>,
  options?: BrowserContextOptions,
  shared?: string[],
): Promise<Check[]> {
  const outcome = new Outcome(specs);
  const at: Stage = { stage: "the home page" };
  let reason = "";
  await visit(
    browser,
    async (state) => {
      try {
        await body(state, outcome, at);
      } catch (error) {
        reason = `stopped at ${at.stage}: ${message(error)}${await walk.stuck(state.page, `${name}-stuck`)}`;
      }
      if (state.errors.length > 0) {
        shared?.push(...state.errors.map((error) => `${name}: ${error}`));
        reason = `${reason}; page errors: ${state.errors.join(" | ")}`;
      }
    },
    options,
  ).catch((error: unknown) => {
    reason = `the browser failed at ${at.stage}: ${message(error)}`;
  });
  return outcome.finish(reason || `stopped at ${at.stage}`);
}

/**
 * Counts payment checks on the wire; the returned function waits them out. A
 * check that left before the tab slept or the network dropped can still answer
 * "settled", so a journey about what happens afterwards settles only after it.
 */
function trackPaymentChecks(page: Page): () => Promise<unknown> {
  let open = 0;
  const isCheck = (request: Request) => /\/payments\/check\b/.test(request.url());
  const ended = (request: Request) => {
    if (isCheck(request)) open -= 1;
  };
  page.on("request", (request) => {
    if (isCheck(request)) open += 1;
  });
  page.on("requestfinished", ended);
  page.on("requestfailed", ended);
  return () => waitFor(async () => (open <= 0 ? true : undefined), 20_000, 100);
}

/** Time until the checkout, or the page once the checkout has gone, says paid. */
async function paidOnScreen(page: Page, timeoutMs: number): Promise<number | undefined> {
  const started = performance.now();
  const seen = await waitFor(
    async () => {
      const view = await readCheckout(page);
      return (view.present && saysPaid(view.text)) || (!view.present && saysPaid(view.page))
        ? true
        : undefined;
    },
    timeoutMs,
    200,
  );
  return seen === undefined ? undefined : Math.round(performance.now() - started);
}

/** Every payment hash the page received at or after `from`. */
function hashesSince(api: readonly ApiCall[], from: number): string[] {
  return [...new Set(api.slice(from).flatMap((call) => hashOf(call.body) ?? []))];
}

/** The server errors the page met at or after `from`. */
function serverErrors(api: readonly ApiCall[], from = 0): ApiCall[] {
  return api.slice(from).filter((call) => call.status >= 500);
}

const reloadPage = (page: Page) =>
  page.reload({ waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
const gotoPage = (page: Page, url: string) =>
  page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });

/** Order product 1 and reach its Lightning invoice. */
async function toInvoice(
  target: PayerTarget,
  state: Visit,
  at: Stage,
  productId = PRODUCT,
): Promise<{
  hash: string;
  bolt11: string;
  url: string;
  reopen?: (page: Page) => Promise<unknown>;
}> {
  at.stage = "the shop's order page";
  const placed = await order(target, state.page, productId);
  at.stage = "the checkout's first screen";
  if ((await checkoutRendered(state.page)) === "error") {
    throw new Error("the checkout opened on an error");
  }
  at.stage = "the Lightning invoice";
  const { hash, call } = await lightningInvoice(state);
  const bolt11 = call.body?.match(/"bolt11"\s*:\s*"(ln[a-z0-9]+)"/i)?.[1];
  if (bolt11 === undefined) throw new Error("the create answer carried no invoice");
  return {
    hash,
    bolt11,
    url: state.page.url(),
    ...(placed.reopen === undefined ? {} : { reopen: placed.reopen }),
  };
}

/** A paid order: the invoice, the wallet settling it, the paid screen. */
async function toPaid(
  target: PayerTarget,
  state: Visit,
  at: Stage,
): Promise<{ hash: string; url: string; paidUrl: string; ms: number }> {
  const { hash, url } = await toInvoice(target, state, at);
  at.stage = "the paid screen";
  await target.wallet.settle(hash);
  const ms = await paidOnScreen(state.page, PAID_TIMEOUT_MS);
  if (ms === undefined)
    throw new Error(`nothing said paid ${PAID_TIMEOUT_MS / 1000} s after settle`);
  return { hash, url, paidUrl: await settledUrl(state.page), ms };
}

/**
 * Where the payer ended up. A store hands a paid checkout over to its own
 * receipt, and the cart behind the checkout's address is gone by then.
 */
async function settledUrl(page: Page): Promise<string> {
  let last = page.url();
  let since = Date.now();
  const deadline = since + 15_000;
  while (Date.now() < deadline && Date.now() - since < 3_000) {
    await page.waitForTimeout(250);
    if (page.url() !== last) {
      last = page.url();
      since = Date.now();
    }
  }
  return last;
}

/** Wait for the checkout to draw something other than a loading state; undefined if it never does. */
async function settledScreen(page: Page): Promise<string | undefined> {
  return waitFor(
    async () => {
      const view = await readCheckout(page);
      if (
        view.present &&
        view.text.trim() !== "" &&
        !/^\s*(?:loading|creating checkout)/i.test(view.text)
      )
        return view.text;
      if (!view.present && saysPaid(view.page)) return view.page;
      return undefined;
    },
    QUIET_STATE_MS,
    300,
  );
}

async function offersPayment(page: Page): Promise<boolean> {
  return (await bitcoinTile(page).count()) > 0 || (await invoiceQr(page).count()) > 0;
}

// ---------------------------------------------------------------- return visits

/** Reloading while waiting keeps the invoice: a second one would have to be paid to count. */
function reloadJourney(browser: Browser, target: PayerTarget, walk: Walk, shared: string[]) {
  return journey(
    browser,
    walk,
    "reload",
    [
      {
        id: IDS.reload,
        summary:
          "A reload while the payer is waiting keeps the same invoice, and the payment still reaches the screen.",
      },
    ],
    async (state, outcome, at) => {
      const { page, api } = state;
      const { hash, reopen } = await toInvoice(target, state, at);
      at.stage = "the reload";
      const from = api.length;
      await reloadPage(page);
      await reopen?.(page);
      await checkoutRendered(page);
      if ((await invoiceQr(page).count()) === 0) await lightningInvoice(state);
      await walk.capture(page, "reload-invoice");
      const seen = hashesSince(api, from);
      const others = seen.filter((value) => value !== hash);
      at.stage = "the paid screen after a reload";
      await target.wallet.settle(hash);
      const ms = await paidOnScreen(page, PAID_TIMEOUT_MS);
      outcome.record(
        IDS.reload,
        others.length === 0 && ms !== undefined,
        [
          others.length === 0
            ? "the reload showed the same invoice"
            : `the reload brought ${others.length} other invoice(s)`,
          ms === undefined
            ? `not paid ${PAID_TIMEOUT_MS / 1000} s after settle`
            : `paid in ${ms} ms`,
        ].join("; "),
      );
    },
    undefined,
    shared,
  );
}

/** The same order open in two tabs: pay in one, and the other must find out. */
function twoTabsJourney(browser: Browser, target: PayerTarget, walk: Walk, shared: string[]) {
  return journey(
    browser,
    walk,
    "tabs",
    [
      {
        id: IDS.tabs,
        summary:
          "With the order open in two tabs, both show the same invoice and both reach paid without a reload.",
      },
    ],
    async (state, outcome, at) => {
      const { page, errors } = state;
      const { hash, url, reopen } = await toInvoice(target, state, at);
      at.stage = "the second tab";
      const api2: ApiCall[] = [];
      const second = await page.context().newPage();
      watchPage(second, api2, errors);
      await gotoPage(second, url);
      await reopen?.(second);
      await checkoutRendered(second);
      const other = await lightningInvoice({ page: second, api: api2, errors });
      at.stage = "both tabs paid";
      await target.wallet.settle(hash);
      const [first, next] = await Promise.all([
        paidOnScreen(page, PAID_TIMEOUT_MS),
        paidOnScreen(second, PAID_TIMEOUT_MS),
      ]);
      await walk.capture(second, "tabs-second-paid").catch(() => undefined);
      outcome.record(
        IDS.tabs,
        other.hash === hash && first !== undefined && next !== undefined,
        [
          other.hash === hash
            ? "both tabs held one invoice"
            : "the second tab minted another invoice",
          `tab one ${first === undefined ? "never paid" : `paid in ${first} ms`}`,
          `tab two ${next === undefined ? "never paid" : `paid in ${next} ms`}`,
        ].join("; "),
      );
    },
    undefined,
    shared,
  );
}

/** After paying: the back button, a reopened link, and the same link on another device. */
function afterPaidJourney(browser: Browser, target: PayerTarget, walk: Walk, shared: string[]) {
  return journey(
    browser,
    walk,
    "after-paid",
    [
      {
        id: IDS.back,
        summary: "Going back and forward after paying, or reloading, never offers to pay again.",
      },
      {
        id: IDS.reopen,
        summary: "The paid order opened again in the same browser shows that it is paid.",
      },
      {
        id: IDS.otherBrowser,
        summary:
          "The paid order's link opened in another browser is refused or shows that it is paid, and never offers to pay (#122).",
      },
    ],
    async (state, outcome, at) => {
      const { page, api } = state;
      const { url, paidUrl } = await toPaid(target, state, at);
      const from = api.length;
      at.stage = "the back button";
      const notes: string[] = [];
      let offered = false;
      await page
        .goBack({ waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS })
        .catch(() => null);
      await page
        .goForward({ waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS })
        .catch(() => null);
      await settledScreen(page);
      if (await offersPayment(page)) {
        offered = true;
        notes.push("back and forward offered to pay");
      }
      at.stage = "a reload of the paid page";
      await reloadPage(page);
      await settledScreen(page);
      if (await offersPayment(page)) {
        offered = true;
        notes.push("a reload offered to pay");
      }
      outcome.record(
        IDS.back,
        !offered,
        notes.join("; ") ||
          `no offer to pay: ${oneLine(await page.locator("body").innerText(), 120)}`,
      );

      at.stage = "the order reopened";
      const again = await page.context().newPage();
      await gotoPage(again, paidUrl);
      await settledScreen(again);
      const reopened = await readCheckout(again);
      const payable = await offersPayment(again);
      // The shop's own page may say it: a receipt can be only collapsed details.
      const says = saysPaid(reopened.text) || saysPaid(reopened.page);
      await walk.capture(again, "after-paid-reopened").catch(() => undefined);
      outcome.record(
        IDS.reopen,
        !payable && says,
        payable
          ? `the checkout offered to pay again: ${oneLine(reopened.text, 200)}`
          : says
            ? "shows paid"
            : `no word of the payment: ${oneLine(reopened.present ? reopened.text : reopened.page, 200)}`,
      );

      at.stage = "the order in another browser";
      const elsewhere = await browser.newContext({
        viewport: { width: 1280, height: 900 },
      });
      try {
        const stranger = await elsewhere.newPage();
        const answer = await gotoPage(stranger, url);
        await settledScreen(stranger);
        const offeredThere = await offersPayment(stranger);
        const view = await readCheckout(stranger);
        await walk.capture(stranger, "after-paid-other-browser").catch(() => undefined);
        outcome.record(
          IDS.otherBrowser,
          !offeredThere,
          offeredThere
            ? `another browser was offered to pay: ${oneLine(view.text, 200)}`
            : `answered ${answer?.status() ?? 0}: ${oneLine(view.present ? view.text : view.page, 160)}`,
        );
      } finally {
        await elsewhere.close().catch(() => undefined);
      }
      const minted = api.slice(from).filter((call) => call.method === "POST" && call.status < 300);
      if (minted.some((call) => /\/checkouts\/?$/.test(call.path))) {
        throw new Error(`a paid order minted again: ${describeCall(minted[0])}`);
      }
    },
    undefined,
    shared,
  );
}

/** Signal drops while the payer waits and the payment lands meanwhile. */
function offlineJourney(browser: Browser, target: PayerTarget, walk: Walk, shared: string[]) {
  return journey(
    browser,
    walk,
    "offline",
    [
      {
        id: IDS.offline,
        summary:
          "The network dropped while the payer waited and the payment landed meanwhile: once back online the paid screen arrived, with no reload and no developer words.",
      },
    ],
    async (state, outcome, at) => {
      const { page } = state;
      const checksDone = trackPaymentChecks(page);
      const { hash } = await toInvoice(target, state, at);
      at.stage = "the outage";
      await page.context().setOffline(true);
      await checksDone();
      await target.wallet.settle(hash);
      await page.waitForTimeout(OFFLINE_MS);
      const during = await walk.capture(page, "offline-during");
      await page.context().setOffline(false);
      at.stage = "the paid screen after the outage";
      const ms = await paidOnScreen(page, PAID_BUDGET_MS * 2);
      const banned = bannedPayerWordsInContext(during.text);
      await walk.capture(page, "offline-after").catch(() => undefined);
      outcome.record(
        IDS.offline,
        ms !== undefined && banned.length === 0,
        [
          ms === undefined
            ? `not paid ${(PAID_BUDGET_MS * 2) / 1000} s after coming back`
            : `paid ${ms} ms after coming back`,
          ...banned,
        ].join("; "),
      );
    },
    undefined,
    shared,
  );
}

/**
 * A background tab on a phone: hidden, and its timers held until it returns.
 * Installed before the page loads. Chromium's Page.setWebLifecycleState is the
 * obvious tool and does not stop timers in a headless browser, so the page's
 * own timers are gated instead; a callback that came due fires on return, as
 * a real browser fires it.
 */
const APP_SWITCH = String.raw`(() => {
  const setT = window.setTimeout.bind(window);
  const clearT = window.clearTimeout.bind(window);
  const setI = window.setInterval.bind(window);
  const clearI = window.clearInterval.bind(window);
  let away = false;
  const due = new Map();
  const missed = new Map();
  window.setTimeout = (fn, ms, ...args) => {
    let id;
    const run = () => {
      if (away) { due.set(id, run); return; }
      due.delete(id);
      if (typeof fn === "function") fn(...args);
    };
    id = setT(run, ms);
    return id;
  };
  window.clearTimeout = (id) => { due.delete(id); clearT(id); };
  window.setInterval = (fn, ms, ...args) => {
    let id;
    const run = () => {
      if (away) { missed.set(id, run); return; }
      if (typeof fn === "function") fn(...args);
    };
    id = setI(run, ms);
    return id;
  };
  window.clearInterval = (id) => { missed.delete(id); clearI(id); };
  const visibility = (hidden) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (hidden ? "hidden" : "visible"),
    });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  window.__openreceiveAppSwitch = (leaving) => {
    if (leaving) { visibility(true); away = true; return; }
    away = false;
    visibility(false);
    const late = [...due.values(), ...missed.values()];
    due.clear();
    missed.clear();
    for (const run of late) run();
  };
})()`;

/** The phone's trip to the wallet app, and how fast the page catches up on return. */
function walletAppJourney(browser: Browser, target: PayerTarget, walk: Walk, shared: string[]) {
  return journey(
    browser,
    walk,
    "wallet-app",
    [
      {
        id: IDS.wallet,
        summary: `The payer left for their wallet app (the tab hidden, its timers stopped) and paid: within ${PAID_BUDGET_MS / 1000} s of returning, the paid screen was up.`,
      },
    ],
    async (state, outcome, at) => {
      const { page } = state;
      await page.addInitScript(APP_SWITCH);
      const checksDone = trackPaymentChecks(page);
      const { hash } = await toInvoice(target, state, at);
      at.stage = "the tab going to sleep";
      await page.evaluate("window.__openreceiveAppSwitch(true)");
      await checksDone();
      let reloaded = false;
      const onNavigated = (frame: Frame) => {
        if (frame === page.mainFrame()) reloaded = true;
      };
      page.on("framenavigated", onNavigated);
      await target.wallet.settle(hash);
      await new Promise((resolve) => setTimeout(resolve, IN_WALLET_MS));
      const asleep = await readCheckout(page);
      at.stage = "the payer's return";
      page.off("framenavigated", onNavigated);
      if (saysPaid(asleep.text)) {
        // A dev server can reload the tab, which starts its timers again: the
        // payer still sees paid, but the return itself went untested.
        outcome.record(
          IDS.wallet,
          reloaded,
          reloaded
            ? "the page reloaded itself while hidden and then showed paid, so the return went untested"
            : "the page moved on while its timers were stopped",
        );
        return;
      }
      await page.evaluate("window.__openreceiveAppSwitch(false)");
      const ms = await paidOnScreen(page, PAID_TIMEOUT_MS);
      await walk.capture(page, "wallet-app-return").catch(() => undefined);
      outcome.record(
        IDS.wallet,
        ms !== undefined && ms <= PAID_BUDGET_MS,
        ms === undefined
          ? `not paid ${PAID_TIMEOUT_MS / 1000} s after returning`
          : `paid ${ms} ms after returning`,
      );
    },
    undefined,
    shared,
  );
}

/**
 * A Lightning invoice opened, the payer switched to a swap, and both got paid.
 * The order must end paid with no error and no offer to pay again. Whether the
 * swap screen learns of the Lightning payment is reported apart, as polish: it
 * polls only its own invoice, and telling it needs a change to the wire format.
 */
function doublePaymentJourney(browser: Browser, target: PayerTarget, walk: Walk, shared: string[]) {
  return journey(
    browser,
    walk,
    "double-pay",
    [
      {
        id: IDS.double,
        summary:
          "A payer opened a Lightning invoice, switched to a swap, and both got paid: the order shows paid, offers no further payment, and no request failed.",
      },
      {
        id: IDS.sees,
        severity: "polish",
        summary:
          "While the payer looks at the swap's deposit screen, a payment of the earlier Lightning invoice reaches that screen.",
      },
    ],
    async (state, outcome, at) => {
      const { page, api } = state;
      const { hash } = await toInvoice(target, state, at, SWAP_PRODUCT);
      at.stage = "Switch payment method";
      await page
        .getByRole("button", { name: /switch payment method/i })
        .first()
        .click();
      await bitcoinTile(page).first().waitFor({ state: "visible", timeout: PAGE_TIMEOUT_MS });
      at.stage = "the swap";
      await chooseSwap(page);
      const from = api.length;
      await continueButton(page).first().click();
      const created = await waitFor(async () => {
        const call = lastCall(api, CREATE_SWAP, from);
        return call?.body !== undefined ? call : undefined;
      }, SWAP_TIMEOUT_MS);
      const swapHash = hashOf(created?.body);
      const swapInvoice = created?.body?.match(/"bolt11"\s*:\s*"(ln[a-z0-9]+)"/i)?.[1];
      if (created === undefined || swapHash === undefined || swapInvoice === undefined) {
        throw new Error(`no swap to pay: ${describeCall(created)}`);
      }
      if (swapHash === hash) throw new Error("the swap reused the Lightning invoice");
      at.stage = "the Lightning payment";
      await target.wallet.settle(hash);
      const seen = await paidOnScreen(page, SIBLING_SEEN_MS);
      await walk.capture(page, "double-pay-lightning-landed").catch(() => undefined);
      outcome.record(
        IDS.sees,
        seen !== undefined,
        seen === undefined
          ? `the deposit screen still waits ${SIBLING_SEEN_MS / 1000} s after the Lightning invoice was paid`
          : `paid on the swap's screen in ${seen} ms`,
      );
      at.stage = "the swap landing too";
      await target.wallet.completeSwap(swapInvoice);
      await target.wallet.settle(swapHash);
      await page.waitForTimeout(8_000);
      await gotoPage(page, await settledUrl(page));
      await settledScreen(page);
      await walk.capture(page, "double-pay-after").catch(() => undefined);
      const view = await readCheckout(page);
      const offered = await offersPayment(page);
      const says = saysPaid(view.text) || saysPaid(view.page);
      const failed = serverErrors(api);
      outcome.record(
        IDS.double,
        says && !offered && failed.length === 0,
        [
          says ? "the order shows paid" : `no word of the payment: ${oneLine(view.text, 160)}`,
          ...(offered ? [`and offers to pay again: ${oneLine(view.text, 160)}`] : []),
          ...failed.map((call) => describeCall(call)),
        ].join("; "),
      );
    },
    undefined,
    shared,
  );
}

// ------------------------------------------------------------------- the phone

// A function: payer.ts and this module import each other, so PAGE_HELPERS is not
// ready while this file loads.
const overflowScript = (): string => String.raw`(() => {
  ${PAGE_HELPERS}
  const width = document.documentElement.clientWidth;
  const over = [];
  for (const root of checkoutRoots()) {
    for (const el of [root, ...everyElement(root)]) {
      if (!visible(el)) continue;
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.right > width + 1 || box.left < -1) {
        over.push(el.localName + (el.className && typeof el.className === "string" ? "." + el.className.split(/\s+/)[0] : "") + " " + Math.round(box.left) + ".." + Math.round(box.right));
      }
    }
  }
  return { width, over: over.slice(0, 4), count: over.length };
})()`;

async function overflow(page: Page, screen: string): Promise<string[]> {
  // A paid checkout can hand over to the host's receipt mid-measure, which
  // destroys the page being read, so read again on whatever page came next.
  const found = await waitFor(
    () => page.evaluate<{ width: number; over: string[]; count: number }>(overflowScript()),
    15_000,
    300,
  );
  if (found === undefined) return [`${screen}: the page could not be measured`];
  return found.count === 0
    ? []
    : [
        `${screen}: ${found.count} element(s) past the ${found.width} px screen: ${found.over.join(", ")}`,
      ];
}

const phoneOptions = (extra: BrowserContextOptions = {}): BrowserContextOptions => ({
  viewport: { ...NARROW_PHONE },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  ...extra,
});

/** The wallet list's first walkthrough button, or undefined on a checkout with no wallet list. */
async function tutorialOpener(page: Page): Promise<Locator | undefined> {
  const opener = page.getByRole("button", { name: /how to pay/i }).filter({ visible: true });
  const found = await waitFor(
    async () => ((await opener.count()) > 0 ? true : undefined),
    WALLET_LIST_WAIT_MS,
  );
  return found === undefined ? undefined : opener.first();
}

const dialogOf = (page: Page): Locator =>
  page.getByRole("dialog").filter({ visible: true }).first();
const copyButton = (root: Page | Locator): Locator =>
  root
    .getByRole("button", { name: /copy invoice|copied/i })
    .filter({ visible: true })
    .first();

/** A payer on a small phone, from the picker through a wallet's walkthrough to paid. */
function phoneJourney(browser: Browser, target: PayerTarget, walk: Walk, shared: string[]) {
  return journey(
    browser,
    walk,
    "phone",
    [
      {
        id: IDS.fits,
        summary: `On a ${NARROW_PHONE.width} px phone, every checkout screen fits with nothing cut off.`,
      },
      {
        id: IDS.tap,
        summary: `On that phone, Copy invoice is at least ${MIN_TAP_PX} px tall, a comfortable tap.`,
      },
      { id: IDS.phonePaid, summary: "On that phone, the paid screen arrives." },
    ],
    async (state, outcome, at) => {
      const { page } = state;
      const problems: string[] = [];
      at.stage = "the shop's order page";
      await order(target, page, PRODUCT);
      at.stage = "the checkout's first screen";
      const first = await checkoutRendered(page);
      if (first === "error") throw new Error("the checkout opened on an error");
      problems.push(...(await overflow(page, "the picker")));
      await walk.capture(page, "phone-picker");
      at.stage = "the Lightning invoice";
      const { hash } = await lightningInvoice(state);
      problems.push(...(await overflow(page, "the invoice")));
      await walk.capture(page, "phone-invoice");
      const copy = copyButton(page);
      const box = (await copy.count()) === 0 ? null : await copy.boundingBox();
      outcome.record(
        IDS.tap,
        box !== null && Math.round(box.height) >= MIN_TAP_PX,
        box === null
          ? "no Copy invoice button on the invoice screen"
          : `${Math.round(box.height)} px tall`,
      );
      at.stage = "the paid screen";
      await target.wallet.settle(hash);
      const ms = await paidOnScreen(page, PAID_TIMEOUT_MS);
      if (ms !== undefined) {
        problems.push(...(await overflow(page, "the paid screen")));
        await walk.capture(page, "phone-paid");
      }
      outcome.record(
        IDS.phonePaid,
        ms !== undefined,
        ms === undefined ? `not paid ${PAID_TIMEOUT_MS / 1000} s after settle` : `paid in ${ms} ms`,
      );
      outcome.record(IDS.fits, problems.length === 0, problems.join("\n") || "every screen fits");
    },
    phoneOptions(),
    shared,
  );
}

/**
 * The walkthrough a phone payer follows: Copy invoice, then the wallet's own
 * steps. A checkout with no wallet list is left out rather than passed.
 */
async function tutorialJourney(
  browser: Browser,
  target: PayerTarget,
  walk: Walk,
  shared: string[],
): Promise<Check[]> {
  let absent = false;
  const checks = await journey(
    browser,
    walk,
    "tutorial",
    [
      {
        id: IDS.tutorial,
        summary:
          "A wallet's walkthrough copies the exact invoice, shows its steps and pictures in the payer's words, and closes back to the invoice.",
      },
    ],
    async (state, outcome, at) => {
      const { page } = state;
      const { bolt11 } = await toInvoice(target, state, at);
      at.stage = "the wallet list";
      const opener = await tutorialOpener(page);
      if (opener === undefined) {
        absent = true;
        return;
      }
      at.stage = "the walkthrough";
      await opener.click();
      const dialog = dialogOf(page);
      await dialog.waitFor({ state: "visible", timeout: PAGE_TIMEOUT_MS });
      const notes: string[] = [];
      let good = true;
      const copy = copyButton(dialog);
      await copy.click();
      const clipboard = await waitFor(async () => {
        const text = await page.evaluate<string>("navigator.clipboard.readText()");
        return text.trim() === "" ? undefined : text;
      }, 5_000);
      if (clipboard === undefined || !sameInvoice(clipboard, bolt11)) {
        good = false;
        notes.push(
          clipboard === undefined
            ? "nothing reached the clipboard"
            : `the clipboard holds ${clipboard.slice(0, 40)}…, not the invoice`,
        );
      }
      await walk.capture(page, "tutorial-copied");
      at.stage = "the walkthrough's pictures";
      const images = await waitFor(
        async () => {
          const found = await dialog
            .locator("ol img")
            .evaluateAll((nodes) => nodes.map((node) => (node as HTMLImageElement).naturalWidth));
          return found.length > 0 && found.every((width) => width > 0) ? found.length : undefined;
        },
        10_000,
        300,
      );
      if (images === undefined) {
        good = false;
        notes.push("the steps' pictures did not load");
      } else {
        notes.push(`${images} picture(s) loaded`);
      }
      const banned = bannedPayerWordsInContext(await dialog.innerText());
      if (banned.length > 0) {
        good = false;
        notes.push(...banned);
      }
      at.stage = "Done";
      await dialog.getByRole("button", { name: /^done$/i }).click({ timeout: PAGE_TIMEOUT_MS });
      await page.getByRole("dialog").filter({ visible: true }).first().waitFor({
        state: "hidden",
        timeout: PAGE_TIMEOUT_MS,
      });
      if ((await invoiceQr(page).count()) === 0) {
        good = false;
        notes.push("after Done the invoice was gone");
      }
      outcome.record(IDS.tutorial, good, notes.join("; "));
    },
    phoneOptions({ permissions: ["clipboard-read", "clipboard-write"] }),
    shared,
  );
  return absent ? [] : checks;
}

/**
 * Some browsers refuse the clipboard. The walkthrough locks its steps until a
 * copy has worked, so a refusal must not be the end of the road. Whether the
 * payer then gets the steps anyway is still the maintainer's design call, so
 * this reports rather than blocks.
 */
async function copyRefusedJourney(
  browser: Browser,
  target: PayerTarget,
  walk: Walk,
  shared: string[],
): Promise<Check[]> {
  let absent = false;
  const checks = await journey(
    browser,
    walk,
    "copy-refused",
    [
      {
        id: IDS.refused,
        summary:
          "When the browser refuses the clipboard, the steps still open and the invoice is there to copy by hand.",
      },
    ],
    async (state, outcome, at) => {
      const { page } = state;
      await page.addInitScript(
        `navigator.clipboard.writeText = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
         document.execCommand = () => false;`,
      );
      await toInvoice(target, state, at);
      at.stage = "the wallet list";
      const opener = await tutorialOpener(page);
      if (opener === undefined) {
        absent = true;
        return;
      }
      await opener.click();
      const dialog = dialogOf(page);
      await dialog.waitFor({ state: "visible", timeout: PAGE_TIMEOUT_MS });
      at.stage = "the refused copy";
      await copyButton(dialog).click();
      await page.waitForTimeout(1_500);
      await walk.capture(page, "tutorial-copy-refused");
      const done = await dialog.getByRole("button", { name: /^done$/i }).count();
      const images = await dialog.locator("ol img").count();
      const invoice = await dialog
        .locator("ol input[readonly]")
        .first()
        .inputValue()
        .catch(() => "");
      const text = oneLine(await dialog.innerText(), 220);
      const wayOn = (done > 0 || images > 0) && /^ln/i.test(invoice);
      outcome.record(
        IDS.refused,
        wayOn,
        wayOn
          ? "the steps opened and the invoice is there to copy by hand"
          : `the payer has no way on: ${text}`,
      );
    },
    phoneOptions(),
    shared,
  );
  return absent ? [] : checks;
}

// ------------------------------------------------------------------- Safari

/** Safari's engine: most phone payers are on it, and everything else here is Chromium. */
/** Whether a shop's session cookie is Secure, as Chromium stores it on plain http and WebKit will not. */
async function sessionCookieIsSecure(chromium: Browser, target: PayerTarget): Promise<boolean> {
  const context = await chromium.newContext();
  try {
    await order(target, await context.newPage(), PRODUCT);
    return (await context.cookies()).some((cookie) => cookie.secure);
  } catch {
    return false;
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function safariJourney(
  chromium: Browser,
  target: PayerTarget,
  walk: Walk,
  shared: string[],
): Promise<Check[]> {
  const spec = {
    id: IDS.safari,
    summary: "In Safari's engine, on a phone, the invoice shows and the paid screen arrives.",
  };
  let browser: Browser;
  try {
    browser = await startWebkit();
  } catch (error) {
    return [
      {
        ...spec,
        severity: "polish",
        pass: false,
        evidence: `WebKit did not start: ${message(error)}`,
      },
    ];
  }
  try {
    const checks = await journey(
      browser,
      walk,
      "safari",
      [spec],
      async (state, outcome, at) => {
        const { ms } = await toPaid(target, state, at);
        await walk.capture(state.page, "safari-paid");
        outcome.record(IDS.safari, true, `paid in ${ms} ms`);
      },
      phoneOptions(),
      shared,
    );
    // WebKit keeps no Secure cookie on plain http, which a trial shop is, so
    // a session the agent marked Secure (right for a real site) cannot last.
    const untestable =
      checks.some((item) => !item.pass) &&
      target.baseUrl.startsWith("http:") &&
      (await sessionCookieIsSecure(chromium, target));
    return untestable
      ? checks.map((item) =>
          item.pass
            ? item
            : {
                ...item,
                severity: "polish",
                evidence: `not testable here: the shop's session cookie is Secure and this trial is plain http; ${item.evidence ?? ""}`,
              },
        )
      : checks;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------- other browsers' habits

/**
 * What Chrome's translate does to a page: each text node becomes two nested
 * <font> elements. A renderer that later removes the text node it remembers
 * throws, and React's error takes the whole checkout down with it.
 */
const translateScript = (): string => String.raw`(() => {
  ${PAGE_HELPERS}
  let wrapped = 0;
  for (const root of checkoutRoots()) {
    const texts = [];
    const collect = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (child.data.trim() !== "" && !["STYLE", "SCRIPT"].includes(child.parentNode.nodeName)) texts.push(child);
        } else if (child.nodeType === Node.ELEMENT_NODE && child.localName !== "font") {
          collect(child);
          if (child.shadowRoot) collect(child.shadowRoot);
        }
      }
    };
    if (root.shadowRoot) collect(root.shadowRoot);
    collect(root);
    for (const text of texts) {
      const outer = document.createElement("font");
      outer.style.verticalAlign = "inherit";
      const inner = outer.appendChild(document.createElement("font"));
      inner.style.verticalAlign = "inherit";
      inner.textContent = text.data;
      text.replaceWith(outer);
      wrapped += 1;
    }
  }
  return wrapped;
})()`;

function translatedJourney(browser: Browser, target: PayerTarget, walk: Walk, shared: string[]) {
  return journey(
    browser,
    walk,
    "translated",
    [
      {
        id: IDS.translated,
        summary:
          "With the page machine-translated (every text wrapped in <font>, as Chrome does), the payer still gets an invoice and the paid screen, with no script error.",
      },
    ],
    async (state, outcome, at) => {
      const { page } = state;
      at.stage = "the shop's order page";
      await order(target, page, PRODUCT);
      at.stage = "the checkout's first screen";
      if ((await checkoutRendered(page)) === "error") {
        throw new Error("the checkout opened on an error");
      }
      const first = await page.evaluate<number>(translateScript());
      at.stage = "the Lightning invoice, translated";
      const { hash } = await lightningInvoice(state);
      const second = await page.evaluate<number>(translateScript());
      await walk.capture(page, "translated-invoice");
      at.stage = "the paid screen, translated";
      await target.wallet.settle(hash);
      const ms = await paidOnScreen(page, PAID_TIMEOUT_MS);
      await walk.capture(page, "translated-paid").catch(() => undefined);
      outcome.record(
        IDS.translated,
        ms !== undefined && state.errors.length === 0,
        [
          `${first + second} text nodes wrapped`,
          ms === undefined
            ? `not paid ${PAID_TIMEOUT_MS / 1000} s after settle`
            : `paid in ${ms} ms`,
          ...state.errors,
        ].join("; "),
      );
    },
    undefined,
    shared,
  );
}

const ACTIVE_TEXT = `(() => {
  let active = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  return active ? (active.getAttribute("aria-label") || active.innerText || active.textContent || "").trim() : "";
})()`;

async function tabUntil(page: Page, wanted: RegExp, tries = 60): Promise<boolean> {
  for (let press = 0; press < tries; press += 1) {
    await page.keyboard.press("Tab");
    if (wanted.test(await page.evaluate<string>(ACTIVE_TEXT))) return true;
  }
  return false;
}

/** Someone who cannot use a mouse: Tab to Bitcoin, Enter, Tab to Copy invoice. */
function keyboardJourney(browser: Browser, target: PayerTarget, walk: Walk, shared: string[]) {
  return journey(
    browser,
    walk,
    "keyboard",
    [
      {
        id: IDS.keyboard,
        severity: "polish",
        summary:
          "With only Tab and Enter, a payer reaches Bitcoin, gets the invoice and reaches Copy invoice.",
      },
    ],
    async (state, outcome, at) => {
      const { page } = state;
      await order(target, page, PRODUCT);
      at.stage = "the checkout's first screen";
      const first = await checkoutRendered(page);
      if (first === "error") throw new Error("the checkout opened on an error");
      if (first === "picker") {
        at.stage = "Tab to Bitcoin";
        if (!(await tabUntil(page, /^bitcoin/i))) {
          outcome.record(IDS.keyboard, false, "Tab never reached the Bitcoin choice");
          return;
        }
        await page.keyboard.press("Enter");
      }
      at.stage = "the invoice by keyboard";
      await invoiceQr(page).first().waitFor({ state: "visible", timeout: PAGE_TIMEOUT_MS });
      const copy = await tabUntil(page, /copy invoice/i);
      outcome.record(
        IDS.keyboard,
        copy,
        copy ? "reached Bitcoin and Copy invoice by keyboard" : "Tab never reached Copy invoice",
      );
    },
    undefined,
    shared,
  );
}

interface AxeHit {
  readonly rule: string;
  readonly impact: string;
  readonly count: number;
  readonly example: string;
}

/** axe-core over the page, kept to what sits inside the checkout: the shop's own page is its business. */
async function axeOnCheckout(page: Page): Promise<AxeHit[]> {
  const { createRequire } = await import("node:module");
  await page.addScriptTag({ path: createRequire(import.meta.url).resolve("axe-core/axe.min.js") });
  return page.evaluate<AxeHit[]>(String.raw`(async () => {
    ${PAGE_HELPERS}
    const roots = checkoutRoots();
    const inside = (node) => {
      const first = Array.isArray(node.target) ? node.target[0] : node.target;
      const element = typeof first === "string" ? document.querySelector(first) : null;
      return element !== null && roots.some((root) => root === element || root.contains(element));
    };
    const result = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
      resultTypes: ["violations"],
    });
    return result.violations
      .filter((violation) => ["serious", "critical"].includes(violation.impact))
      .map((violation) => {
        const nodes = violation.nodes.filter(inside);
        return {
          rule: violation.id,
          impact: violation.impact,
          count: nodes.length,
          example: nodes[0] ? String(nodes[0].html).slice(0, 140) : "",
        };
      })
      .filter((hit) => hit.count > 0);
  })()`);
}

const describeAxe = (screen: string, hits: readonly AxeHit[]): string[] =>
  hits.map((hit) => `${screen}: ${hit.impact} ${hit.rule} x${hit.count}: ${hit.example}`);

/** The checkout's own accessibility, on the picker, the invoice and the paid screen. */
function accessibilityJourney(browser: Browser, target: PayerTarget, walk: Walk, shared: string[]) {
  return journey(
    browser,
    walk,
    "axe",
    [
      {
        id: IDS.axe,
        severity: "polish",
        summary:
          "axe-core finds no serious WCAG 2 A or AA problem inside the checkout, on any screen.",
      },
    ],
    async (state, outcome, at) => {
      const { page } = state;
      const found: string[] = [];
      await order(target, page, PRODUCT);
      at.stage = "the checkout's first screen";
      if ((await checkoutRendered(page)) === "picker") {
        found.push(...describeAxe("the picker", await axeOnCheckout(page)));
      }
      at.stage = "the invoice";
      const { hash } = await lightningInvoice(state);
      found.push(...describeAxe("the invoice", await axeOnCheckout(page)));
      at.stage = "the paid screen";
      await target.wallet.settle(hash);
      if ((await paidOnScreen(page, PAID_TIMEOUT_MS)) !== undefined) {
        found.push(...describeAxe("the paid screen", await axeOnCheckout(page)));
      }
      outcome.record(
        IDS.axe,
        found.length === 0,
        found.join("\n") || "no serious problem on any screen",
      );
    },
    undefined,
    shared,
  );
}

/** A dark phone in a right-to-left language. */
function darkRtlJourney(browser: Browser, target: PayerTarget, walk: Walk, shared: string[]) {
  return journey(
    browser,
    walk,
    "dark-rtl",
    [
      {
        id: IDS.rtl,
        severity: "polish",
        summary: `On a dark ${NARROW_PHONE.width} px phone with a right-to-left page, the checkout fits and its contrast holds.`,
      },
    ],
    async (state, outcome, at) => {
      const { page } = state;
      await page.addInitScript(
        `addEventListener("DOMContentLoaded", () => document.documentElement.setAttribute("dir", "rtl"));`,
      );
      const problems: string[] = [];
      await order(target, page, PRODUCT);
      at.stage = "the checkout's first screen";
      if ((await checkoutRendered(page)) === "error") {
        throw new Error("the checkout opened on an error");
      }
      problems.push(...(await overflow(page, "the picker")));
      at.stage = "the invoice";
      await lightningInvoice(state);
      problems.push(...(await overflow(page, "the invoice")));
      await walk.capture(page, "dark-rtl-invoice");
      problems.push(
        ...describeAxe(
          "the invoice",
          (await axeOnCheckout(page)).filter((hit) => hit.rule === "color-contrast"),
        ),
      );
      outcome.record(IDS.rtl, problems.length === 0, problems.join("\n") || "fits, and readable");
    },
    phoneOptions({ colorScheme: "dark", reducedMotion: "reduce" }),
    shared,
  );
}

// --------------------------------------------------------------------- entry

/** Every journey after the first payment. Each failure leaves the others to run. */
export async function journeyChecks(
  browser: Browser,
  target: PayerTarget,
  walk: Walk,
): Promise<Check[]> {
  await mkdir(walk.dir, { recursive: true });
  const shared: string[] = [];
  const checks: Check[] = [];
  checks.push(...(await reloadJourney(browser, target, walk, shared)));
  checks.push(...(await twoTabsJourney(browser, target, walk, shared)));
  checks.push(...(await afterPaidJourney(browser, target, walk, shared)));
  checks.push(...(await offlineJourney(browser, target, walk, shared)));
  checks.push(...(await walletAppJourney(browser, target, walk, shared)));
  if (target.swaps !== false) {
    checks.push(...(await doublePaymentJourney(browser, target, walk, shared)));
  }
  checks.push(...(await phoneJourney(browser, target, walk, shared)));
  checks.push(...(await tutorialJourney(browser, target, walk, shared)));
  checks.push(...(await copyRefusedJourney(browser, target, walk, shared)));
  checks.push(...(await safariJourney(browser, target, walk, shared)));
  checks.push(...(await translatedJourney(browser, target, walk, shared)));
  checks.push(...(await keyboardJourney(browser, target, walk, shared)));
  checks.push(...(await accessibilityJourney(browser, target, walk, shared)));
  checks.push(...(await darkRtlJourney(browser, target, walk, shared)));
  checks.push({
    id: IDS.scripts,
    severity: "polish",
    pass: shared.length === 0,
    summary: "No checkout page threw a script error during the journeys.",
    evidence: shared.join("\n") || undefined,
  });
  return checks;
}
