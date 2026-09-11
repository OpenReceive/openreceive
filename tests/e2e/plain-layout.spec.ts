import { expect, test } from "@playwright/test";
import { addButtonToCart, expectWizardCurrencies, openShop, startCheckout } from "./helpers.ts";

test.skip(process.env.OPENRECEIVE_E2E_STACK !== "php-plain", "Plain PHP demo regressions");

for (const width of [390, 1280]) {
  test(`plain checkout stays usable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await openShop(page);
    await addButtonToCart(page);
    await startCheckout(page);
    await expectWizardCurrencies(page);
    const thumbnail = page.locator(".or-shop-order-thumbs img").first();
    await expect(thumbnail).toBeVisible();
    const box = await thumbnail.boundingBox();
    expect(box?.width).toBe(34);
    expect(box?.height).toBe(34);
    const layout = await page.evaluate(() => ({
      font: getComputedStyle(document.body).fontFamily,
      overflow: document.documentElement.scrollWidth > window.innerWidth,
    }));
    expect(layout.font).toContain("sans-serif");
    expect(layout.overflow).toBe(false);
    await expect(page.locator(".or-shop-keeplink")).toBeVisible();
    const summary = await page.locator(".or-checkout-summary").boundingBox();
    const pay = await page.locator(".or-checkout-pay").boundingBox();
    if (!summary || !pay) throw new Error("Checkout columns must be visible");
    if (width >= 880) expect(pay.x).toBeGreaterThan(summary.x + summary.width);
    else expect(pay.y).toBeGreaterThan(summary.y + summary.height);
    await page.screenshot({ path: testInfo.outputPath("checkout.png"), fullPage: true });
  });
}

test("plain checkout retries a rate outage without losing the order", async ({ page }) => {
  const prepare = "**/openreceive/checkouts/prepare";
  await page.route(prepare, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        code: "INTERNAL",
        message: "Exchange rates are temporarily unavailable — please try again in a moment.",
        retryable: true,
      }),
    }),
  );
  await openShop(page);
  await addButtonToCart(page);
  await startCheckout(page);
  await expect(page.getByText("Could not start checkout.")).toBeVisible();
  const orderURL = page.url();
  await expect(page.getByText("Keep this order id")).toBeVisible();
  await page.unroute(prepare);
  await page.getByRole("button", { name: "Try again" }).click();
  await expectWizardCurrencies(page);
  expect(page.url()).toBe(orderURL);
});
