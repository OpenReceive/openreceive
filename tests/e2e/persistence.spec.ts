import { expect, test } from "@playwright/test";
import {
  addButtonToCart,
  bitcoinTile,
  downloadLink,
  expectPaidReceipt,
  expectWizardCurrencies,
  mintAttempt,
  openShop,
  selectFrameworkTab,
  settleTestkitInvoice,
  startCheckout,
} from "./helpers.ts";

/**
 * THE ACCEPTANCE DEMO, as much of it as a machine can run.
 *
 * This spec replaces the Hello Fruit suite's `resume.spec.ts`, which tested
 * `/checkout/:orderId` URL resume and a theme toggle — neither of which this
 * demo has, by decision rather than omission. What it tests instead is the
 * sentence the whole demo exists to prove:
 *
 *   > Buy a button. Come back in a fresh browser session and the download
 *   > still works. Open the site in a DIFFERENT browser and see the paid order
 *   > in the public feed with a UUID next to it — and no way to reach the
 *   > download.
 *
 * The hand-run version in the README is still the gate. This is the part that
 * can regress silently.
 */
test("a paid order outlives the page, and only its buyer can download it", async ({
  page,
  browser,
}) => {
  await openShop(page);
  await addButtonToCart(page);
  await startCheckout(page);
  await selectFrameworkTab(page, "react");
  await expectWizardCurrencies(page);

  const attempt = await mintAttempt(page, "/openreceive/checkouts", async () => {
    await bitcoinTile(page).click();
  });
  await settleTestkitInvoice(page, attempt.paymentHash);
  await expectPaidReceipt(page);

  const downloadPath = await downloadLink(page).getAttribute("href");
  expect(downloadPath).toBeTruthy();

  // ---------------------------------------------------------------- the buyer
  // A reload throws away every scrap of in-memory state — the cart, the store,
  // the order the page was holding. The signed cookie is all that is left, and
  // the row is on the server. The download must still work.
  await page.reload();
  const mine = await page.request.get(downloadPath as string);
  expect(mine.status(), "the buyer's own download after a reload").toBe(200);
  expect(mine.headers()["content-type"]).toBe("image/webp");

  // ------------------------------------------------------------- a stranger
  // A DIFFERENT browser: its own cookie jar, so its own visitor row. It can
  // see the purchase on the public feed and cannot touch the file.
  const stranger = await browser.newContext();
  try {
    const strangerPage = await stranger.newPage();
    await openShop(strangerPage);
    await strangerPage.locator(".or-shop-tabs label", { hasText: "Recent orders" }).click();

    const feedRow = strangerPage.locator(".or-shop-feed-row").first();
    await expect(feedRow).toBeVisible();
    await expect(feedRow).toContainText("$1.00");
    await expect(feedRow).toContainText("Safety Orange");
    // Anonymous to them: the buyer is a public uuid, and the YOU badge is the
    // page comparing it against its own bootstrap payload — which is a
    // different visitor here.
    await expect(feedRow.locator(".or-shop-feed-buyer")).toBeVisible();
    await expect(feedRow.locator(".or-shop-feed-you")).toHaveCount(0);

    // Possession of the path is a CLAIM, not proof. 404, never 403 — a 403
    // would confirm the order exists.
    const theirs = await strangerPage.request.get(downloadPath as string);
    expect(theirs.status(), "a stranger's attempt at the same download").toBe(404);
  } finally {
    await stranger.close();
  }
});
