import type { Browser, Page } from "playwright";
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

// The live checks for a Medusa store: the Medusa server, with Medusa's
// Next.js starter as its storefront. The buyer shops the storefront in
// Chromium: adds a product to the cart, gives an address, takes the free
// shipping, picks the OpenReceive method at the payment step, and at the
// review step waits for the checkout to get a Lightning invoice. Holding a
// payment session's id authorizes its routes, as holding a cart's id does in
// Medusa's own store API, so the rest of the checks call the checkout's
// routes as that page does: through the storefront, with the session's id.

const REGION = "us";
const PRODUCT_HANDLES = ["facet", "bezel", "hinge", "latch", "knob"];
/** A payment session id in Medusa's shape that no cart has. */
const UNKNOWN_SESSION = "payses_01JZZZZZZZZZZZZZZZZZZZZZZZ";
const REVIEW = /step=review/;
const CONFIRMED = /\/order\/[^/]+\/confirmed/;

/** The checkout's calls, as the page makes them: JSON to the storefront's forwarding route. */
class StorefrontClient implements CheckoutClient {
  constructor(
    private readonly base: string,
    private readonly prefix: string,
    private readonly retryDelayMs: number,
  ) {}

  private async call(route: string, body: Record<string, string>): Promise<Answer> {
    const started = performance.now();
    const response = await fetch(`${this.base}${this.prefix}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text, ms: Math.round(performance.now() - started) };
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

/** Add one product to the cart, then take it through the address, delivery and payment steps. */
async function checkOut(page: Page, base: string, product: number): Promise<void> {
  await page.goto(`${base}/${REGION}/products/${PRODUCT_HANDLES[product - 1]}`);
  const options = page.locator('[data-testid="product-options"]');
  for (let index = 0; index < (await options.count()); index += 1) {
    await options.nth(index).locator('[data-testid="option-button"]').first().click();
  }
  await page.locator('[data-testid="add-product-button"]').first().click();
  await page
    .locator('[data-testid="nav-cart-link"]')
    .filter({ hasText: /\(1\)/ })
    .waitFor({ timeout: 30_000 });
  await page.goto(`${base}/${REGION}/checkout?step=address`);
  await page.locator('[data-testid="shipping-first-name-input"]').fill("Widget");
  await page.locator('[data-testid="shipping-last-name-input"]').fill("Buyer");
  await page.locator('[data-testid="shipping-address-input"]').fill("1 Main Street");
  await page.locator('[data-testid="shipping-postal-code-input"]').fill("97201");
  await page.locator('[data-testid="shipping-city-input"]').fill("Portland");
  await page.locator('[data-testid="shipping-country-select"]').selectOption(REGION);
  await page.locator('[data-testid="shipping-province-input"]').fill("OR");
  await page.locator('[data-testid="shipping-email-input"]').fill("buyer@example.test");
  await page.locator('[data-testid="submit-address-button"]').click();
  await page.waitForURL(/step=delivery/, { timeout: 60_000 });
  await page.locator('[data-testid="delivery-option-radio"]').first().click();
  await page.locator('[data-testid="submit-delivery-option-button"]').click();
  await page.waitForURL(/step=payment/, { timeout: 60_000 });
  // The method's title is the storefront's (paymentInfoMap), or Medusa's provider id.
  await page
    .locator('[role="radio"]')
    .filter({ hasText: /bitcoin|openreceive/i })
    .first()
    .click({ timeout: 30_000 });
  await page.locator('[data-testid="submit-payment-button"]').click();
  await page.waitForURL(REVIEW, { timeout: 60_000 });
}

/** A checkout call the page makes, matched by its route: `/checkouts/prepare` or `/checkouts`. */
function isCheckoutCall(url: string, route: string): boolean {
  return new URL(url).pathname.endsWith(route);
}

/**
 * At the review step: the checkout prepares on mount, which names the
 * session and the page's route prefix; picking Bitcoin then asks for the
 * Lightning invoice. Answers both, and the create call's answer.
 */
async function reviewCheckout(
  page: Page,
  pick: boolean,
  load: () => Promise<unknown>,
): Promise<{ reference: string; prefix: string; created?: Answer }> {
  const prepared = page.waitForRequest(
    (request) => request.method() === "POST" && isCheckoutCall(request.url(), "/checkouts/prepare"),
    { timeout: 60_000 },
  );
  await load();
  const request = await prepared;
  const reference = String(
    (JSON.parse(request.postData() ?? "{}") as { reference?: unknown }).reference ?? "",
  );
  const prefix = new URL(request.url()).pathname.replace(/\/checkouts\/prepare$/, "");
  if (!pick) return { reference, prefix };
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && isCheckoutCall(response.url(), "/checkouts"),
    { timeout: 60_000 },
  );
  const started = performance.now();
  await page
    .getByRole("button", { name: /^bitcoin/i })
    .first()
    .click({ timeout: 45_000 });
  const response = await created.catch(() => undefined);
  return {
    reference,
    prefix,
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

/**
 * Medusa places the order after the payment's transaction has committed: the
 * storefront completes the cart, or the plugin hands the session to Medusa's
 * process-payment workflow. So the order can follow the settled answer by a
 * moment; read its state until it is placed, for a while.
 */
function eventually<T extends PaidPath>(paths: T): T {
  return {
    ...paths,
    orderStatus: async (id: string) => {
      const deadline = Date.now() + 60_000;
      let status = await paths.orderStatus(id);
      while (status === "awaiting_payment" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        status = await paths.orderStatus(id);
      }
      return status;
    },
  };
}

/** A checkout call straight to the Medusa server, from inside the shop's network, with no publishable key. */
async function withoutKey(directory: string, reference: string): Promise<Answer> {
  const script = [
    "const base = process.env.MEDUSA_BACKEND_URL ?? 'http://medusa:9000';",
    `fetch(base + '/store/openreceive/checkouts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reference: ${JSON.stringify(reference)} }) })`,
    ".then(async (r) => console.log(r.status + ' ' + (await r.text()).slice(0, 200)))",
    ".catch((e) => console.log('0 ' + e.message));",
  ].join(" ");
  const started = performance.now();
  const result = await compose(
    directory,
    ["exec", "-T", "storefront", "node", "-e", script],
    60_000,
  ).catch((error: unknown) => ({ stdout: `0 ${String(error)}` }));
  const line = result.stdout.trim().split("\n").at(-1) ?? "0";
  const space = line.indexOf(" ");
  return {
    status: Number(space === -1 ? line : line.slice(0, space)) || 0,
    body: space === -1 ? "" : line.slice(space + 1),
    ms: Math.round(performance.now() - started),
  };
}

async function newPage(browser: Browser, errors: string[]): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  return page;
}

export async function liveMedusaChecks(
  directory: string,
  baseUrl: string,
  options: LiveOptions = {},
): Promise<Check[]> {
  const retryDelayMs = options.retryDelayMs ?? 5_000;
  const checks: Check[] = [];
  // The starter's middleware sends a visitor without its cache cookie back once to set it.
  const health = await fetch(`${baseUrl}/${REGION}`, {
    headers: { cookie: "_medusa_cache_id=trial" },
  })
    .then((response) => response.status)
    .catch(() => 0);
  checks.push(
    check("live_health", health === 200, "The storefront answers its store page.", `${health}`),
  );

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const pageErrors: string[] = [];
  try {
    const page = await newPage(browser, pageErrors);
    const first = await reviewCheckout(page, true, () => checkOut(page, baseUrl, 1));
    const { reference, prefix, created } = first;
    const bolt11 = created === undefined ? undefined : bolt11Of(created.body);
    const paymentHash = created === undefined ? undefined : hashOf(created.body);
    checks.push(
      check(
        "live_page_invoice",
        created?.status === 201 && bolt11 !== undefined,
        "The buyer checked out on the storefront, and the review step showed a checkout that got a Lightning invoice.",
        created === undefined
          ? `session ${reference || "(none)"}: the checkout never asked for an invoice`
          : `${created.status} ${bolt11 === undefined ? created.body.slice(0, 300) : `${bolt11.slice(0, 16)}…`}`,
      ),
    );
    if (reference === "") throw new Error("the review step showed no checkout");

    const buyer = new StorefrontClient(baseUrl, prefix, retryDelayMs);
    const own = await buyer.createCheckout(reference);
    checks.push(
      check(
        "live_invoice",
        own.status === 201 && hashOf(own.body) !== undefined && hashOf(own.body) === paymentHash,
        "The buyer's payment session, asked for again, got the review step's invoice.",
        `${own.status} in ${own.ms} ms${hashOf(own.body) === paymentHash ? "" : `: ${own.body.slice(0, 300)}`}`,
      ),
    );

    // Without the session's id there is nothing to pay; without the store's
    // publishable key Medusa answers no store route at all.
    const unknown = await buyer.createCheckout(UNKNOWN_SESSION);
    checks.push(
      check(
        "live_refuses_stranger",
        [401, 403, 404].includes(unknown.status),
        "The plugin refused a checkout for a payment session that does not exist.",
        `${unknown.status} ${unknown.body.slice(0, 200)}`,
      ),
    );
    const keyless = await withoutKey(directory, reference);
    checks.push(
      check(
        "live_refuses_visitor",
        [400, 401, 403].includes(keyless.status),
        "Medusa refused a checkout call without the store's publishable key.",
        `${keyless.status} ${keyless.body.slice(0, 200)}`,
      ),
    );

    if (paymentHash !== undefined) {
      checks.push(await backToBackCheck(buyer, reference, "", paymentHash));
      // The review step again: its checkout resumes the same Lightning invoice.
      const again = await reviewCheckout(page, true, () =>
        page.goto(`${baseUrl}/${REGION}/checkout?step=review`),
      );
      checks.push(
        check(
          "live_reload",
          again.reference === reference &&
            again.created?.status === 201 &&
            hashOf(again.created.body) === paymentHash,
          "A reload of the review step resumed the same checkout: the same session and the same invoice.",
          again.created === undefined
            ? `session ${again.reference || "(none)"}: the checkout never asked for an invoice the second time`
            : `${again.created.status} ${again.reference === reference ? "same session" : `session ${again.reference}`}, ${hashOf(again.created.body) === paymentHash ? "same payment hash" : again.created.body.slice(0, 200)}`,
        ),
      );
      if (options.paid !== undefined) {
        checks.push(
          ...(await paidChecks(
            buyer,
            reference,
            "",
            paymentHash,
            eventually(options.paid),
            options,
          )),
        );
        // The open review step sees the payment too, and places the order.
        const placed = await page
          .waitForURL(CONFIRMED, { timeout: 90_000 })
          .then(() => true)
          .catch(() => false);
        checks.push(
          check(
            "live_page_paid",
            placed,
            "Once the invoice settled, the review step placed the order and showed its confirmation.",
            placed ? undefined : `the page stayed at ${page.url()}`,
          ),
        );
      }
    }
    if (options.swap !== undefined) {
      try {
        // A new buyer and cart, with no Lightning invoice yet: the swap is its first payment.
        const swapPage = await newPage(browser, pageErrors);
        const swapCheckout = await reviewCheckout(swapPage, false, () =>
          checkOut(swapPage, baseUrl, SWAP_PRODUCT),
        );
        checks.push(
          ...(await swapOrderChecks(
            new StorefrontClient(baseUrl, swapCheckout.prefix, retryDelayMs),
            swapCheckout.reference,
            "",
            eventually(options.swap),
            options,
          )),
        );
      } catch (error) {
        checks.push(
          check("live_swap_paid", false, "The buyer paid an order by swap.", String(error)),
        );
      }
    }
  } catch (error) {
    checks.push(
      check(
        "live_page_invoice",
        false,
        "The buyer paid a new order from the storefront's review step.",
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
      "The storefront's pages raised no script errors.",
      pageErrors.slice(0, 3).join(" | ") || undefined,
    ),
    severity: "polish",
  });
  return checks;
}
