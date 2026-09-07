import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

function wp(code: string): string {
  return execFileSync(
    "docker",
    ["exec", "-u", "www-data", "openreceive-wp-test-wordpress-1", "wp", "eval", code],
    { encoding: "utf8" },
  ).trim();
}

let original: { content: string; permalinks: string };
test.beforeAll(() => {
  original = JSON.parse(
    wp(
      'echo json_encode(["content" => get_post(wc_get_page_id("checkout"))->post_content, "permalinks" => get_option("permalink_structure")]);',
    ),
  );
});
test.afterAll(() => {
  const state = Buffer.from(JSON.stringify(original)).toString("base64");
  wp(
    `$s=json_decode(base64_decode("${state}"), true); wp_update_post(["ID"=>wc_get_page_id("checkout"), "post_content"=>$s["content"]]); update_option("permalink_structure", $s["permalinks"]); flush_rewrite_rules();`,
  );
});

for (const mode of ["blocks", "classic", "plain-permalinks", "swap-refund"] as const) {
  test(`guest ${mode} checkout`, async ({ page, browser }, testInfo) => {
    const content = Buffer.from(
      mode === "classic" ? "[woocommerce_checkout]" : original.content,
    ).toString("base64");
    const permalinks = mode === "plain-permalinks" ? "" : "/%postname%/";
    const checkoutUrl = wp(
      `wp_update_post(["ID"=>wc_get_page_id("checkout"), "post_content"=>base64_decode("${content}")]); update_option("permalink_structure", "${permalinks}"); flush_rewrite_rules(); echo wc_get_checkout_url();`,
    );
    await page.goto("/");
    await page.getByRole("link", { name: "Safety Orange", exact: true }).first().click();
    await page.getByRole("button", { name: "Add to cart", exact: true }).click();
    await page.goto(checkoutUrl);
    await page.getByLabel("Email address", { exact: false }).first().fill("guest@example.test");
    await page.getByLabel("First name", { exact: false }).first().fill("Demo");
    await page.getByLabel("Last name", { exact: false }).first().fill("Payer");
    const address = page.getByLabel("Address", { exact: true }).first();
    if (await address.isVisible()) await address.fill("1 Demo Street");
    const street = page.getByRole("textbox", { name: /Street address/ }).first();
    if (await street.isVisible()) await street.fill("1 Demo Street");
    const city = page.getByLabel(/City|Town/).first();
    if (await city.isVisible()) await city.fill("Los Angeles");
    const postcode = page.getByLabel(/ZIP Code|Postal code|Postcode/).first();
    if (await postcode.isVisible()) await postcode.fill("90001");
    const invoiceResponse = page.waitForResponse(
      (response) =>
        response
          .url()
          .endsWith(`/openreceive/v1/${mode === "swap-refund" ? "swaps" : "checkouts"}`) &&
        response.status() === 201,
    );
    await page.getByRole("button", { name: /Place order/i }).click();
    await expect(page).toHaveURL(/order-pay/);
    const checkout = page.locator("openreceive-checkout");
    await expect(checkout).toBeVisible();
    if (mode === "swap-refund") {
      await checkout.getByRole("button", { name: /USDT/ }).click();
      await checkout
        .getByRole("group", { name: /Choose USDT network/ })
        .getByRole("button", { name: "Tron" })
        .first()
        .click();
      await checkout.getByRole("button", { name: "Continue" }).first().click();
      const { swap } = await (await invoiceResponse).json();
      expect(swap.checkout.payment_hash).toMatch(/^[0-9a-f]{64}$/);
      await expect(checkout.getByText(/Pay [\d.]+ USDT to this address/)).toBeVisible();
      const returnUrl = page.url();
      await page.request.post("/?rest_route=/openreceive/testkit/swap-step", {
        data: { pay_in_asset: "USDT_TRON", state: "refund_required" },
      });
      // A fresh browser has neither the checkout session nor the signed cookie.
      // Possession of WooCommerce's order-pay key must restore authorized recovery.
      const returning = await browser.newContext();
      try {
        const recovery = await returning.newPage();
        await recovery.goto(returnUrl);
        await expect(recovery.locator("openreceive-checkout")).toHaveAttribute(
          "resume-payment-hash",
          swap.checkout.payment_hash,
        );
        await expect(recovery.getByText("Refund needed")).toBeVisible();
        await recovery.getByPlaceholder("Tron refund address").fill(swap.deposit_address);
        await recovery.getByRole("button", { name: "Review refund address" }).click();
        await recovery.getByRole("button", { name: "Confirm refund" }).click();
        await expect(recovery.getByText("Refund pending")).toBeVisible();
      } finally {
        await returning.close();
      }
      return;
    }
    await checkout
      .getByRole("button", { name: /Bitcoin/ })
      .first()
      .click();
    const {
      checkout: { payment_hash: hash },
    } = await (await invoiceResponse).json();
    await page.screenshot({ path: testInfo.outputPath("checkout.png"), fullPage: true });
    const settled = await page.request.post("/?rest_route=/openreceive/testkit/settle", {
      data: { payment_hash: hash },
    });
    expect(settled.ok()).toBeTruthy();
    await expect(page).toHaveURL(/order-received/, { timeout: 60_000 });
    await expect(page.getByText(/Thank you. Your order has been received./)).toBeVisible();
  });
}
