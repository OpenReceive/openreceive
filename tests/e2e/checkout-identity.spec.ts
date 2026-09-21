import { expect, test } from "@playwright/test";
import {
  addButtonToCart,
  openShop,
  selectFrameworkTab,
  settleTestkitInvoice,
  startCheckout,
} from "./helpers.ts";

interface HeldCheckout {
  readonly reference: string;
  readonly payment_hash: string;
  readonly bolt11: string;
  release(): void;
}

test("changing a mounted checkout reference discards a late invoice and its settlement", async ({
  page,
}) => {
  // Model a transport whose response is already in flight when cancellation
  // arrives. Both bodies still come from the real Docker backend and wallet.
  await page.addInitScript(() => {
    const fetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init) => {
      if (new URL(String(input), location.href).pathname === "/openreceive/checkouts") {
        return fetch(input, { ...init, signal: undefined });
      }
      return fetch(input, init);
    };
  });
  const held: HeldCheckout[] = [];
  const checks: { reference: string; payment_hash: string }[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/openreceive/payments/check") {
      checks.push(request.postDataJSON());
    }
  });
  await page.route("**/openreceive/checkouts", async (route) => {
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    const { checkout } = await response.json();
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    held.push({ ...checkout, release });
    await pending;
    await route.fulfill({ response });
  });

  try {
    await openShop(page);
    await addButtonToCart(page);
    await startCheckout(page);
    await selectFrameworkTab(page, "vue");
    const element = page.locator("openreceive-checkout");
    await expect(element).toBeVisible();
    const referenceA = await element.getAttribute("reference");
    await element.getByRole("button", { name: /^Bitcoin/ }).click();
    await expect.poll(() => held.length).toBe(1);
    expect(held[0].reference).toBe(referenceA);

    // The host creates another real order under the same authenticated visitor.
    const { shop: catalog } = await (await page.request.get("/shop/bootstrap")).json();
    const orderResponse = await page.request.post("/shop/orders", {
      data: { items: [{ sku: catalog.catalog[0].sku, quantity: 2 }] },
    });
    expect(orderResponse.status()).toBe(201);
    const { reference: referenceB } = await orderResponse.json();
    expect(referenceB).not.toBe(referenceA);
    await element.evaluate((node, reference) => {
      node.setAttribute("data-test-settlements", "0");
      node.addEventListener("openreceive-settled", () => {
        node.setAttribute("data-test-settlements", "1");
      });
      node.setAttribute("reference", reference);
    }, referenceB);
    await expect(element).toHaveAttribute("reference", referenceB);
    await element.getByRole("button", { name: /^Bitcoin/ }).click();
    await expect.poll(() => held.length).toBe(2);
    expect(held[1].reference).toBe(referenceB);

    // A's late completion must not clear B's in-flight state or publish A's QR.
    held[0].release();
    await page.waitForResponse((response) => {
      return (
        new URL(response.url()).pathname === "/openreceive/checkouts" &&
        response.request().postDataJSON().reference === referenceA
      );
    });
    await expect(element).toContainText("Preparing payment");
    await expect(element).not.toHaveAttribute("invoice", held[0].bolt11);
    await expect(element).not.toHaveAttribute("payment-hash", held[0].payment_hash);

    held[1].release();
    await expect(element).toHaveAttribute("invoice", held[1].bolt11);
    await expect(element).toHaveAttribute("payment-hash", held[1].payment_hash);
    await settleTestkitInvoice(page, held[0].payment_hash);
    await expect
      .poll(() => checks.filter((check) => check.reference === referenceB).length)
      .toBeGreaterThanOrEqual(2);
    expect(checks.every((check) => check.reference === referenceB)).toBe(true);
    expect(checks.every((check) => check.payment_hash === held[1].payment_hash)).toBe(true);
    await expect(element).toHaveAttribute("data-test-settlements", "0");
    await expect(element).toContainText("Waiting for payment");
    await expect(element).not.toContainText("Payment received");
  } finally {
    for (const response of held) response.release();
  }
});
