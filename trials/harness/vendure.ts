import type { Page } from "playwright";
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

// The live checks for a Vendure shop with its Next.js storefront. A guest's
// cart is filled through Vendure's Shop API inside the server's container,
// up to the payment step: a product, the guest's email, an address and free
// shipping. The guest's session token goes into the storefront's own cookie,
// and in Chromium the guest picks the OpenReceive method at the checkout and
// goes on until the checkout asks for an invoice. The other checks call the
// storefront's routes as that checkout does, with the guest's cookie.

const PRODUCT_SLUGS = ["facet", "bezel", "hinge", "latch", "knob"];
/** The cookie the Next.js starter keeps the Vendure session token in. */
const TOKEN_COOKIE = "vendure-auth-token";
const CHECKOUT_CALL = /\/checkouts(?:\/prepare)?$/;
const CREATE_CALL = /\/checkouts$/;
const NEXT_STEP =
  /^(continue|continue to review|review order|place order|pay|pay now|pay with .+)$/i;
const OPENRECEIVE_METHOD = /bitcoin|lightning|openreceive|stablecoin/i;

// Runs as `node -e` in the server's container: a guest's order at the payment
// step, on the session in argv[2] or a new one. Prints the session token and
// the order's code.
const CART_SCRIPT = `
const [slug, given] = process.argv.slice(1);
let token = given || undefined;
async function gql(query, variables = {}) {
  const response = await fetch("http://127.0.0.1:3000/shop-api", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  token = response.headers.get("vendure-auth-token") || token;
  const body = await response.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}
(async () => {
  const { product } = await gql("query ($slug: String!) { product(slug: $slug) { variants { id } } }", { slug });
  const added = await gql("mutation ($id: ID!) { addItemToOrder(productVariantId: $id, quantity: 1) { __typename ... on Order { code } ... on ErrorResult { message } } }", { id: product.variants[0].id });
  if (added.addItemToOrder.__typename !== "Order") throw new Error(added.addItemToOrder.message);
  const email = "guest-" + Date.now() + "-" + Math.floor(Math.random() * 1e6) + "@shop.test";
  await gql("mutation ($input: CreateCustomerInput!) { setCustomerForOrder(input: $input) { __typename } }", { input: { emailAddress: email, firstName: "Widget", lastName: "Buyer" } });
  await gql("mutation ($input: CreateAddressInput!) { setOrderShippingAddress(input: $input) { __typename } }", { input: { fullName: "Widget Buyer", streetLine1: "1 Main Street", city: "Springfield", province: "IL", postalCode: "62701", countryCode: "US", phoneNumber: "5555550100" } });
  const { eligibleShippingMethods } = await gql("query { eligibleShippingMethods { id } }");
  await gql("mutation ($ids: [ID!]!) { setOrderShippingMethod(shippingMethodId: $ids) { __typename } }", { ids: [eligibleShippingMethods[0].id] });
  console.log(JSON.stringify({ token, code: added.addItemToOrder.code }));
})().catch((error) => { console.error(String(error)); process.exit(1); });
`;

interface Cart {
  readonly token: string;
  readonly code: string;
}

/** A guest's order of one product, at the payment step: on `token`'s session, or a new guest's. */
async function cart(directory: string, product: number, token = ""): Promise<Cart> {
  const slug = PRODUCT_SLUGS[product - 1] ?? "facet";
  const result = await compose(
    directory,
    ["exec", "-T", "server", "node", "-e", CART_SCRIPT, slug, token],
    60_000,
  );
  const line = result.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  try {
    return JSON.parse(line) as Cart;
  } catch {
    throw new InfraError(`The Shop API did not fill a cart: ${line.slice(0, 200)}`);
  }
}

/** The storefront's checkout calls, from a guest's session: its token in the starter's cookie. */
class GuestClient implements CheckoutClient {
  constructor(
    private readonly base: string,
    private readonly prefix: string,
    private readonly token: string,
    private readonly retryDelayMs: number,
  ) {}

  private async call(route: string, body: Record<string, string>): Promise<Answer> {
    const started = performance.now();
    const response = await fetch(`${this.base}${this.prefix}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(this.token === "" ? {} : { cookie: `${TOKEN_COOKIE}=${this.token}` }),
      },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: await response.text(),
      ms: Math.round(performance.now() - started),
    };
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

interface Opened {
  /** The reference the checkout asked about, from its first call. */
  readonly reference: string;
  /** Where the storefront serves the checkout's routes, such as /api/openreceive. */
  readonly prefix: string;
  /** The checkout's invoice, when the guest picked Bitcoin. */
  readonly created?: Answer;
}

/**
 * At the storefront's checkout, on the payment step the cart has reached:
 * pick the OpenReceive method and go on (Continue, Place order) until the
 * checkout makes its first call; with `pick`, choose Bitcoin in its picker
 * and wait for the invoice.
 */
async function payAtCheckout(page: Page, base: string, pick = true): Promise<Opened> {
  let reference = "";
  let prefix = "";
  const watch = (request: import("playwright").Request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== "POST" || !CHECKOUT_CALL.test(pathname) || reference !== "") return;
    try {
      reference = String(
        (JSON.parse(request.postData() ?? "{}") as { reference?: unknown }).reference ?? "",
      );
      prefix = pathname.replace(CHECKOUT_CALL, "");
    } catch {
      // Not the checkout's JSON: keep watching.
    }
  };
  page.on("request", watch);
  const created = page.waitForResponse(
    (response) =>
      CREATE_CALL.test(new URL(response.url()).pathname) && response.request().method() === "POST",
    { timeout: 90_000 },
  );
  created.catch(() => undefined);
  try {
    await page.goto(`${base}/checkout`);
    await page.getByText(OPENRECEIVE_METHOD).first().click({ timeout: 30_000 });
    for (let step = 0; step < 4 && reference === ""; step += 1) {
      const next = page.getByRole("button", { name: NEXT_STEP }).first();
      if (await next.isVisible().catch(() => false)) {
        await next.click().catch(() => undefined);
      }
      for (let wait = 0; wait < 20 && reference === ""; wait += 1) {
        await page.waitForTimeout(500);
      }
    }
    if (reference === "") throw new Error("the checkout never asked the storefront for an invoice");
    if (!pick) return { reference, prefix };
    const started = performance.now();
    const picked = page
      .getByRole("button", { name: /^bitcoin/i })
      .first()
      .click({ timeout: 45_000 })
      .catch(() => undefined);
    const response = await created.catch(() => undefined);
    await picked;
    return {
      reference,
      prefix,
      ...(response === undefined
        ? {}
        : {
            created: {
              status: response.status(),
              body: await response.text(),
              ms: Math.round(performance.now() - started),
            },
          }),
    };
  } finally {
    page.off("request", watch);
  }
}

const hashOf = (body: string) => body.match(/"payment_hash"\s*:\s*"([0-9a-f]{64})"/)?.[1];
const bolt11Of = (body: string) => body.match(/"bolt11"\s*:\s*"(ln[a-z0-9]+)"/i)?.[1];

/**
 * The order behind a reference (`<code>:<currency>:<due>`), and its Vendure
 * state as the shared checks read it: an order still at checkout is
 * `awaiting_payment`; anything else has been placed.
 */
function orderState<T extends PaidPath>(paths: T): T {
  return {
    ...paths,
    orderStatus: async (reference: string) => {
      const code = reference.replace(/:[A-Z]{3}:\d+$/, "");
      const state = await paths.orderStatus(code);
      return state === "AddingItems" || state === "ArrangingPayment" ? "awaiting_payment" : state;
    },
  };
}

async function guestPage(
  browser: import("playwright").Browser,
  base: string,
  token: string,
  errors: string[],
): Promise<Page> {
  const context = await browser.newContext();
  await context.addCookies([{ name: TOKEN_COOKIE, value: token, url: base }]);
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(String(error)));
  return page;
}

export async function liveVendureChecks(
  directory: string,
  baseUrl: string,
  options: LiveOptions = {},
): Promise<Check[]> {
  const retryDelayMs = options.retryDelayMs ?? 5_000;
  const checks: Check[] = [];
  const health = await fetch(`${baseUrl}/`)
    .then((response) => response.status)
    .catch(() => 0);
  checks.push(check("live_health", health === 200, "The storefront answers GET /.", `${health}`));

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const pageErrors: string[] = [];
  try {
    const guest = await cart(directory, 1);
    const page = await guestPage(browser, baseUrl, guest.token, pageErrors);
    const opened = await payAtCheckout(page, baseUrl);
    const { reference, prefix, created } = opened;
    const bolt11 = created === undefined ? undefined : bolt11Of(created.body);
    const paymentHash = created === undefined ? undefined : hashOf(created.body);
    checks.push(
      check(
        "live_page_invoice",
        created?.status === 201 && bolt11 !== undefined,
        "The guest picked the OpenReceive method at the storefront's checkout, and its checkout got a Lightning invoice.",
        created === undefined
          ? `order ${guest.code}: the checkout never asked for an invoice`
          : `${created.status} ${bolt11 === undefined ? created.body.slice(0, 300) : `${bolt11.slice(0, 16)}…`}`,
      ),
    );

    const buyer = new GuestClient(baseUrl, prefix, guest.token, retryDelayMs);
    const own = await buyer.createCheckout(reference);
    checks.push(
      check(
        "live_invoice",
        own.status === 201 && hashOf(own.body) !== undefined && hashOf(own.body) === paymentHash,
        "The guest's own order, asked for again with the guest's session, got the checkout's invoice.",
        `${own.status} in ${own.ms} ms${hashOf(own.body) === paymentHash ? "" : `: ${own.body.slice(0, 300)}`}`,
      ),
    );

    // Another guest with a cart of their own, and a visitor with no session:
    // neither may pay this order.
    const other = await cart(directory, 3);
    const theirs = await new GuestClient(baseUrl, prefix, other.token, retryDelayMs).createCheckout(
      reference,
    );
    checks.push(
      check(
        "live_refuses_stranger",
        [401, 403, 404].includes(theirs.status),
        "The shop refused a checkout for another guest's order.",
        `${theirs.status} ${theirs.body.slice(0, 200)}`,
      ),
    );
    const nobody = await new GuestClient(baseUrl, prefix, "", retryDelayMs).createCheckout(
      reference,
    );
    checks.push(
      check(
        "live_refuses_visitor",
        [401, 403, 404].includes(nobody.status),
        "The shop refused a checkout from a visitor with no session.",
        `${nobody.status} ${nobody.body.slice(0, 200)}`,
      ),
    );

    if (paymentHash !== undefined) {
      checks.push(await backToBackCheck(buyer, reference, "", paymentHash));
      // The checkout page again: it resumes the same invoice.
      const again = await payAtCheckout(page, baseUrl);
      checks.push(
        check(
          "live_reload",
          again.reference === reference &&
            again.created?.status === 201 &&
            hashOf(again.created.body) === paymentHash,
          "Opening the checkout again resumed it: the same reference and the same invoice.",
          again.created === undefined
            ? "the checkout never asked for an invoice the second time"
            : `${again.reference === reference ? "same reference" : `reference ${again.reference}`}, ${again.created.status} ${hashOf(again.created.body) === paymentHash ? "same payment hash" : again.created.body.slice(0, 200)}`,
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
        // The open checkout sees the payment too, and takes the guest to the order.
        const confirmed = await page
          .waitForURL(/\/order-confirmation\//, { timeout: 60_000 })
          .then(() => true)
          .catch(() => false);
        checks.push(
          check(
            "live_page_paid",
            confirmed,
            "Once the invoice settled, the checkout took the guest to the order's confirmation page.",
            confirmed ? undefined : `the page stayed at ${page.url()}`,
          ),
        );
      }
    }
    if (options.swap !== undefined) {
      try {
        // A new order, with no Lightning invoice yet: the swap is its first payment.
        const swapCart = await cart(directory, SWAP_PRODUCT);
        const swapPage = await guestPage(browser, baseUrl, swapCart.token, pageErrors);
        const swapOpened = await payAtCheckout(swapPage, baseUrl, false);
        checks.push(
          ...(await swapOrderChecks(
            new GuestClient(baseUrl, swapOpened.prefix, swapCart.token, retryDelayMs),
            swapOpened.reference,
            "",
            orderState(options.swap),
            options,
          )),
        );
      } catch (error) {
        checks.push(
          check("live_swap_paid", false, "The guest paid an order by swap.", String(error)),
        );
      }
    }
  } catch (error) {
    checks.push(
      check(
        "live_page_invoice",
        false,
        "The guest paid a new order at the storefront's checkout.",
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
      "The checkout pages raised no script errors.",
      pageErrors.slice(0, 3).join(" | ") || undefined,
    ),
    severity: "polish",
  });
  return checks;
}
