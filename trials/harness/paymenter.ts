import { request as httpRequest } from "node:http";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { compose, InfraError } from "./docker.ts";
import {
  type Answer,
  backToBackCheck,
  type CheckoutClient,
  check,
  type LiveOptions,
  metaToken,
  type PaidPath,
  paidChecks,
  SWAP_PRODUCT,
  swapOrderChecks,
} from "./live.ts";
import type { Check } from "./types.ts";

// The live checks for a Paymenter billing panel. The buyer is a signed-in
// client in Chromium: they order a VPS through Paymenter's own shop, land on
// the new invoice with its payment dialog open, pick the OpenReceive method
// and wait for its checkout to get a Lightning invoice. The rest of the
// checks call the extension's routes as that checkout does: the client's
// session cookie and the page's CSRF token.

const SERVICE = "paymenter";
const PASSWORD = "widget-shop-local";
const BUYER = "buyer@example.test";
const STRANGER = "stranger@example.test";
const PREFIX = "/extensions/openreceive";
const PRODUCT_SLUGS = [
  "widget-vps-nano",
  "widget-vps-micro",
  "widget-vps-small",
  "widget-vps-medium",
  "widget-vps-large",
];
const INVOICE_PATH = /\/invoices\/([^/?#]+)/;

/** The stock Paymenter's owner, clients and products, before the agent comes (seed/seed.php). */
export async function setupPaymenter(
  directory: string,
  baseUrl: string,
  seedDir: string,
): Promise<void> {
  await compose(
    directory,
    ["cp", path.join(seedDir, "seed.php"), `${SERVICE}:/tmp/openreceive-trial-seed.php`],
    60_000,
  );
  // As the web server's user: a root run leaves Paymenter's log file root's.
  await compose(
    directory,
    [
      "exec",
      "-T",
      "-u",
      "nginx",
      "-e",
      `SHOP_URL=${baseUrl}`,
      SERVICE,
      "php",
      "/tmp/openreceive-trial-seed.php",
    ],
    120_000,
  );
}

/** One POST through node:http with the client's cookies and the page's CSRF token. */
function post(
  base: URL,
  pathname: string,
  cookie: string,
  csrf: string,
  body: unknown,
): Promise<Answer> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: base.hostname,
        port: base.port,
        method: "POST",
        path: pathname,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          cookie,
          "x-csrf-token": csrf,
        },
      },
      (answer) => {
        let text = "";
        answer.setEncoding("utf8");
        answer.on("data", (chunk: string) => {
          text += chunk;
        });
        answer.on("end", () =>
          resolve({
            status: answer.statusCode ?? 0,
            body: text,
            ms: Math.round(performance.now() - started),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(JSON.stringify(body));
  });
}

/** The checkout's calls, from a browser session: its cookies and the CSRF token its pages carry. */
class SessionClient implements CheckoutClient {
  private constructor(
    private readonly base: URL,
    private readonly cookie: string,
    private readonly csrf: string,
    private readonly retryDelayMs: number,
  ) {}

  static async of(
    context: BrowserContext,
    page: Page,
    retryDelayMs: number,
  ): Promise<SessionClient> {
    const base = new URL(page.url());
    const csrf = metaToken(await page.content());
    if (csrf === undefined)
      throw new InfraError("The Paymenter page carries no csrf-token meta tag.");
    const cookie = (await context.cookies(base.origin))
      .map(({ name, value }) => `${name}=${value}`)
      .join("; ");
    return new SessionClient(new URL(base.origin), cookie, csrf, retryDelayMs);
  }

  private call(route: string, body: Record<string, string>): Promise<Answer> {
    return post(this.base, `${PREFIX}${route}`, this.cookie, this.csrf, body);
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
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
}

/** Order one product through Paymenter's own shop; the checkout lands on the new invoice. */
async function order(page: Page, base: string, product: number): Promise<string> {
  await page.goto(`${base}/products/vps/${PRODUCT_SLUGS[product - 1]}`);
  await page
    .getByRole("button", { name: /add to cart/i })
    .first()
    .click();
  // A product with options stops on its own checkout page first.
  await page.waitForURL(/\/(cart|checkout)\b/, { timeout: 30_000 });
  if (!new URL(page.url()).pathname.startsWith("/cart")) {
    const add = page.getByRole("button", { name: /add to cart|continue/i }).first();
    if (await add.isVisible().catch(() => false)) await add.click();
    await page.goto(`${base}/cart`);
  }
  await page.getByRole("button", { name: /^checkout$/i }).click();
  await page.waitForURL(INVOICE_PATH, { timeout: 60_000 });
  return new URL(page.url()).pathname.match(INVOICE_PATH)?.[1] ?? "";
}

/**
 * In the invoice's payment dialog: pick the OpenReceive method, press Pay Now,
 * then pick Bitcoin and wait for the checkout's create call. Answers the
 * invoice id the checkout names, and the create call's answer.
 */
async function payWithLightning(
  page: Page,
  pick = true,
): Promise<{ reference: string; created?: Answer }> {
  if (
    !(await page
      .getByRole("button", { name: /pay now/i })
      .isVisible()
      .catch(() => false))
  ) {
    await page.getByRole("button", { name: /^pay$/i }).first().click();
  }
  await page
    .locator("text=/Bitcoin (Lightning|& stablecoins)/ >> visible=true")
    .first()
    .click({ timeout: 30_000 });
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `${PREFIX}/checkouts` &&
      response.request().method() === "POST",
    { timeout: 60_000 },
  );
  await page.getByRole("button", { name: /pay now/i }).click();
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

const hashOf = (body: string) => body.match(/"payment_hash"\s*:\s*"([0-9a-f]{64})"/)?.[1];
const bolt11Of = (body: string) => body.match(/"bolt11"\s*:\s*"(ln[a-z0-9]+)"/i)?.[1];

/** Paymenter's unpaid invoice reads `pending`; the shared checks name that state `awaiting_payment`. */
function invoiceStatus<T extends PaidPath>(paths: T): T {
  return {
    ...paths,
    orderStatus: async (id: string) => {
      const status = await paths.orderStatus(id);
      return status === "pending" ? "awaiting_payment" : status;
    },
  };
}

export async function livePaymenterChecks(
  baseUrl: string,
  options: LiveOptions = {},
): Promise<Check[]> {
  const retryDelayMs = options.retryDelayMs ?? 5_000;
  const checks: Check[] = [];
  const health = await fetch(`${baseUrl}/`)
    .then((response) => response.status)
    .catch(() => 0);
  checks.push(check("live_health", health === 200, "Paymenter answers GET /.", `${health}`));

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
        "The client ordered through Paymenter's shop, and the new invoice's payment dialog showed a checkout that got a Lightning invoice.",
        created === undefined
          ? `invoice ${invoice || "(none)"}: the dialog never asked for an invoice`
          : `${created.status} ${bolt11 === undefined ? created.body.slice(0, 300) : `${bolt11.slice(0, 16)}…`}`,
      ),
    );
    if (reference === "") throw new Error("the payment dialog showed no checkout");

    const buyer = await SessionClient.of(context, page, retryDelayMs);
    const own = await buyer.createCheckout(reference);
    checks.push(
      check(
        "live_invoice",
        own.status === 201 && hashOf(own.body) !== undefined && hashOf(own.body) === paymentHash,
        "The client's own invoice, asked for again with the client's session, got the dialog's invoice.",
        `${own.status} in ${own.ms} ms${hashOf(own.body) === paymentHash ? "" : `: ${own.body.slice(0, 300)}`}`,
      ),
    );

    // Another signed-in client, and a visitor who is signed in to nothing,
    // each with a session and CSRF token of their own: neither may pay it.
    const strangerContext = await browser.newContext();
    const strangerPage = await strangerContext.newPage();
    await signIn(strangerPage, baseUrl, STRANGER);
    const theirs = await (
      await SessionClient.of(strangerContext, strangerPage, retryDelayMs)
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
    const visitorPage = await visitorContext.newPage();
    await visitorPage.goto(`${baseUrl}/`);
    const nobody = await (
      await SessionClient.of(visitorContext, visitorPage, retryDelayMs)
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
      // The invoice page again: its dialog resumes the same Lightning invoice.
      await page.goto(`${baseUrl}/invoices/${invoice}`);
      const again = await payWithLightning(page);
      checks.push(
        check(
          "live_reload",
          again.created?.status === 201 && hashOf(again.created.body) === paymentHash,
          "Opening the invoice's payment dialog again resumed the same checkout: the same invoice.",
          again.created === undefined
            ? "the dialog never asked for an invoice the second time"
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
        // The open dialog sees the payment too, and takes the client back to the invoice.
        const returned = await page
          .waitForURL(/checkPayment=true/, { timeout: 60_000 })
          .then(async () => /\bPaid\b/.test(await page.locator("body").innerText()))
          .catch(() => false);
        checks.push(
          check(
            "live_page_paid",
            returned,
            "Once the invoice settled, the payment dialog took the client back to the invoice, which reads Paid.",
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
        "The client paid a new invoice from Paymenter's payment dialog.",
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
