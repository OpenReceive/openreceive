import type { Page } from "@playwright/test";
import {
  type ChaosBuyer,
  clientPrefix,
  InterceptorControl,
  MEASURED_HANDSHAKES_MS,
} from "./chaos.ts";
import { check } from "./live.ts";
import type { Check } from "./types.ts";
import type { TrialInterceptor } from "./wallet.ts";
import { wpEval } from "./wordpress.ts";

// The Save button in wp-admin, in a real browser. Agents configure a store
// with WP-CLI, so nobody but a video ever pressed it, and the 2026-11-07 video
// showed Save refusing good codes (fix 2daa5167): the wallet check inside Save
// goes through the relay, and a relay that was only slow read as wrong codes.
// With the relay's handshakes delayed to the slowest measured, Save must
// succeed; with the relay silent, the message must blame the relay, not the
// codes, and the codes must still be there.

const RELAY = "relay-nwc.rizful.com";
const ADMIN_USER = "shop";
/** Seeded by every WordPress fixture (sandbox.ts). */
const ADMIN_PASSWORD = "widget-shop-local";
/** A save waits on the wallet's own timeouts; a real browser waits for it. */
const SAVE_TIMEOUT_MS = 120_000;
const SLOW_HANDSHAKE_MS = MEASURED_HANDSHAKES_MS[MEASURED_HANDSHAKES_MS.length - 1] ?? 3_240;

export type WordPressKind = "woocommerce" | "edd";

export interface WpAdminTarget {
  readonly kind: WordPressKind;
  readonly directory: string;
  readonly baseUrl: string;
  readonly nwc: string;
  readonly lsc?: string;
  readonly interceptor: TrialInterceptor;
  readonly newBuyer: () => Promise<ChaosBuyer>;
}

/** The plugin's settings page. WooCommerce's lives under its Payments tab, EDD's under its Gateways. */
export function settingsPath(kind: WordPressKind): string {
  return kind === "woocommerce"
    ? "/wp-admin/admin.php?page=wc-settings&tab=checkout&section=openreceive"
    : "/wp-admin/edit.php?post_type=download&page=edd-settings&tab=gateways&section=openreceive";
}

interface Form {
  readonly nwc: string;
  readonly lsc: string;
  readonly save: string;
}

function selectors(kind: WordPressKind): Form {
  return kind === "woocommerce"
    ? {
        nwc: 'input[name="woocommerce_openreceive_nwc_uri"]',
        lsc: 'input[name="woocommerce_openreceive_lsc_uri_primary"]',
        save: "button.woocommerce-save-button",
      }
    : {
        nwc: "input#openreceive_nwc_uri",
        lsc: "input#openreceive_lsc_uri_primary",
        save: "input#submit, button#submit",
      };
}

/** A notice that sends the merchant to look at their codes, whether or not the codes were checked. */
export function blamesTheCodes(text: string): boolean {
  return /check the (?:receive-only )?(?:nwc|code)|(?:not|isn['’]?t) a valid|invalid[^.]{0,30}code|wrong code|settings were not saved\. check|use a receive-only nwc/i.test(
    text,
  );
}

/** The wording Configuration::saveFailure gives a relay that did not answer. */
export function blamesTheRelay(text: string): boolean {
  return /relay did not answer/i.test(text);
}

/** Every admin notice on the page, each squeezed to one line. EDD reveals its notices from JavaScript. */
async function noticesOn(page: Page): Promise<string[]> {
  await page.waitForLoadState("load", { timeout: 30_000 }).catch(() => {});
  await page
    .waitForFunction(
      () => document.querySelectorAll(".notice.edd-hidden").length === 0,
      undefined,
      {
        timeout: 8_000,
      },
    )
    .catch(() => {});
  const texts = await page
    .locator(
      "#wpbody-content .notice, #wpbody-content .updated, #wpbody-content .error, #wpbody-content #message",
    )
    .filter({ visible: true })
    .allInnerTexts()
    .catch(() => [] as string[]);
  return texts.map((text) => text.replace(/\s+/g, " ").trim()).filter((text) => text.length > 0);
}

async function logIn(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/wp-login.php`, { waitUntil: "domcontentloaded" });
  await page.fill("#user_login", ADMIN_USER);
  await page.fill("#user_pass", ADMIN_PASSWORD);
  await Promise.all([
    page.waitForLoadState("domcontentloaded"),
    page.waitForURL(/\/wp-admin\//, { timeout: 60_000 }),
    page.click("#wp-submit"),
  ]);
}

/** Open the settings, type the codes as a merchant would, press Save, and read the notices. */
async function pressSave(page: Page, target: WpAdminTarget): Promise<string[]> {
  const form = selectors(target.kind);
  await page.goto(`${target.baseUrl}${settingsPath(target.kind)}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForSelector(form.nwc, { timeout: 30_000 });
  await page.fill(form.nwc, target.nwc);
  if (target.lsc !== undefined && (await page.locator(form.lsc).count()) > 0) {
    await page.fill(form.lsc, target.lsc);
  }
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: SAVE_TIMEOUT_MS }),
    page.click(form.save),
  ]);
  return noticesOn(page);
}

/** The stored settings, hashed: a save that failed must leave them byte for byte. */
async function storedSettings(directory: string): Promise<string> {
  return wpEval(
    directory,
    'echo "status=", hash("sha256", json_encode(get_option("woocommerce_openreceive_settings"))), "\\n";',
  );
}

function shown(notices: readonly string[]): string {
  return notices.length === 0 ? "no notice on the page" : notices.join(" | ");
}

/** Hash of the stored settings before and after a Save the relay never answered. */
export function codesKeptCheck(before: string, after: string): Check {
  return check(
    "wpadmin_codes_kept",
    before.length > 0 && before === after,
    "A Save the relay did not answer left the stored codes as they were.",
    before === after ? `settings hash ${before.slice(0, 12)}…` : "the stored settings changed",
  );
}

export function saveAcceptedCheck(notices: readonly string[]): Check {
  const failed = notices.filter((text) => /not saved|fail|error/i.test(text));
  const blamed = notices.some(blamesTheCodes);
  const saved = notices.some((text) =>
    /settings have been saved|settings updated|saved/i.test(text),
  );
  return check(
    "wpadmin_save_slow_relay",
    saved && failed.length === 0 && !blamed,
    `With the relay's handshake delayed to ${SLOW_HANDSHAKE_MS} ms, Save in wp-admin saved the codes and no message blamed them.`,
    shown(notices),
  );
}

export function saveRelaySilentCheck(notices: readonly string[]): Check {
  return check(
    "wpadmin_save_relay_silent",
    notices.some(blamesTheRelay) &&
      !notices.some(blamesTheCodes) &&
      !notices.some((text) => /settings have been saved|settings updated/i.test(text)),
    "With the relay silent, Save in wp-admin said only that the relay did not answer: it did not blame the codes or also say the settings saved.",
    shown(notices),
  );
}

async function checkoutWorks(id: string, summary: string, target: WpAdminTarget): Promise<Check> {
  const buyer = await target.newBuyer();
  let answer = await buyer.createOnce();
  // One retry as the checkout's Try again would: this step is about the Save.
  if (answer.status === 503) answer = await buyer.createOnce();
  return check(id, answer.status === 201, summary, `${answer.status} in ${answer.ms} ms`);
}

/**
 * Log in, Save with the relay slow, buy; Save with the relay silent, buy.
 * Each round's relay rule is cleared whatever happens, and a step that throws
 * is a failed check, so the next one still runs.
 */
export async function wpAdminSaveChecks(target: WpAdminTarget): Promise<Check[]> {
  const control = new InterceptorControl(
    target.interceptor.control,
    clientPrefix(target.directory),
  );
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  const checks: Check[] = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await logIn(page, target.baseUrl);

    try {
      await control.rule(RELAY, "pass", { delayMs: [SLOW_HANDSHAKE_MS] });
      await control.drop(RELAY);
      checks.push(saveAcceptedCheck(await pressSave(page, target)));
    } catch (error) {
      checks.push(check("wpadmin_save_slow_relay", false, "Save in wp-admin ran.", String(error)));
    } finally {
      await control.reset().catch(() => {});
    }
    checks.push(
      await checkoutWorks(
        "wpadmin_checkout_after_save",
        "After that Save, a buyer's checkout got an invoice.",
        target,
      ).catch((error: unknown) =>
        check("wpadmin_checkout_after_save", false, "A checkout ran after Save.", String(error)),
      ),
    );

    const before = await storedSettings(target.directory);
    try {
      await control.rule(RELAY, "silent");
      await control.drop(RELAY);
      checks.push(saveRelaySilentCheck(await pressSave(page, target)));
    } catch (error) {
      checks.push(
        check("wpadmin_save_relay_silent", false, "Save in wp-admin ran.", String(error)),
      );
    } finally {
      await control.reset().catch(() => {});
      await control.drop(RELAY).catch(() => {});
    }
    checks.push(codesKeptCheck(before, await storedSettings(target.directory)));
    checks.push(
      await checkoutWorks(
        "wpadmin_checkout_after_silent_save",
        "With the relay back, a checkout still got an invoice from the stored codes.",
        target,
      ).catch((error: unknown) =>
        check(
          "wpadmin_checkout_after_silent_save",
          false,
          "A checkout ran after the relay came back.",
          String(error),
        ),
      ),
    );
  } finally {
    await browser.close().catch(() => {});
  }
  return checks;
}
