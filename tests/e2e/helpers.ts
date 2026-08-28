import { expect, type Locator, type Page } from "@playwright/test";

/** The four checkout frameworks node-express hosts as tabs. */
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
  await expect(page.getByText(`OpenReceive button: ${BUTTON_NAME}`)).toBeVisible();
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
  await page.locator(".or-shop-stage label", { hasText: label }).first().click();
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
