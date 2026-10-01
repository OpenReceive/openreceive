import { expect, type Page, test } from "@playwright/test";
import {
  addButtonToCart,
  bitcoinTile,
  CHECKOUT_FRAMEWORKS,
  hasFrameworkTabs,
  openShop,
  paymentColumn,
  selectFrameworkTab,
  startCheckout,
} from "./helpers.ts";

// "Switch payment method" is a way back to the METHOD GRID, every time. It is
// not a back button: a payer who walked through several coins and clicks it
// must land on the grid, never on the deposit of a coin they left earlier.
//
// The walk below is the one that used to break: after a SECOND swap attempt
// existed for the order, leaving it fell back to the first attempt's deposit
// panel, and every further click re-dismissed the same attempt, so the link
// stopped doing anything at all. Leaving Bitcoin brought a dismissed deposit
// back too.
//
// It drives whatever checkout the host shows — the packaged one on each
// framework tab of node-express, or the headless shop CheckoutStage the Rails
// and Next.js stacks mount (run those through OPENRECEIVE_E2E_BASE_URL).
test.use({ viewport: { width: 1280, height: 900 } });

type Coin = { readonly tile: RegExp; readonly coin: string; readonly network?: string };

const USDT_SOLANA: Coin = { tile: /^USDT/, coin: "USDT", network: "Solana" };
const USDT_TRON: Coin = { tile: /^USDT/, coin: "USDT", network: "Tron" };
const SOL: Coin = { tile: /^SOL\b/, coin: "SOL" };
const ETH: Coin = { tile: /^ETH\b/, coin: "ETH" };

const switchLink = (page: Page) =>
  paymentColumn(page).getByRole("button", { name: "Switch payment method" });

/** The method grid is on screen, and nothing that belongs to a chosen method is. */
async function expectMethodGrid(page: Page): Promise<void> {
  await expect(bitcoinTile(page)).toBeVisible();
  await expect(switchLink(page)).toHaveCount(0);
  await expect(paymentColumn(page).getByText(/ on the .+ network/)).toHaveCount(0);
}

/** Pick a swap coin from the grid and wait for ITS deposit instructions. */
async function payWith(page: Page, { tile, coin, network }: Coin): Promise<void> {
  await paymentColumn(page).getByRole("button", { name: tile }).first().click();
  if (network !== undefined) {
    await paymentColumn(page)
      .getByRole("group", { name: `Choose ${coin} network` })
      .getByRole("button", { name: network })
      .first()
      .click();
    await paymentColumn(page)
      .getByRole("button", { name: /^Continue/ })
      .first()
      .click();
  }
  const expectedNetwork = network ?? (coin === "SOL" ? "Solana" : "Ethereum");
  await expect(
    paymentColumn(page)
      .getByText(new RegExp(`${coin} on the ${expectedNetwork} network`))
      .first(),
  ).toBeVisible();
  // One deposit at a time: the panel for the coin just picked, and no other.
  await expect(
    paymentColumn(page)
      .getByText(/ on the .+ network/)
      .first(),
  ).toHaveText(new RegExp(`${coin} on the ${expectedNetwork} network`));
}

async function payWithBitcoin(page: Page): Promise<void> {
  await bitcoinTile(page).click();
  await expect(switchLink(page)).toBeVisible();
  await expect(paymentColumn(page).getByText(/ on the .+ network/)).toHaveCount(0);
}

async function switchMethod(page: Page): Promise<void> {
  await switchLink(page).click();
  await expectMethodGrid(page);
}

for (const framework of CHECKOUT_FRAMEWORKS) {
  test(`${framework}: Switch payment method always returns to the method grid`, async ({
    page,
  }) => {
    await openShop(page);
    await addButtonToCart(page);
    await startCheckout(page);
    if (framework !== "react") {
      test.skip(!(await hasFrameworkTabs(page)), "this host mounts one checkout, no tab strip");
    }
    await selectFrameworkTab(page, framework);
    await expectMethodGrid(page);

    // First swap, then away and back to a different one.
    await payWith(page, USDT_SOLANA);
    await switchMethod(page);
    await payWith(page, SOL);
    // Two attempts now exist. Leaving the second must not reopen the first.
    await switchMethod(page);
    await payWith(page, ETH);
    await switchMethod(page);

    // Bitcoin in the middle: leaving it must not resurrect a deposit left earlier.
    await payWithBitcoin(page);
    await switchMethod(page);
    await payWith(page, USDT_TRON);
    await switchMethod(page);
    await payWithBitcoin(page);
    await switchMethod(page);

    // Coming back to a coin already started reopens ITS deposit, and the link
    // still leaves it.
    await payWith(page, USDT_SOLANA);
    await switchMethod(page);
    await payWith(page, SOL);
    await switchMethod(page);
    await payWithBitcoin(page);
    await switchMethod(page);
  });
}
