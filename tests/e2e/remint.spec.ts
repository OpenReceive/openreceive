import { expect, test } from "@playwright/test";
import {
  addBananaToCart,
  bitcoinTile,
  createOrder,
  expectWizardCurrencies,
  expireTestkitInvoice,
  mintAttempt,
  openShop,
  selectFrameworkTab,
} from "./helpers.ts";

/**
 * E1 regression at the UI level: after an invoice expires, creating again on
 * the SAME order must mint a fresh bolt11 — not 409 on the superseded attempt
 * and strand the payer on an error panel.
 */
test("expired invoice reminted on the same order without an error panel", async ({ page }) => {
  await openShop(page);
  await selectFrameworkTab(page, "react");
  await addBananaToCart(page);
  await createOrder(page);
  await expectWizardCurrencies(page);

  const first = await mintAttempt(page, "/openreceive/checkouts", async () => {
    await bitcoinTile(page).click();
  });
  await expect(page.locator("[data-openreceive-qr] svg")).toBeVisible();

  // Kill the invoice in the wallet; polling flips the UI to expired.
  await expireTestkitInvoice(page, first.paymentHash);
  await expect(page.getByText("Invoice expired")).toBeVisible();

  // Return to the same order (reload = the resume URL) and pay again: the
  // create call for the same order must mint a NEW invoice.
  await page.reload();
  await expectWizardCurrencies(page);
  const second = await mintAttempt(page, "/openreceive/checkouts", async () => {
    await bitcoinTile(page).click();
  });
  expect(second.paymentHash).not.toBe(first.paymentHash);
  expect(second.bolt11).not.toBe(first.bolt11);

  // The fresh invoice renders and no error surface appears anywhere.
  await expect(page.locator("[data-openreceive-qr] svg")).toBeVisible();
  await expect(page.getByText("Waiting for payment")).toBeVisible();
  await expect(page.getByText("Could not start checkout.")).toBeHidden();
  await expect(page.getByRole("alert")).toBeHidden();
});
