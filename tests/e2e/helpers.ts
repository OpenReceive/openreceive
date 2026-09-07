import { expect, type Locator, type Page } from "@playwright/test";

/** The four checkout frameworks node-express hosts as tabs. */
// Only node-express has the tab strip; the fastify stack mounts React alone.
// The full spec matrix belongs to node-express (the default stack), and the
// helpers below tolerate a host without the strip so the smoke spec can run
// against either.
export const CHECKOUT_FRAMEWORKS = ["react", "vue", "svelte", "angular"] as const;
export type CheckoutFramework = (typeof CHECKOUT_FRAMEWORKS)[number];

const FRAMEWORK_TAB_LABELS: Record<CheckoutFramework, string> = {
  react: "React",
  vue: "Vue",
  svelte: "Svelte",
  angular: "Angular",
};

/**
 * Static-price demo math: one Safety Orange at $1.00, BTC at $50,000 → 2,000
 * sats. Safety Orange is the cheapest button and therefore the first card.
 */
export const BUTTON_NAME = "Safety Orange";
export const BUTTON_PRICE = "$1.00";
export const BUTTON_SATS = "2,000 sats";

/**
 * Everything the checkout draws ships inside the OpenReceive JavaScript:
 * payment-method icons as inline SVG / `data:` URIs, wallet logos as `data:`
 * WebP in the provider-data bundle, tutorial screenshots as `data:` WebP in a
 * lazy chunk of it. A `data:` URI never becomes a network request, so a
 * checkout page that asks the server for ANY image is the regression. The shop's
 * own product artwork (`/images/…`) is the host's, not the checkout's.
 *
 * Install before navigating; hand the result to {@link expectInlineImages}.
 */
export function watchImageRequests(page: Page): ImageRequestLog {
  const images: string[] = [];
  const notFound: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() !== "image") return;
    if (new URL(request.url()).pathname.startsWith("/images/")) return;
    images.push(request.url());
  });
  page.on("response", (response) => {
    if (response.status() === 404) notFound.push(response.url());
  });
  return { images, notFound };
}

export interface ImageRequestLog {
  /** Image requests that were not the shop's own artwork. */
  readonly images: string[];
  readonly notFound: string[];
}

/**
 * The inline-image gate, run on the invoice screen (where the wallet logos
 * are): no image request left the page (and nothing 404ed); every `<img>` in
 * the checkout — light DOM and the packaged element's shadow root alike — is a
 * `data:` URI that decoded (`naturalWidth > 0`), with at least one WebP wallet
 * logo among them; and one wallet's pay tutorial shows its screenshot as a
 * decoded `data:image/webp` — which proves the lazy tutorial chunk loads under
 * this stack's bundler.
 */
export async function expectInlineImages(page: Page, log: ImageRequestLog): Promise<void> {
  expect(log.images).toEqual([]);
  expect(log.notFound).toEqual([]);

  const column = paymentColumn(page);
  await expect
    .poll(async () => (await column.evaluate(collectImages)).every((image) => image.complete), {
      message: "checkout images decoded",
    })
    .toBe(true);
  const images = await column.evaluate(collectImages);
  for (const image of images) {
    expect(image.src, "an image in the checkout is not a data: URI").toMatch(/^data:/);
    expect(image.naturalWidth, `${image.src.slice(0, 40)}… did not decode`).toBeGreaterThan(0);
  }
  expect(
    images.filter((image) => image.src.startsWith("data:image/webp;base64,")).length,
  ).toBeGreaterThan(0);

  await expectInlineTutorialImage(page);
}

interface CheckoutImage {
  readonly src: string;
  readonly complete: boolean;
  readonly naturalWidth: number;
}

/** Runs in the page: every `<img>` under `root`, following shadow roots. */
function collectImages(root: Element): CheckoutImage[] {
  const found: CheckoutImage[] = [];
  const visit = (node: Element | ShadowRoot): void => {
    for (const image of node.querySelectorAll("img")) {
      found.push({ src: image.src, complete: image.complete, naturalWidth: image.naturalWidth });
    }
    for (const element of node.querySelectorAll("*")) {
      if (element.shadowRoot !== null) visit(element.shadowRoot);
    }
  };
  if (root.shadowRoot !== null) visit(root.shadowRoot);
  visit(root);
  return found;
}

/**
 * Open Strike's tutorial (four screenshots, and it sits in every wallet list
 * the demos draw) and step to the first screenshot.
 *
 * Two renderers: the shop's own wallet grid on the React hosts (the wallet's
 * name is the button, the walkthrough is a Mantine modal in a portal) and the
 * packaged element behind the Vue/Svelte/Angular tabs (a card with a "How To
 * Pay" button, the dialog inside the shadow root). Both dialogs answer to the
 * same accessible name and label the screenshot with its caption; the logos
 * beside it carry an empty alt.
 */
async function expectInlineTutorialImage(page: Page): Promise<void> {
  const column = paymentColumn(page);
  await column
    .locator('button.or-shop-wallet:has-text("Strike"), article:has-text("Strike") button')
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: /Pay a Lightning invoice with Strike/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Next" }).click();

  const screenshot = dialog.locator('img:not([alt=""])').first();
  await expect(screenshot).toBeVisible();
  await expect(screenshot).toHaveAttribute("src", /^data:image\/webp;base64,/);
  await expect
    .poll(() => screenshot.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);

  await dialog.press("Escape");
  await expect(dialog).toBeHidden();
}

/** Open the shop and wait for the catalog to be interactive. */
export async function openShop(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByText("Buy an OR button")).toBeVisible();
  await expect(page.getByText(BUTTON_NAME).first()).toBeVisible();
}

/** Add one Safety Orange to the cart. */
export async function addButtonToCart(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Add" }).first().click();
  await expect(page.locator(".or-shop-footer")).toContainText(`1 button · ${BUTTON_PRICE}`);
}

/**
 * Place the order and wait for the checkout stage.
 *
 * The order strip above the payment screen is the host's own copy — the
 * `description` OpenReceive shows comes from `amountFor`, and this strip is the
 * richer version of it — so its presence proves the order reached the server
 * and came back priced.
 */
export async function startCheckout(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Checkout" }).click();
  // `.first()`: the checkout screen names the product twice — the summary column
  // beside the payment panel, and the packaged checkout's own order description
  // (which this shop hides in CSS, but a hidden node still resolves here).
  await expect(page.getByText(`OpenReceive button: ${BUTTON_NAME}`).first()).toBeVisible();
}

/**
 * Pick the framework tab that hosts the packaged checkout.
 *
 * Called AFTER `startCheckout`, unlike the Hello Fruit demo this replaces: the
 * tab strip lives inside the `renderCheckout` seam rather than above the shop,
 * because choosing a framework is a statement about the payment screen and
 * means nothing on the catalog. Mantine's SegmentedControl hides the radio
 * input, so the click target is the label.
 */
export async function selectFrameworkTab(page: Page, framework: CheckoutFramework): Promise<void> {
  const label = FRAMEWORK_TAB_LABELS[framework];
  const tab = page.locator(".or-shop-stage label", { hasText: label }).first();
  // A host with ONE packaged checkout and no strip (the fastify stack) is the
  // React tab by construction; only a request for another framework is an
  // error there.
  if ((await tab.count()) === 0) {
    if (framework === "react") return;
    throw new Error(`this host has no  tab: run the framework matrix against node-express`);
  }
  await tab.click();
  await expect(page.getByRole("radio", { name: label, exact: true })).toBeChecked();
}

/**
 * The payment wizard with its currency grid: the Bitcoin method tile plus the
 * swap pay-in coins the testkit provider serves (payment_methods arrive via
 * status polling, so this also proves the first poll ran).
 */
export async function expectWizardCurrencies(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "Pay this invoice" })).toBeVisible();
  await expect(page.getByText("Loading currencies...")).toBeHidden();
  await expect(bitcoinTile(page)).toBeVisible();
  await expect(page.getByRole("button", { name: /USDT/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /ETH/ })).toBeVisible();
}

/**
 * The payment column — the packaged checkout itself, and nothing beside it.
 *
 * This shop puts a summary column next to the payment panel (what is being
 * bought, and where the payment has got to), and that column renders its status
 * from the SAME model the panel does — so a bare `getByText("Waiting for
 * payment")` matches in two places. An assertion about what the CHECKOUT is
 * showing scopes to this; the locator pierces the wrappers' shadow roots, so it
 * reads the same on all four framework tabs.
 */
export function paymentColumn(page: Page): Locator {
  // The no-framework shop (the static and plain-PHP stacks) has no summary
  // column: the packaged element IS the payment column, so the locator falls
  // through to it. `.first()` keeps the React hosts on the column itself — it
  // is the ancestor and comes first in document order.
  return page.locator(".or-checkout-pay, openreceive-checkout").first();
}

export function bitcoinTile(page: Page): Locator {
  // Not `exact`: every tile in the grid names itself and then says what it is —
  // the Bitcoin tile's accessible name carries "Pay a Lightning invoice from any
  // Bitcoin wallet." with it. `^Bitcoin` still separates it from the swap coins.
  return page.getByRole("button", { name: /^Bitcoin/ });
}

/** Everything a spec needs from a minted attempt (checkout or swap create). */
export interface MintedAttempt {
  readonly paymentHash: string;
  readonly bolt11?: string;
  readonly depositAddress?: string;
  readonly providerOrderId?: string;
}

/**
 * Click an action and capture the attempt minted by the resulting POST to the
 * mounted OpenReceive route (`/openreceive/checkouts` or `/openreceive/swaps`).
 */
export async function mintAttempt(
  page: Page,
  routeSuffix: "/openreceive/checkouts" | "/openreceive/swaps",
  action: () => Promise<void>,
): Promise<MintedAttempt> {
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname === routeSuffix &&
        candidate.request().method() === "POST" &&
        candidate.ok(),
    ),
    action(),
  ]);
  const body = (await response.json()) as unknown;
  const paymentHash = findLastString(body, "payment_hash");
  if (paymentHash === undefined) {
    throw new Error(`no payment_hash in ${routeSuffix} response: ${JSON.stringify(body)}`);
  }
  const bolt11 = findLastString(body, "bolt11") ?? findLastString(body, "invoice");
  const depositAddress = findLastString(body, "deposit_address");
  const providerOrderId = findLastString(body, "provider_order_id");
  return {
    paymentHash,
    ...(bolt11 === undefined ? {} : { bolt11 }),
    ...(depositAddress === undefined ? {} : { depositAddress }),
    ...(providerOrderId === undefined ? {} : { providerOrderId }),
  };
}

/** Depth-first search for the last string value stored under `key`. */
function findLastString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  let found: string | undefined;
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey === key && typeof entryValue === "string" && entryValue.length > 0) {
      found = entryValue;
      continue;
    }
    const nested = findLastString(entryValue, key);
    if (nested !== undefined) found = nested;
  }
  return found;
}

/** Settle an invoice through the testkit wallet (emits the NWC-02 notification). */
export async function settleTestkitInvoice(page: Page, paymentHash: string): Promise<void> {
  const response = await page.request.post("/__testkit/settle", {
    data: { payment_hash: paymentHash },
  });
  expect(response.ok(), `settle ${paymentHash}: HTTP ${response.status()}`).toBe(true);
}

/** Force-expire an invoice through the testkit wallet. */
export async function expireTestkitInvoice(page: Page, paymentHash: string): Promise<void> {
  const response = await page.request.post("/__testkit/expire", {
    data: { payment_hash: paymentHash },
  });
  expect(response.ok(), `expire ${paymentHash}: HTTP ${response.status()}`).toBe(true);
}

/** Advance the scripted swap provider; the UI sees it on its next status poll. */
export async function stepTestkitSwap(
  page: Page,
  selector: { readonly pay_in_asset?: string; readonly provider_order_id?: string },
  state: string,
): Promise<void> {
  const response = await page.request.post("/__testkit/swap-step", {
    data: { ...selector, state },
  });
  expect(response.ok(), `swap-step ${state}: HTTP ${response.status()}`).toBe(true);
}

/**
 * The post-payment host flow: the receipt replaces the checkout, and the
 * download link exists.
 *
 * THE LINK IS THE ASSERTION. `download_path` is written into the order payload
 * only for a `paid` row, and that row was flipped inside OpenReceive's
 * settlement transaction by the `onPaid` hook's guarded UPDATE. A visible
 * download here means the whole bridge ran.
 */
export async function expectPaidReceipt(page: Page): Promise<void> {
  await expect(page.getByText("Payment received")).toBeVisible();
  await expect(page.getByText(`OpenReceive button: ${BUTTON_NAME}`)).toBeVisible();
  await expect(downloadLink(page)).toBeVisible();
}

export function downloadLink(page: Page): Locator {
  return page.locator("a[href*='/downloads/']").first();
}
