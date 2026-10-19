import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { compose } from "./docker.ts";
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
import type { Check } from "./types.ts";

// The live checks for a PrestaShop store. The buyer is a signed-in customer
// in Chromium: they put a widget in the cart, check out with the OpenReceive
// payment option, land on PrestaShop's order confirmation page and wait for
// its checkout to get a Lightning invoice. The rest of the checks call the
// module's routes as that checkout does, from a page of the same session,
// with the token the order page carries.

const SERVICE = "prestashop";
const PASSWORD = "widget-shop-local";
const ADMIN_PASSWORD = "Widget-shop-local1";
const BUYER = "buyer@example.test";
const STRANGER = "stranger@example.test";
const PRODUCTS = ["Widget Nano", "Widget Micro", "Widget Small", "Widget Medium", "Widget Large"];

/**
 * The stock PrestaShop's install, owner, customers and products, before the
 * agent comes: PrestaShop's own command-line installer for the shop's
 * published address, which gives the back office a random folder name; that
 * folder renamed to admin-shop and the install folder removed, as the back
 * office demands; then seed/seed.php.
 */
export async function setupPrestashop(
  directory: string,
  baseUrl: string,
  seedDir: string,
): Promise<void> {
  // As the web server's user, who owns the shop's files in the image.
  const asWebUser = ["exec", "-T", "-u", "www-data"] as const;
  await compose(
    directory,
    [
      ...asWebUser,
      SERVICE,
      "php",
      "-d",
      "memory_limit=-1",
      "install/index_cli.php",
      `--domain=${new URL(baseUrl).host}`,
      "--db_server=mariadb",
      "--db_name=prestashop",
      "--db_user=prestashop",
      "--db_password=prestashop-local",
      "--prefix=ps_",
      "--name=Widget Shop",
      "--country=us",
      "--language=en",
      "--firstname=Shop",
      "--lastname=Owner",
      `--password=${ADMIN_PASSWORD}`,
      "--email=shop@example.test",
      "--newsletter=0",
      "--send_email=0",
      "--ssl=0",
      "--fixtures=0",
    ],
    900_000,
  );
  await compose(
    directory,
    [
      ...asWebUser,
      SERVICE,
      "sh",
      "-c",
      "mv admin[0-9]* admin-shop && rm -rf install var/cache/prod var/cache/dev",
    ],
    120_000,
  );
  await compose(
    directory,
    ["cp", path.join(seedDir, "seed.php"), `${SERVICE}:/tmp/openreceive-trial-seed.php`],
    60_000,
  );
  await compose(
    directory,
    [...asWebUser, "-e", `SHOP_URL=${baseUrl}/`, SERVICE, "php", "/tmp/openreceive-trial-seed.php"],
    300_000,
  );
}

/**
 * The checkout's calls, made by a page of the session: its cookies, and the
 * token the order page's csrf-token meta tag carried. The routes are the
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
    return new PageClient(page, prefix, token, retryDelayMs);
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

async function signIn(page: Page, base: string, email: string): Promise<void> {
  await page.goto(`${base}/index.php?controller=authentication&back=my-account`);
  await page.locator('form#login-form input[name="email"]').fill(email);
  await page.locator('form#login-form input[name="password"]').fill(PASSWORD);
  await page.locator("form#login-form button[type=submit]").click();
  await page.waitForURL((url) => !/authentication|login/.test(url.href), { timeout: 30_000 });
}

/**
 * Put one widget in the cart and check out with the OpenReceive option:
 * PrestaShop creates the order and lands on its confirmation page. Answers
 * that page's URL.
 */
async function order(page: Page, base: string, product: number): Promise<string> {
  // The home page lists the five widgets.
  await page.goto(`${base}/`);
  await page
    .locator("a.product-miniature__title", { hasText: PRODUCTS[product - 1] })
    .first()
    .click({ timeout: 30_000 });
  await page.locator('[data-button-action="add-to-cart"]').first().click({ timeout: 30_000 });
  await page.locator("#blockcart-modal").waitFor({ state: "visible", timeout: 30_000 });
  await page.goto(`${base}/index.php?controller=order`);
  // The widgets are downloads: the address step leads straight to payment.
  const addresses = page.locator('button[name="confirm-addresses"]');
  if (await addresses.isVisible().catch(() => false)) await addresses.click();
  await page
    .locator('input[name="payment-option"][data-module-name="openreceive"]')
    .check({ timeout: 30_000 });
  const terms = page.locator('input[name^="conditions_to_approve"]');
  if (await terms.count()) await terms.first().check();
  await page.locator("#payment-confirmation button").click();
  await page.waitForURL(/order-confirmation/, { timeout: 60_000 });
  return page.url();
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

/** Whether a response is the checkout's create call, with or without friendly URLs. */
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
  const created = page.waitForResponse(
    (response) => isCreate(response.url(), response.request().method()),
    { timeout: 60_000 },
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

const hashOf = (body: string) => body.match(/"payment_hash"\s*:\s*"([0-9a-f]{64})"/)?.[1];
const bolt11Of = (body: string) => body.match(/"bolt11"\s*:\s*"(ln[a-z0-9]+)"/i)?.[1];

export async function livePrestashopChecks(
  baseUrl: string,
  options: LiveOptions = {},
): Promise<Check[]> {
  const retryDelayMs = options.retryDelayMs ?? 5_000;
  const checks: Check[] = [];
  const health = await fetch(`${baseUrl}/`)
    .then((response) => response.status)
    .catch(() => 0);
  checks.push(check("live_health", health === 200, "PrestaShop answers GET /.", `${health}`));

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const pageErrors: string[] = [];
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await signIn(page, baseUrl, BUYER);
    const confirmation = await order(page, baseUrl, 1);
    const { reference, prefix, token, created } = await payWithLightning(page);
    const bolt11 = created === undefined ? undefined : bolt11Of(created.body);
    const paymentHash = created === undefined ? undefined : hashOf(created.body);
    checks.push(
      check(
        "live_page_invoice",
        created?.status === 201 && bolt11 !== undefined,
        "The customer checked out with OpenReceive, and the order confirmation page showed a checkout that got a Lightning invoice.",
        created === undefined
          ? `${confirmation}: the page never asked for an invoice`
          : `${created.status} ${bolt11 === undefined ? created.body.slice(0, 300) : `${bolt11.slice(0, 16)}…`}`,
      ),
    );
    if (reference === "") throw new Error("the order confirmation page showed no checkout");

    const buyer = await PageClient.of(context, baseUrl, prefix, token, retryDelayMs);
    const own = await buyer.createCheckout(reference);
    checks.push(
      check(
        "live_invoice",
        own.status === 201 && hashOf(own.body) !== undefined && hashOf(own.body) === paymentHash,
        "The customer's own order, asked for again in the customer's session, got the order page's invoice.",
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
        [401, 403, 404].includes(refused.status),
        "The module refused a checkout for another customer's order, from a session with its own order and token.",
        `${refused.status} ${refused.body.slice(0, 200)}`,
      ),
    );
    const visitor = await PageClient.of(
      await browser.newContext(),
      baseUrl,
      prefix,
      undefined,
      retryDelayMs,
    );
    const nobody = await visitor.createCheckout(reference);
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
      // The customer comes back through Order history to the order's page: the
      // same checkout resumes the same invoice.
      await page.goto(`${baseUrl}/index.php?controller=history`);
      await page
        .locator(`a[href*="controller=order-detail"][href*="id_order=${reference}"]`)
        .first()
        .click({ timeout: 30_000 });
      const again = await payWithLightning(page);
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
        // The open order page sees the payment too, and shows it paid.
        const shown = await page
          .locator(".openreceive-paid")
          .waitFor({ state: "visible", timeout: 60_000 })
          .then(() => true)
          .catch(() => false);
        checks.push(
          check(
            "live_page_paid",
            shown,
            "Once the order settled, its page loaded again and says the payment was received.",
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
        "The customer paid a new order on PrestaShop's order confirmation page.",
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
