import { expect, test } from "@playwright/test";
import {
  addBananaToCart,
  bitcoinTile,
  createOrder,
  expectWizardCurrencies,
  mintAttempt,
  nextRequest,
  openShop,
  selectFrameworkTab,
  trackRequests,
} from "./helpers.ts";

const PAYMENTS_CHECK_PATH = "/openreceive/payments/check";

/**
 * Mid-checkout reload resumes the SAME attempt (the pending bolt11 survives),
 * and the M12 regression: flipping the theme toggle must not remount the
 * checkout — no extra /payments/check may fire outside the polling cadence.
 */
test("reload resumes the same attempt; theme flip fires no extra payments/check", async ({
  page,
}) => {
  await openShop(page);
  await selectFrameworkTab(page, "react");
  await addBananaToCart(page);
  await createOrder(page);
  await expectWizardCurrencies(page);

  const minted = await mintAttempt(page, "/openreceive/checkouts", async () => {
    await bitcoinTile(page).click();
  });
  await expect(page.locator("[data-openreceive-qr] svg")).toBeVisible();
  await page.getByRole("button", { name: "Copy invoice" }).click();
  await expect(page.getByText("Copied!")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(minted.bolt11);

  // Reload mid-checkout: the checkout screen resumes on the same order, and
  // selecting Bitcoin again resumes the SAME live attempt — the create call
  // answers with the identical payment_hash/bolt11 instead of minting anew.
  await page.reload();
  await expectWizardCurrencies(page);
  const resumed = await mintAttempt(page, "/openreceive/checkouts", async () => {
    await bitcoinTile(page).click();
  });
  expect(resumed.paymentHash).toBe(minted.paymentHash);
  expect(resumed.bolt11).toBe(minted.bolt11);
  await expect(page.locator("[data-openreceive-qr] svg")).toBeVisible();

  // M12 regression. Polling runs every 3s; phase-align on a poll, flip the
  // theme immediately, then hold a window well inside the next tick: a remount
  // (the bug) fires an immediate extra /payments/check; a healthy toggle stays
  // silent.
  const themeToggle = page.getByRole("button", { name: /(light|dark) mode/ });
  const root = page.locator("main.page");
  const themeBefore = await root.getAttribute("data-theme");
  const countPaymentsChecks = trackRequests(page, PAYMENTS_CHECK_PATH);
  await nextRequest(page, PAYMENTS_CHECK_PATH);
  const baseline = countPaymentsChecks();
  await themeToggle.click();
  await expect(root).not.toHaveAttribute("data-theme", themeBefore ?? "");
  await page.waitForTimeout(1500);
  expect(countPaymentsChecks()).toBe(baseline);

  // Sanity: polling itself is still alive after the flip.
  await nextRequest(page, PAYMENTS_CHECK_PATH);
});
