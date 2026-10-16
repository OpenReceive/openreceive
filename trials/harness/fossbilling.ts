import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { compose, InfraError } from "./docker.ts";
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

// The live checks for a FOSSBilling billing panel. The buyer is a signed-in
// client in Chromium: they order a VPS through FOSSBilling's own shop with the
// OpenReceive method picked, land on FOSSBilling's payment page and wait for
// its checkout to get a Lightning invoice. The rest of the checks call the
// extension's routes as that checkout does, from a page of the same session:
// FOSSBilling ties a session to the browser's headers, so calls from another
// HTTP client would lose it.

const SERVICE = "fossbilling";
const PASSWORD = "widget-shop-local";
const BUYER = "buyer@example.test";
const STRANGER = "stranger@example.test";
const PREFIX = "/openreceive/api";
const PRODUCT_SLUGS = [
  "widget-vps-nano",
  "widget-vps-micro",
  "widget-vps-small",
  "widget-vps-medium",
  "widget-vps-large",
];
const PAYMENT_PAGE = /\/invoice\/banklink\/([0-9a-f]+)\/\d+/;

/**
 * The stock FOSSBilling's install, owner, clients and products, before the
 * agent comes: its own web installer, then seed/seed.php. Every check comes
 * from one address, so FOSSBilling's per-IP rate limits are turned off.
 */
export async function setupFossbilling(
  directory: string,
  baseUrl: string,
  seedDir: string,
): Promise<void> {
  const installer = `${baseUrl}/install/install.php`;
  const opened = await fetch(installer, { redirect: "manual" });
  const cookie = opened.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  const form = new URLSearchParams({
    database_hostname: "mariadb",
    database_port: "3306",
    database_name: "fossbilling",
    database_username: "fossbilling",
    database_password: "fossbilling-local",
    admin_name: "Shop Owner",
    admin_email: "shop@example.test",
    admin_password: "Widget-shop-local1",
    currency_code: "USD",
    system_url: `${baseUrl}/`,
  });
  const installed = await fetch(`${installer}?a=install`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: form,
    redirect: "manual",
  });
  if (installed.status !== 200) {
    throw new InfraError(
      `FOSSBilling's installer answered ${installed.status}: ${(await installed.text())
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .slice(0, 300)}`,
    );
  }
  await compose(
    directory,
    [
      "exec",
      "-T",
      "-u",
      "www-data",
      SERVICE,
      "sed",
      "-i",
      "/'rate_limiter' =>/,/'enabled'/ s/'enabled' => true/'enabled' => false/",
      "config.php",
    ],
    60_000,
  );
  await compose(
    directory,
    ["cp", path.join(seedDir, "seed.php"), `${SERVICE}:/tmp/openreceive-trial-seed.php`],
    60_000,
  );
  // As the web server's user: a root run leaves files in data/ it cannot write.
  await compose(
    directory,
    [
      "exec",
      "-T",
      "-u",
      "www-data",
      "-e",
      `SHOP_URL=${baseUrl}/`,
      SERVICE,
      "php",
      "/tmp/openreceive-trial-seed.php",
    ],
    120_000,
  );
}

/** The checkout's calls, made by a page of the session: its cookies, its headers and FOSSBilling's CSRF token. */
class PageClient implements CheckoutClient {
  private constructor(
    private readonly page: Page,
    private readonly retryDelayMs: number,
  ) {}

  /** A tab of its own, parked on the shop, so the buyer's tab can navigate meanwhile. */
  static async of(context: BrowserContext, base: string, retryDelayMs: number) {
    const page = await context.newPage();
    await page.goto(`${base}/`);
    const token = (await context.cookies(base)).find(({ name }) => name === "fossbilling_csrf");
    if (token === undefined) throw new InfraError("FOSSBilling set no fossbilling_csrf cookie.");
    return new PageClient(page, retryDelayMs);
  }

  private call(route: string, body: Record<string, string>): Promise<Answer> {
    return this.page.evaluate(
      async ({ url, body }) => {
        const started = performance.now();
        const token = document.cookie
          .split("; ")
          .find((part) => part.startsWith("fossbilling_csrf="))
          ?.slice("fossbilling_csrf=".length);
        const answer = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...(token === undefined ? {} : { "x-csrf-token": decodeURIComponent(token) }),
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

async function signIn(page: Page, base: string, email: string): Promise<void> {
  await page.goto(`${base}/login`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: /^login$/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

/** The OpenReceive method among the payment methods FOSSBilling lists as logos, titled by tooltip. */
function methodLogo(page: Page) {
  return page.locator('label[data-bs-title^="Bitcoin"]').first();
}

/**
 * Order one product through FOSSBilling's own shop with the OpenReceive
 * method picked; checkout lands on the new invoice's payment page. Answers
 * the invoice's hash.
 */
async function order(page: Page, base: string, product: number): Promise<string> {
  await page.goto(`${base}/order/${PRODUCT_SLUGS[product - 1]}`);
  await page.getByRole("button", { name: /^next$/i }).click();
  await methodLogo(page).click({ timeout: 30_000 });
  await page.getByRole("button", { name: /^checkout$/i }).click();
  await page.waitForURL(PAYMENT_PAGE, { timeout: 60_000 });
  return new URL(page.url()).pathname.match(PAYMENT_PAGE)?.[1] ?? "";
}

/**
 * On the payment page: pick Bitcoin and wait for the checkout's create call.
 * Answers the invoice id the checkout names, and the create call's answer.
 */
async function payWithLightning(
  page: Page,
  pick = true,
): Promise<{ reference: string; created?: Answer }> {
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `${PREFIX}/checkouts` &&
      response.request().method() === "POST",
    { timeout: 60_000 },
  );
  const checkout = page.locator("openreceive-checkout");
  await checkout.waitFor({ state: "attached", timeout: 30_000 });
  const reference = (await checkout.getAttribute("reference")) ?? "";
  if (!pick) {
    created.catch(() => undefined);
    return { reference };
  }
  const started = performance.now();
  const picked = checkout
    .getByRole("button", { name: /^bitcoin/i })
    .first()
    .click({ timeout: 45_000 })
    .catch(() => undefined);
  const response = await created.catch(() => undefined);
  await picked;
  return {
    reference,
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

/** The invoice's own page: pick the method again and follow FOSSBilling's Pay Now to its payment page. */
async function openPaymentPage(page: Page, base: string, hash: string): Promise<void> {
  await page.goto(`${base}/invoice/${hash}`);
  await methodLogo(page).click({ timeout: 30_000 });
  await page.locator("#paymentPrompt a:visible").first().click({ timeout: 30_000 });
  await page.waitForURL(PAYMENT_PAGE, { timeout: 60_000 });
}

const hashOf = (body: string) => body.match(/"payment_hash"\s*:\s*"([0-9a-f]{64})"/)?.[1];
const bolt11Of = (body: string) => body.match(/"bolt11"\s*:\s*"(ln[a-z0-9]+)"/i)?.[1];

/** FOSSBilling's unpaid invoice reads `unpaid`; the shared checks name that state `awaiting_payment`. */
function invoiceStatus<T extends PaidPath>(paths: T): T {
  return {
    ...paths,
    orderStatus: async (id: string) => {
      const status = await paths.orderStatus(id);
      return status === "unpaid" ? "awaiting_payment" : status;
    },
  };
}

export async function liveFossbillingChecks(
  baseUrl: string,
  options: LiveOptions = {},
): Promise<Check[]> {
  const retryDelayMs = options.retryDelayMs ?? 5_000;
  const checks: Check[] = [];
  const health = await fetch(`${baseUrl}/`)
    .then((response) => response.status)
    .catch(() => 0);
  checks.push(check("live_health", health === 200, "FOSSBilling answers GET /.", `${health}`));

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const pageErrors: string[] = [];
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await signIn(page, baseUrl, BUYER);
    const invoice = await order(page, baseUrl, 1);
    const { reference, created } = await payWithLightning(page);
    const bolt11 = created === undefined ? undefined : bolt11Of(created.body);
    const paymentHash = created === undefined ? undefined : hashOf(created.body);
    checks.push(
      check(
        "live_page_invoice",
        created?.status === 201 && bolt11 !== undefined,
        "The client ordered through FOSSBilling's shop, and the new invoice's payment page showed a checkout that got a Lightning invoice.",
        created === undefined
          ? `invoice ${invoice || "(none)"}: the payment page never asked for an invoice`
          : `${created.status} ${bolt11 === undefined ? created.body.slice(0, 300) : `${bolt11.slice(0, 16)}…`}`,
      ),
    );
    if (reference === "") throw new Error("the payment page showed no checkout");

    const buyer = await PageClient.of(context, baseUrl, retryDelayMs);
    const own = await buyer.createCheckout(reference);
    checks.push(
      check(
        "live_invoice",
        own.status === 201 && hashOf(own.body) !== undefined && hashOf(own.body) === paymentHash,
        "The client's own invoice, asked for again in the client's session, got the payment page's invoice.",
        `${own.status} in ${own.ms} ms${hashOf(own.body) === paymentHash ? "" : `: ${own.body.slice(0, 300)}`}`,
      ),
    );

    // Another signed-in client, and a visitor who is signed in to nothing,
    // each with a session and CSRF token of their own: neither may pay it.
    const strangerContext = await browser.newContext();
    await signIn(await strangerContext.newPage(), baseUrl, STRANGER);
    const theirs = await (
      await PageClient.of(strangerContext, baseUrl, retryDelayMs)
    ).createCheckout(reference);
    checks.push(
      check(
        "live_refuses_stranger",
        [401, 403, 404].includes(theirs.status),
        "The extension refused a checkout for another client's invoice.",
        `${theirs.status} ${theirs.body.slice(0, 200)}`,
      ),
    );
    const visitorContext = await browser.newContext();
    const nobody = await (
      await PageClient.of(visitorContext, baseUrl, retryDelayMs)
    ).createCheckout(reference);
    checks.push(
      check(
        "live_refuses_visitor",
        [401, 403, 404].includes(nobody.status),
        "The extension refused a checkout from a visitor who is not signed in.",
        `${nobody.status} ${nobody.body.slice(0, 200)}`,
      ),
    );

    if (paymentHash !== undefined) {
      checks.push(await backToBackCheck(buyer, reference, "", paymentHash));
      // The invoice's page again: paying with the same method resumes the same Lightning invoice.
      await openPaymentPage(page, baseUrl, invoice);
      const again = await payWithLightning(page);
      checks.push(
        check(
          "live_reload",
          again.created?.status === 201 && hashOf(again.created.body) === paymentHash,
          "Opening the invoice's payment page again resumed the same checkout: the same invoice.",
          again.created === undefined
            ? "the payment page never asked for an invoice the second time"
            : `${again.created.status} ${hashOf(again.created.body) === paymentHash ? "same payment hash" : again.created.body.slice(0, 200)}`,
        ),
      );
      if (options.paid !== undefined) {
        checks.push(
          ...(await paidChecks(
            buyer,
            reference,
            "",
            paymentHash,
            invoiceStatus(options.paid),
            options,
          )),
        );
        // The open payment page sees the payment too, and takes the client back to the invoice.
        const returned = await page
          .waitForURL(new RegExp(`/invoice/${invoice}$`), { timeout: 60_000 })
          .then(async () => /\bPaid\b/.test(await page.locator("body").innerText()))
          .catch(() => false);
        checks.push(
          check(
            "live_page_paid",
            returned,
            "Once the invoice settled, the payment page took the client back to the invoice, which reads Paid.",
            returned ? undefined : `the page stayed at ${page.url()}`,
          ),
        );
      }
    }
    if (options.swap !== undefined) {
      try {
        // A new order, with no Lightning invoice yet: the swap is its first payment.
        await order(page, baseUrl, SWAP_PRODUCT);
        const swapInvoice = await payWithLightning(page, false);
        checks.push(
          ...(await swapOrderChecks(
            buyer,
            swapInvoice.reference,
            "",
            invoiceStatus(options.swap),
            options,
          )),
        );
      } catch (error) {
        checks.push(
          check("live_swap_paid", false, "The client paid an invoice by swap.", String(error)),
        );
      }
    }
  } catch (error) {
    checks.push(
      check(
        "live_page_invoice",
        false,
        "The client paid a new invoice on FOSSBilling's payment page.",
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
      "The invoice pages raised no script errors.",
      pageErrors.slice(0, 3).join(" | ") || undefined,
    ),
    severity: "polish",
  });
  return checks;
}
