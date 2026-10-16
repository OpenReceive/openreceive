import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

function wp(code: string): string {
  return execFileSync(
    "docker",
    ["exec", "-u", "www-data", "openreceive-wp-test-wordpress-1", "wp", "eval", code],
    { encoding: "utf8" },
  ).trim();
}

// The same shop runs Easy Digital Downloads beside WooCommerce. A guest buys
// the seeded download: EDD's checkout records a pending order, its purchase
// confirmation page shows the checkout, and once the test wallet settles the
// invoice, the page reloads to the completed receipt.
test("guest Easy Digital Downloads purchase", async ({ page }, testInfo) => {
  const [download, checkoutUrl] = wp(
    'echo get_permalink(get_page_by_path("safety-orange-download", OBJECT, "download")), "\\n", edd_get_checkout_uri();',
  ).split("\n");
  await page.goto(download);
  const added = page.waitForResponse((response) => response.url().includes("admin-ajax.php"));
  await page.locator(".edd-add-to-cart").first().click();
  await added;
  await page.goto(checkoutUrl);
  await page.locator("#edd-email").fill("guest@example.test");
  await page.locator("#edd-first").fill("Demo");
  const invoiceResponse = page.waitForResponse(
    (response) => response.url().endsWith("/openreceive/v1/checkouts") && response.status() === 201,
  );
  await page.locator("#edd-purchase-button").click();
  const checkout = page.locator("openreceive-checkout");
  await expect(checkout).toBeVisible();
  await expect(checkout).toHaveAttribute("reference", /^edd-\d+$/);
  await checkout
    .getByRole("button", { name: /Bitcoin/ })
    .first()
    .click();
  const {
    checkout: { payment_hash: hash },
  } = await (await invoiceResponse).json();
  await page.screenshot({ path: testInfo.outputPath("edd-checkout.png"), fullPage: true });
  const settled = await page.request.post("/?rest_route=/openreceive/testkit/settle", {
    data: { payment_hash: hash },
  });
  expect(settled.ok()).toBeTruthy();
  await expect(checkout).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByText("Completed")).toBeVisible();
});
