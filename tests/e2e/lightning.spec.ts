import { expect, test } from "@playwright/test";
import {
  addButtonToCart,
  bitcoinTile,
  BUTTON_PRICE,
  BUTTON_SATS,
  CHECKOUT_FRAMEWORKS,
  expectInlinePaymentIcons,
  expectPaidReceipt,
  expectWizardCurrencies,
  mintAttempt,
  openShop,
  paymentColumn,
  selectFrameworkTab,
  settleTestkitInvoice,
  startCheckout,
  watchIconRequests,
} from "./helpers.ts";

/**
 * Full Lightning checkout per framework tab: shop → cart → order → framework →
 * wizard → Bitcoin → invoice screen → testkit settle → the UI flips to paid
 * without a reload (status polling) → the receipt with its download.
 *
 * The react run is the smoke lane (`npm run test:e2e:smoke`).
 */
for (const framework of CHECKOUT_FRAMEWORKS) {
  const smokeTag = framework === "react" ? " @smoke" : "";
  test(`${framework} tab: lightning checkout settles without reload${smokeTag}`, async ({
    page,
  }) => {
    const iconRequests = watchIconRequests(page);
    await openShop(page);
    await addButtonToCart(page);
    await startCheckout(page);
    await selectFrameworkTab(page, framework);
    await expectWizardCurrencies(page);
    // The icons come out of the JS bundle: nothing copied next to the chunk,
    // no icon file requested, nothing 404s.
    await expectInlinePaymentIcons(page);
    expect(iconRequests.iconFileRequests).toEqual([]);
    expect(iconRequests.notFound).toEqual([]);

    // Selecting Bitcoin mints the bolt11 through POST /openreceive/checkouts.
    const attempt = await mintAttempt(page, "/openreceive/checkouts", async () => {
      await bitcoinTile(page).click();
    });
    expect(attempt.bolt11).toMatch(/^lnbc/);

    // Invoice screen: QR, amount matching the cart, working copy button.
    await expect(page.getByText("Bitcoin Lightning invoice")).toBeVisible();
    await expect(page.locator("[data-openreceive-qr] svg")).toBeVisible();
    await expect(page.getByText(`${BUTTON_SATS} / ${BUTTON_PRICE} US`)).toBeVisible();
    await page.getByRole("button", { name: "Copy invoice" }).click();
    await expect(page.getByText("Copied!")).toBeVisible();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe(attempt.bolt11);

    // Settle in the wallet; the page must flip to paid with NO reload — the
    // only way it can learn is its own status polling, and then the shop
    // re-reading its own order row.
    await expect(paymentColumn(page).getByText("Waiting for payment")).toBeVisible();
    await settleTestkitInvoice(page, attempt.paymentHash);
    await expectPaidReceipt(page);
  });
}
