import { expect, test } from "@playwright/test";
import {
  addButtonToCart,
  bitcoinTile,
  expectWizardCurrencies,
  expireTestkitInvoice,
  mintAttempt,
  openShop,
  paymentColumn,
  selectFrameworkTab,
  startCheckout,
} from "./helpers.ts";

/**
 * E1 regression at the UI level: after an invoice expires, creating again on
 * the SAME order must mint a fresh bolt11 — not 409 on the superseded attempt
 * and strand the payer on an error panel.
 *
 * The reference is minted once, before checkout, and survives every retry.
 * That is the invariant this exercises: one cart, one reference, two invoices.
 */
test("expired invoice reminted on the same order without an error panel", async ({ page }) => {
  await openShop(page);
  await addButtonToCart(page);
  await startCheckout(page);
  await selectFrameworkTab(page, "react");
  await expectWizardCurrencies(page);

  const first = await mintAttempt(page, "/openreceive/checkouts", async () => {
    await bitcoinTile(page).click();
  });
  await expect(page.locator("[data-openreceive-qr] svg")).toBeVisible();

  // Kill the invoice in the wallet; polling flips the UI to expired.
  await expireTestkitInvoice(page, first.paymentHash);
  await expect(paymentColumn(page).getByText("Invoice expired")).toBeVisible();

  // The expired panel's own action. In this host it remounts the checkout on
  // the SAME reference rather than discarding the order — the reference is
  // minted once and survives every retry, and abandoning it is the footer's
  // job ("Back to shop"), not this button's.
  await page.getByRole("button", { name: "Start over", exact: true }).click();
  await expectWizardCurrencies(page);
  const second = await mintAttempt(page, "/openreceive/checkouts", async () => {
    await bitcoinTile(page).click();
  });
  expect(second.paymentHash).not.toBe(first.paymentHash);
  expect(second.bolt11).not.toBe(first.bolt11);

  // The fresh invoice renders and no error surface appears anywhere.
  await expect(page.locator("[data-openreceive-qr] svg")).toBeVisible();
  await expect(paymentColumn(page).getByText("Waiting for payment")).toBeVisible();
  await expect(page.getByText("Could not start checkout.")).toBeHidden();
  await expect(page.getByRole("alert")).toBeHidden();
});
