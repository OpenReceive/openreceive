import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { compose, InfraError } from "./docker.ts";
import {
  type Answer,
  backToBackCheck,
  type CheckoutClient,
  check,
  type LiveOptions,
  paidChecks,
  SWAP_PRODUCT,
  swapOrderChecks,
} from "./live.ts";
import { parsePriceCents, type PlaceOrder } from "./payer.ts";
import { awaitedLater } from "./promises.ts";
import type { Check } from "./types.ts";

// The live checks for a HikaShop store on Joomla. The buyer is a signed-in
// Joomla customer in Chromium: they pick a size and colour of a garment from
// HikaShop's sample catalog, check out with the OpenReceive payment method,
// land on HikaShop's thank-you page and wait for its checkout to get a
// Lightning invoice. The rest of the checks call the plugin's routes (HikaShop's
// notify task, the route in `path=`) as that checkout does, from a page of the
// same session, with the Joomla form token the page carries.

const SERVICE = "joomla";
const PASSWORD = "widget-shop-local";
/** The buyer and a second customer, as Joomla users: username, name, email. */
const CUSTOMERS = [
  ["buyer", "OpenReceive Checkout Test", "info@openreceive.org"],
  ["stranger", "Other Customer", "stranger@example.test"],
] as const;
const BUYER = "buyer";
const STRANGER = "stranger";
/**
 * Products 1 and 2 (SWAP_PRODUCT): two garments of HikaShop's sample
 * catalog, SAMPLE-0005 and SAMPLE-0004, which seed.sql keeps in stock.
 */
const PRODUCTS = ["Heavyweight Pullover Hoodie", "Organic Cotton Pullover Hoodie"];

/**
 * HikaShop Starter, as hikashop.com serves it. The download address always
 * serves the latest release, so the file is pinned by its hash: a new
 * HikaShop release stops the trial here until the pin moves.
 */
const HIKASHOP_STARTER = {
  version: "6.8.2",
  url: "https://www.hikashop.com/component/updateme/download/level-starter.html?ext=zip",
  sha256: "61d256ac6cedefa94b4a27b1fb36bbe3decbbb2de0896b1a501c1c4b942a5b7a",
} as const;

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** HikaShop Starter's ZIP, downloaded once into the system temp folder and kept there. */
async function hikashopStarter(): Promise<string> {
  const directory = path.join(tmpdir(), "openreceive-trial-cache");
  const file = path.join(directory, `hikashop_starter-${HIKASHOP_STARTER.version}.zip`);
  const cached = await readFile(file).catch(() => undefined);
  if (cached !== undefined && sha256(cached) === HIKASHOP_STARTER.sha256) return file;
  const response = await fetch(HIKASHOP_STARTER.url);
  if (!response.ok) throw new InfraError(`${HIKASHOP_STARTER.url} answered ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const got = sha256(bytes);
  if (got !== HIKASHOP_STARTER.sha256) {
    throw new InfraError(
      `hikashop.com no longer serves HikaShop Starter ${HIKASHOP_STARTER.version} (sha256 ${got}); move the pin in trials/harness/hikashop.ts.`,
    );
  }
  await mkdir(directory, { recursive: true });
  const partial = `${file}.${process.pid}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, file);
  return file;
}

/** Joomla's console in the shop, as the web server's user, the way the directions run it. */
function joomla(directory: string, args: readonly string[]) {
  return compose(
    directory,
    ["exec", "-T", "-u", "www-data", SERVICE, "php", "cli/joomla.php", "--no-interaction", ...args],
    300_000,
  );
}

/**
 * The stock Joomla's shop, before the agent comes: HikaShop Starter
 * installed with Joomla's own console, HikaShop's setup assistant for the
 * shop's published address with its sample catalog, mail off so no order
 * email leaves the trial, two customers made with Joomla's console, and
 * then seed/seed.sql (a free shipping method, the customers' addresses, the
 * two garments kept in stock).
 */
export async function setupHikashop(
  directory: string,
  baseUrl: string,
  seedDir: string,
): Promise<void> {
  const zip = await hikashopStarter();
  await compose(directory, ["cp", zip, `${SERVICE}:/tmp/hikashop_starter.zip`], 60_000);
  await joomla(directory, ["extension:install", "--path=/tmp/hikashop_starter.zip"]);
  await compose(
    directory,
    ["exec", "-T", SERVICE, "rm", "-f", "/tmp/hikashop_starter.zip"],
    60_000,
  );
  await joomla(directory, [
    "hikashop:shop:setup",
    "--country=US",
    "--currency=USD",
    "--tax=none",
    "--sells=virtual",
    "--sample=cat",
    `--live-site=${baseUrl}/`,
  ]);
  await joomla(directory, ["config:set", "mailonline=false"]);
  for (const [username, name, email] of CUSTOMERS) {
    await joomla(directory, [
      "user:add",
      `--username=${username}`,
      `--name=${name}`,
      `--password=${PASSWORD}`,
      `--email=${email}`,
      "--usergroup=Registered",
    ]);
  }
  await compose(
    directory,
    ["cp", path.join(seedDir, "seed.sql"), "mariadb:/tmp/openreceive-trial-seed.sql"],
    60_000,
  );
  await compose(
    directory,
    [
      "exec",
      "-T",
      "mariadb",
      "sh",
      "-c",
      "mariadb -ujoomla -pjoomla-local joomla < /tmp/openreceive-trial-seed.sql && rm /tmp/openreceive-trial-seed.sql",
    ],
    120_000,
  );
}

/** The form token of a page's Joomla session, as Joomla gives every page's scripts. */
async function joomlaToken(page: Page): Promise<string | undefined> {
  const token = await page.evaluate(() => {
    const joomla = (window as { Joomla?: { getOptions?: (key: string) => unknown } }).Joomla;
    return joomla?.getOptions?.("csrf.token");
  });
  return typeof token === "string" && token !== "" ? token : undefined;
}

/**
 * The checkout's calls, made by a page of the session: its cookies, and the
 * token the thank-you page's csrf-token meta tag carried (or, for a visitor
 * shown no checkout, their own session's Joomla token). The routes are the
 * checkout's own `prefix` attribute plus the route.
 */
class PageClient implements CheckoutClient {
  private constructor(
    private readonly page: Page,
    private readonly prefix: string,
    private readonly token: string | undefined,
    private readonly retryDelayMs: number,
  ) {}

  /** A tab of its own, parked on the shop, so the buyer's tab can navigate meanwhile. */
  static async of(
    context: BrowserContext,
    base: string,
    prefix: string,
    token: string | undefined,
    retryDelayMs: number,
  ) {
    const page = await context.newPage();
    await page.goto(`${base}/`);
    return new PageClient(page, prefix, token ?? (await joomlaToken(page)), retryDelayMs);
  }

  private call(route: string, body: Record<string, string>): Promise<Answer> {
    return this.page.evaluate(
      async ({ url, body, token }) => {
        const started = performance.now();
        const answer = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...(token === undefined ? {} : { "x-csrf-token": token }),
          },
          body: JSON.stringify(body),
        });
        return {
          status: answer.status,
          body: await answer.text(),
          ms: Math.round(performance.now() - started),
        };
      },
      { url: `${this.prefix}${route}`, body, token: this.token },
    );
  }

  async createCheckout(reference: string): Promise<Answer> {
    let result = await this.call("/checkouts", { reference });
    for (let retry = 0; retry < 2 && result.status === 503; retry += 1) {
      if (!/"retryable"\s*:\s*true/.test(result.body)) break;
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      result = await this.call("/checkouts", { reference });
    }
    return result;
  }

  prepareCheckout(reference: string): Promise<Answer> {
    return this.call("/checkouts/prepare", { reference });
  }

  createSwap(reference: string, payInAsset: string): Promise<Answer> {
    return this.call("/swaps", { reference, pay_in_asset: payInAsset });
  }

  swapStatus(reference: string, paymentHash: string): Promise<Answer> {
    return this.call("/swaps/status", { reference, payment_hash: paymentHash });
  }

  checkPayment(reference: string, paymentHash: string): Promise<Answer> {
    return this.call("/payments/check", { reference, payment_hash: paymentHash });
  }
}

/** Joomla's own login page; HikaShop's customers are Joomla's users. */
async function signIn(page: Page, base: string, username: string): Promise<void> {
  await page.goto(`${base}/index.php?option=com_users&view=login`);
  const form = page.locator("#com-users-login__form");
  await form.locator('input[name="username"]').fill(username);
  await form.locator('input[name="password"]').fill(PASSWORD);
  await form.locator("button[type=submit]").click();
  await page.waitForURL((url) => !/users\/login|view=login/.test(url.href), { timeout: 30_000 });
}

/**
 * Put one garment in the cart, its first size and colour, and check out with
 * the OpenReceive payment method: HikaShop creates the order and lands on its
 * thank-you page. Answers the listed price, in cents.
 */
async function order(page: Page, base: string, product: number): Promise<number | undefined> {
  // The home page lists the sample catalog.
  await page.goto(`${base}/`);
  await page
    .getByRole("link", { name: PRODUCTS[product - 1], exact: true })
    .first()
    .click({ timeout: 30_000 });
  const listed =
    (await page
      .locator(".hikashop_product_price_full .hikashop_product_price")
      .first()
      .textContent({ timeout: 30_000 })) ?? "";
  // Each choice shows the next one (colour, then size).
  const choices = page.locator('select[name^="hikashop_product_characteristic"]');
  for (let index = 0; index < (await choices.count()); index += 1) {
    const choice = choices.nth(index);
    await choice.waitFor({ state: "visible", timeout: 10_000 });
    const values = await choice
      .locator("option")
      .evaluateAll((options) =>
        options.map((option) => (option as HTMLOptionElement).value).filter(Boolean),
      );
    if (values[0] !== undefined) await choice.selectOption(values[0]);
  }
  const added = page.waitForResponse(
    (response) => /updatecart/.test(response.url()) && response.request().method() === "POST",
    { timeout: 30_000 },
  );
  await page
    .getByRole("button", { name: /add to cart/i })
    .first()
    .click({ timeout: 30_000 });
  await added;
  await page.goto(`${base}/index.php?option=com_hikashop&ctrl=checkout`);
  // Shipping and the addresses are chosen already; the payment method is ours.
  const method = page.locator('input[name="checkout[payment][id]"]');
  if ((await method.count()) > 1) {
    await page
      .locator("label", { hasText: /bitcoin/i })
      .first()
      .click({ timeout: 30_000 });
  }
  // HikaShop saves a changed block first: press Finish again until it lands.
  for (let attempt = 0; attempt < 3 && !/after_end/.test(page.url()); attempt += 1) {
    const finish = page.getByRole("button", { name: "Finish" }).first();
    // Forced right-to-left (the payer walk's dark RTL journey), Joomla's
    // left-to-right template lays the checkout out 10,000 px wide and the
    // pointer cannot reach Finish; the button's own handler still submits.
    await finish
      .click({ timeout: 15_000 })
      .catch(() => finish.dispatchEvent("click", undefined, { timeout: 15_000 }));
    await page
      .waitForURL(/after_end/, { timeout: attempt < 2 ? 15_000 : 60_000 })
      .catch(() => undefined);
  }
  if (!/after_end/.test(page.url())) {
    throw new Error(`checkout never reached the thank-you page: ${page.url()}`);
  }
  return parsePriceCents(listed);
}

/** The checkout on the page, and its own route prefix and token. */
async function checkoutOn(
  page: Page,
): Promise<{ reference: string; prefix: string; token?: string }> {
  const checkout = page.locator("openreceive-checkout");
  await checkout.waitFor({ state: "attached", timeout: 30_000 });
  return {
    reference: (await checkout.getAttribute("reference")) ?? "",
    prefix: (await checkout.getAttribute("prefix")) ?? "",
    token: (await page.locator('meta[name="csrf-token"]').getAttribute("content")) ?? undefined,
  };
}

/** Whether a response is the checkout's create call. */
function isCreate(url: string, method: string): boolean {
  return method === "POST" && new URL(url).searchParams.get("path") === "/checkouts";
}

/**
 * On a page with the checkout: pick Bitcoin and wait for its create call.
 * Answers the order id the checkout names, and the create call's answer.
 */
async function payWithLightning(
  page: Page,
  pick = true,
): Promise<{ reference: string; prefix: string; token?: string; created?: Answer }> {
  const created = awaitedLater(
    page.waitForResponse((response) => isCreate(response.url(), response.request().method()), {
      timeout: 60_000,
    }),
  );
  // Handled even when nothing awaits it: no pick, or no checkout on the page.
  created.catch(() => undefined);
  const found = await checkoutOn(page);
  if (!pick) return found;
  const started = performance.now();
  const picked = page
    .locator("openreceive-checkout")
    .getByRole("button", { name: /^bitcoin/i })
    .first()
    .click({ timeout: 45_000 })
    .catch(() => undefined);
  const response = await created.catch(() => undefined);
  await picked;
  return {
    ...found,
    created:
      response === undefined
        ? undefined
        : {
            status: response.status(),
            body: await response.text(),
            ms: Math.round(performance.now() - started),
          },
  };
}

/** The payer walk's way to the checkout: a customer checks out, and lands on the thank-you page. */
export function hikashopPayerOrders(base: string): PlaceOrder {
  const signedIn = new WeakSet<BrowserContext>();
  return async (page, productId) => {
    if (!signedIn.has(page.context())) {
      await signIn(page, base, BUYER);
      signedIn.add(page.context());
    }
    const price = await order(page, base, productId);
    await payWithLightning(page, false);
    return {
      price,
      listing: `${PRODUCTS[productId - 1]}, as its product page lists it`,
      url: page.url(),
    };
  };
}

const hashOf = (body: string) => body.match(/"payment_hash"\s*:\s*"([0-9a-f]{64})"/)?.[1];
const bolt11Of = (body: string) => body.match(/"bolt11"\s*:\s*"(ln[a-z0-9]+)"/i)?.[1];
/** A refusal by the plugin's form-token check, not by the order's owner check. */
const tokenRefusal = (body: string) => /security token/i.test(body);

export async function liveHikashopChecks(
  baseUrl: string,
  options: LiveOptions = {},
): Promise<Check[]> {
  const retryDelayMs = options.retryDelayMs ?? 5_000;
  const checks: Check[] = [];
  const health = await fetch(`${baseUrl}/`)
    .then((response) => response.status)
    .catch(() => 0);
  checks.push(check("live_health", health === 200, "Joomla answers GET /.", `${health}`));

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const pageErrors: string[] = [];
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await signIn(page, baseUrl, BUYER);
    await order(page, baseUrl, 1);
    const thankYou = page.url();
    const { reference, prefix, token, created } = await payWithLightning(page);
    const bolt11 = created === undefined ? undefined : bolt11Of(created.body);
    const paymentHash = created === undefined ? undefined : hashOf(created.body);
    checks.push(
      check(
        "live_page_invoice",
        created?.status === 201 && bolt11 !== undefined,
        "The customer checked out with OpenReceive, and HikaShop's thank-you page showed a checkout that got a Lightning invoice.",
        created === undefined
          ? `${thankYou}: the page never asked for an invoice`
          : `${created.status} ${bolt11 === undefined ? created.body.slice(0, 300) : `${bolt11.slice(0, 16)}…`}`,
      ),
    );
    if (reference === "") throw new Error("the thank-you page showed no checkout");

    const buyer = await PageClient.of(context, baseUrl, prefix, token, retryDelayMs);
    const own = await buyer.createCheckout(reference);
    checks.push(
      check(
        "live_invoice",
        own.status === 201 && hashOf(own.body) !== undefined && hashOf(own.body) === paymentHash,
        "The customer's own order, asked for again in the customer's session, got the thank-you page's invoice.",
        `${own.status} in ${own.ms} ms${hashOf(own.body) === paymentHash ? "" : `: ${own.body.slice(0, 300)}`}`,
      ),
    );

    // Another signed-in customer, with an order and a token of their own, and
    // a visitor who is signed in to nothing: neither may pay this order.
    const strangerContext = await browser.newContext();
    const strangerPage = await strangerContext.newPage();
    await signIn(strangerPage, baseUrl, STRANGER);
    await order(strangerPage, baseUrl, 1);
    const theirs = await checkoutOn(strangerPage);
    const stranger = await PageClient.of(
      strangerContext,
      baseUrl,
      theirs.prefix,
      theirs.token,
      retryDelayMs,
    );
    const refused = await stranger.createCheckout(reference);
    checks.push(
      check(
        "live_refuses_stranger",
        [401, 403, 404].includes(refused.status) && !tokenRefusal(refused.body),
        "The plugin refused a checkout for another customer's order, from a session with its own order and token.",
        `${refused.status} ${refused.body.slice(0, 200)}`,
      ),
    );
    // The visitor opens the order's thank-you page without the order's own
    // token, and calls the route with their own session's Joomla token.
    const visitorContext = await browser.newContext();
    const visitorPage = await visitorContext.newPage();
    await visitorPage.goto(
      `${baseUrl}/index.php?option=com_hikashop&ctrl=checkout&task=after_end&order_id=${reference}`,
    );
    const shownToVisitor = await visitorPage.locator("openreceive-checkout").count();
    const visitor = await PageClient.of(visitorContext, baseUrl, prefix, undefined, retryDelayMs);
    const nobody = await visitor.createCheckout(reference);
    checks.push(
      check(
        "live_refuses_visitor",
        shownToVisitor === 0 &&
          [401, 403, 404].includes(nobody.status) &&
          !tokenRefusal(nobody.body),
        "A visitor who is not signed in saw no checkout on the order's thank-you page, and the plugin refused their checkout for it.",
        `${shownToVisitor === 0 ? "no checkout shown" : "the page showed the checkout"}; ${nobody.status} ${nobody.body.slice(0, 200)}`,
      ),
    );

    if (paymentHash !== undefined) {
      checks.push(await backToBackCheck(buyer, reference, "", paymentHash));
      // The customer comes back through their account's order list to the
      // order's page, in a tab of its own: the same checkout resumes the same
      // invoice. The thank-you page stays open in the first tab.
      const account = await context.newPage();
      account.on("pageerror", (error) => pageErrors.push(String(error)));
      await account.goto(`${baseUrl}/index.php?option=com_hikashop&ctrl=order&task=listing`);
      await account
        .locator(`a[href*="cid-${reference}/"], a[href*="cid=${reference}&"]`)
        .first()
        .click({ timeout: 30_000 });
      const again = await payWithLightning(account);
      checks.push(
        check(
          "live_reload",
          again.created?.status === 201 && hashOf(again.created.body) === paymentHash,
          "Opening the order again, from the customer's account, resumed the same checkout: the same invoice.",
          again.created === undefined
            ? "the order page never asked for an invoice"
            : `${again.created.status} ${hashOf(again.created.body) === paymentHash ? "same payment hash" : again.created.body.slice(0, 200)}`,
        ),
      );
      if (options.paid !== undefined) {
        checks.push(
          ...(await paidChecks(buyer, reference, "", paymentHash, options.paid, options)),
        );
        // The open thank-you page sees the payment too: it loads again and
        // HikaShop shows the order paid.
        const shown = await page
          .locator(".hikashop_thankyou--paid, .hikashop_thankyou_status--paid")
          .first()
          .waitFor({ state: "attached", timeout: 60_000 })
          .then(() => true)
          .catch(() => false);
        checks.push(
          check(
            "live_page_paid",
            shown,
            "Once the order settled, its thank-you page loaded again and shows it paid.",
            shown ? undefined : `the page at ${page.url()} shows no payment`,
          ),
        );
      }
    }
    if (options.swap !== undefined) {
      try {
        // A new order, with no Lightning invoice yet: the swap is its first payment.
        await order(page, baseUrl, SWAP_PRODUCT);
        const swapOrder = await payWithLightning(page, false);
        checks.push(
          ...(await swapOrderChecks(buyer, swapOrder.reference, "", options.swap, options)),
        );
      } catch (error) {
        checks.push(
          check("live_swap_paid", false, "The customer paid an order by swap.", String(error)),
        );
      }
    }
  } catch (error) {
    checks.push(
      check(
        "live_page_invoice",
        false,
        "The customer paid a new order on HikaShop's thank-you page.",
        String(error),
      ),
    );
  } finally {
    await browser.close();
  }
  checks.push({
    ...check(
      "live_page_no_errors",
      pageErrors.length === 0,
      "The order pages raised no script errors.",
      pageErrors.slice(0, 3).join(" | ") || undefined,
    ),
    severity: "polish",
  });
  return checks;
}
