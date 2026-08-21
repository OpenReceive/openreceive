import { expect, type Locator, type Page } from "@playwright/test";

/** The four checkout frameworks the node-express demo hosts as tabs. */
export const CHECKOUT_FRAMEWORKS = ["react", "vue", "svelte", "angular"] as const;
export type CheckoutFramework = (typeof CHECKOUT_FRAMEWORKS)[number];

const FRAMEWORK_TAB_LABELS: Record<CheckoutFramework, string> = {
  react: "React",
  vue: "Vue",
  svelte: "Svelte",
  angular: "Angular",
};

/** Static-price demo math: 1 Banana at $4.00, BTC at $50,000 → 8,000 sats. */
export const BANANA_PRICE = "$4.00";
export const BANANA_SATS = "8,000 sats";

/** Open the shop and wait for the catalog to be interactive. */
export async function openShop(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Buy A Fruit Sticker/ })).toBeVisible();
}

/** Pick the framework tab that hosts the embedded checkout. */
export async function selectFrameworkTab(page: Page, framework: CheckoutFramework): Promise<void> {
  const tab = page.getByRole("tab", { name: FRAMEWORK_TAB_LABELS[framework], exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

/** Select the Banana sticker and add one to the cart. */
export async function addBananaToCart(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /Banana/ })
    .first()
    .click();
  await page.getByRole("button", { name: /Add to cart/ }).click();
  const cart = page.getByRole("region", { name: "Cart" });
  await expect(cart).toContainText("1 item");
  await expect(cart).toContainText("Banana");
}

/** Create the host order and wait for the checkout screen to replace the shop. */
export async function createOrder(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Create order", exact: true }).click();
  const order = page.getByRole("region", { name: "Order" });
  await expect(order).toBeVisible();
  await expect(order).toContainText(BANANA_PRICE);
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

export function bitcoinTile(page: Page): Locator {
  return page.getByRole("button", { name: "Bitcoin", exact: true });
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
 * The post-payment host flow: settled status flips in place, then the
 * onPaid-gated delivery modal offers the purchased sticker download.
 */
export async function expectPaidDelivery(page: Page): Promise<void> {
  await expect(page.getByText("Payment received").first()).toBeVisible();
  const modal = page.getByRole("dialog", { name: "You just got a sticker" });
  await expect(modal).toBeVisible();
  await expect(modal.getByText("Banana sticker")).toBeVisible();
  await expect(modal.getByText("Download")).toBeVisible();
}

/** Counts matching requests from the moment of creation; read `count()` later. */
export function trackRequests(page: Page, pathname: string): () => number {
  let count = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === pathname) count += 1;
  });
  return () => count;
}

/** Resolves on the next request to `pathname` (used to phase-align with polling). */
export function nextRequest(page: Page, pathname: string): Promise<void> {
  return page
    .waitForRequest((request) => new URL(request.url()).pathname === pathname)
    .then(() => undefined);
}
