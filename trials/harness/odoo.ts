import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { compose } from "./docker.ts";
import {
  type Answer,
  backToBackCheck,
  type CheckoutClient,
  check,
  type LiveOptions,
  type PaidPath,
  paidChecks,
  SWAP_PRODUCT,
  swapOrderChecks,
} from "./live.ts";
import type { Check } from "./types.ts";

// The live checks for an Odoo eCommerce shop. The buyer is a signed-in portal
// customer in Chromium: they put a product in the cart, check out with the
// OpenReceive payment method, land on the module's checkout page and wait for
// its checkout to get a Lightning invoice. The rest of the checks call the
// module's routes as that checkout does, from a page of the same session with
// the page's CSRF token: only the browser session that started the payment may
// pay it.

const SERVICE = "odoo";
const DATABASE = "shop";
const PASSWORD = "widget-shop-local";
const BUYER = "buyer@example.test";
const STRANGER = "stranger@example.test";
const PREFIX = "/openreceive";
const PRODUCT_CODES = ["facet", "bezel", "hinge", "latch", "knob"];
const CHECKOUT_PAGE = /\/payment\/openreceive\/checkout\?reference=([^&#]+)/;

/**
 * The stock Odoo before the agent comes: a database named shop with
 * eCommerce installed, then seed/seed.py through Odoo's shell.
 */
export async function setupOdoo(directory: string, seedDir: string): Promise<void> {
  // Through the image's entrypoint, which passes the database host and user.
  await compose(
    directory,
    [
      "exec",
      "-T",
      SERVICE,
      "/entrypoint.sh",
      "odoo",
      "-d",
      DATABASE,
      "-i",
      "website_sale",
      "--stop-after-init",
      "--no-http",
      "--log-level=warn",
    ],
    900_000,
  );
  await compose(
    directory,
    ["cp", path.join(seedDir, "seed.py"), `${SERVICE}:/tmp/openreceive-trial-seed.py`],
    60_000,
  );
  await compose(
    directory,
    [
      "exec",
      "-T",
      SERVICE,
      "sh",
      "-c",
      `/entrypoint.sh odoo shell -d ${DATABASE} --no-http --log-level=warn < /tmp/openreceive-trial-seed.py`,
    ],
    300_000,
  );
}

/** The checkout's calls from a page of the session, with the page's CSRF token. */
class PageClient implements CheckoutClient {
  private constructor(
    private readonly page: Page,
    private readonly retryDelayMs: number,
  ) {}

  /** A tab of its own, parked on `pathname`, so the buyer's tab can navigate meanwhile. */
  static async of(context: BrowserContext, url: string, retryDelayMs: number) {
    const page = await context.newPage();
    await page.goto(url);
    return new PageClient(page, retryDelayMs);
  }

  private call(route: string, body: Record<string, string>): Promise<Answer> {
    return this.page.evaluate(
      async ({ url, body }) => {
        const started = performance.now();
        const token =
          document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ??
          (window as unknown as { odoo?: { csrf_token?: string } }).odoo?.csrf_token;
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
      { url: `${PREFIX}${route}`, body },
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

async function signIn(page: Page, base: string, login: string): Promise<void> {
  await page.goto(`${base}/web/login`);
  await page.locator("#login").fill(login);
  await page.locator("#password").fill(PASSWORD);
  await page.locator("form.oe_login_form button[type=submit]").first().click();
  await page.waitForURL((url) => !url.pathname.startsWith("/web/login"), { timeout: 30_000 });
}

/** The product's page, from the shop's own listing. */
async function productUrl(page: Page, base: string, product: number): Promise<string> {
  await page.goto(`${base}/shop`);
  const code = PRODUCT_CODES[product - 1] ?? "facet";
  const href = await page
    .locator(`a[href*="-${code}-"]`)
    .first()
    .getAttribute("href", { timeout: 30_000 });
  return new URL(href ?? "/shop", base).toString();
}

/**
 * Order one product through Odoo's own shop with the OpenReceive method
 * picked: the cart, the delivery step, the payment step, then Pay. Lands on
 * the module's checkout page and answers the transaction's reference.
 */
async function order(page: Page, base: string, product: number): Promise<string> {
  await page.goto(await productUrl(page, base, product));
  await page
    .getByRole("button", { name: /add to cart/i })
    .first()
    .click({ timeout: 30_000 });
  // Odoo shows the cart's new quantity before the next page reads it.
  await page.waitForTimeout(1_500);
  await page.goto(`${base}/shop/checkout`);
  if (!/\/shop\/payment/.test(page.url())) {
    const delivery = page.locator('input[name="o_delivery_radio"]').first();
    if (await delivery.count()) await delivery.check({ force: true }).catch(() => undefined);
    await page.waitForTimeout(1_000);
    await page
      .locator('a[name="website_sale_main_button"], button[name="website_sale_main_button"]')
      .filter({ visible: true })
      .first()
      .click({ timeout: 30_000 });
    await page.waitForURL(/\/shop\/payment/, { timeout: 60_000 });
  }
  await page
    .locator('[name="o_payment_option"]')
    .filter({ hasText: /bitcoin/i })
    .first()
    .click({ timeout: 30_000 });
  await page
    .locator('button[name="o_payment_submit_button"]')
    .filter({ visible: true })
    .first()
    .click({ timeout: 30_000 });
  await page.waitForURL(CHECKOUT_PAGE, { timeout: 60_000 });
  return decodeURIComponent(page.url().match(CHECKOUT_PAGE)?.[1] ?? "");
}

/** On the checkout page: pick Bitcoin and wait for the checkout's create call. */
async function payWithLightning(page: Page): Promise<Answer | undefined> {
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `${PREFIX}/checkouts` &&
      response.request().method() === "POST",
    { timeout: 60_000 },
  );
  const checkout = page.locator("openreceive-checkout");
  await checkout.waitFor({ state: "attached", timeout: 30_000 });
  const started = performance.now();
  const picked = checkout
    .getByRole("button", { name: /^bitcoin/i })
    .first()
    .click({ timeout: 45_000 })
    .catch(() => undefined);
  const response = await created.catch(() => undefined);
  await picked;
  return response === undefined
    ? undefined
    : {
        status: response.status(),
        body: await response.text(),
        ms: Math.round(performance.now() - started),
      };
}

const hashOf = (body: string) => body.match(/"payment_hash"\s*:\s*"([0-9a-f]{64})"/)?.[1];
const bolt11Of = (body: string) => body.match(/"bolt11"\s*:\s*"(ln[a-z0-9]+)"/i)?.[1];

/** An Odoo quotation reads `draft` or `sent`; the shared checks name that state `awaiting_payment`. */
function orderState<T extends PaidPath>(paths: T): T {
  return {
    ...paths,
    orderStatus: async (reference: string) => {
      const status = await paths.orderStatus(reference);
      return status === "draft" || status === "sent" ? "awaiting_payment" : status;
    },
  };
}

export async function liveOdooChecks(baseUrl: string, options: LiveOptions = {}): Promise<Check[]> {
  const retryDelayMs = options.retryDelayMs ?? 5_000;
  const checks: Check[] = [];
  const health = await fetch(`${baseUrl}/web/health`)
    .then((response) => response.status)
    .catch(() => 0);
  checks.push(check("live_health", health === 200, "Odoo answers GET /web/health.", `${health}`));

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const pageErrors: string[] = [];
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await signIn(page, baseUrl, BUYER);
    const reference = await order(page, baseUrl, 1);
    const checkoutUrl = page.url();
    const created = await payWithLightning(page);
    const bolt11 = created === undefined ? undefined : bolt11Of(created.body);
    const paymentHash = created === undefined ? undefined : hashOf(created.body);
    checks.push(
      check(
        "live_page_invoice",
        created?.status === 201 && bolt11 !== undefined,
        "The customer ordered through Odoo's shop, paid with OpenReceive, and the module's checkout page got a Lightning invoice.",
        created === undefined
          ? `transaction ${reference || "(none)"}: the checkout page never asked for an invoice`
          : `${created.status} ${bolt11 === undefined ? created.body.slice(0, 300) : `${bolt11.slice(0, 16)}…`}`,
      ),
    );
    if (reference === "") throw new Error("the payment step led to no checkout page");

    const buyer = await PageClient.of(context, checkoutUrl, retryDelayMs);
    const own = await buyer.createCheckout(reference);
    checks.push(
      check(
        "live_invoice",
        own.status === 201 && hashOf(own.body) !== undefined && hashOf(own.body) === paymentHash,
        "The customer's own transaction, asked for again in the customer's session, got the checkout page's invoice.",
        `${own.status} in ${own.ms} ms${hashOf(own.body) === paymentHash ? "" : `: ${own.body.slice(0, 300)}`}`,
      ),
    );

    // Another signed-in customer, and a visitor who is signed in to nothing,
    // each with a session and CSRF token of their own: neither may pay it.
    const strangerContext = await browser.newContext();
    await signIn(await strangerContext.newPage(), baseUrl, STRANGER);
    const theirs = await (
      await PageClient.of(strangerContext, `${baseUrl}/shop`, retryDelayMs)
    ).createCheckout(reference);
    checks.push(
      check(
        "live_refuses_stranger",
        [401, 403, 404].includes(theirs.status),
        "The module refused a checkout for another customer's transaction.",
        `${theirs.status} ${theirs.body.slice(0, 200)}`,
      ),
    );
    const visitorContext = await browser.newContext();
    const nobody = await (
      await PageClient.of(visitorContext, `${baseUrl}/shop`, retryDelayMs)
    ).createCheckout(reference);
    checks.push(
      check(
        "live_refuses_visitor",
        [401, 403, 404].includes(nobody.status),
        "The module refused a checkout from a visitor who is not signed in.",
        `${nobody.status} ${nobody.body.slice(0, 200)}`,
      ),
    );

    if (paymentHash !== undefined) {
      checks.push(await backToBackCheck(buyer, reference, "", paymentHash));
      // The checkout page again: paying with the same method resumes the same Lightning invoice.
      await page.goto(checkoutUrl);
      const again = await payWithLightning(page);
      checks.push(
        check(
          "live_reload",
          again?.status === 201 && hashOf(again.body) === paymentHash,
          "Opening the transaction's checkout page again resumed the same checkout: the same invoice.",
          again === undefined
            ? "the checkout page never asked for an invoice the second time"
            : `${again.status} ${hashOf(again.body) === paymentHash ? "same payment hash" : again.body.slice(0, 200)}`,
        ),
      );
      if (options.paid !== undefined) {
        checks.push(
          ...(await paidChecks(
            buyer,
            reference,
            "",
            paymentHash,
            orderState(options.paid),
            options,
          )),
        );
        // The open checkout sees the payment too, and Odoo takes the customer to the order's confirmation.
        const confirmed = await page
          .waitForURL(/\/shop\/confirmation/, { timeout: 90_000 })
          .then(() => true)
          .catch(() => false);
        checks.push(
          check(
            "live_page_paid",
            confirmed,
            "Once the transaction settled, the checkout page took the customer through Odoo's payment status page to the order confirmation.",
            confirmed ? undefined : `the page stayed at ${page.url()}`,
          ),
        );
      }
    }
    if (options.swap !== undefined) {
      try {
        // A new order, with no Lightning invoice yet: the swap is its first payment.
        const swapReference = await order(page, baseUrl, SWAP_PRODUCT);
        const swapper = await PageClient.of(context, page.url(), retryDelayMs);
        checks.push(
          ...(await swapOrderChecks(swapper, swapReference, "", orderState(options.swap), options)),
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
        "The customer paid a new order on the module's checkout page.",
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
      "The shop's pages raised no script errors.",
      pageErrors.slice(0, 3).join(" | ") || undefined,
    ),
    severity: "polish",
  });
  return checks;
}
