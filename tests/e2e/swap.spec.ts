import { expect, test, type Page } from "@playwright/test";
import {
  addButtonToCart,
  expectPaidReceipt,
  expectWizardCurrencies,
  mintAttempt,
  type MintedAttempt,
  openShop,
  selectFrameworkTab,
  settleTestkitInvoice,
  startCheckout,
  stepTestkitSwap,
} from "./helpers.ts";

// Desktop viewport on purpose: a demo that loads its own sheet after the
// checkout styles can hide the >=640px network-selector panel, so running the
// swap flow at desktop width regression-tests that CSS ordering.
test.use({ viewport: { width: 1280, height: 900 } });

/** The testkit swap provider's fixed Tron facts (see packages/js/testkit). */
const USDT_TRON_DEPOSIT_ADDRESS = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
/** The deposit instruction names an amount the provider quoted; assert the shape, not the number. */
const USDT_DEPOSIT_INSTRUCTION = /Pay [\d.]+ USDT to this address/;
/** A checksum-valid Tron mainnet address that is NOT the deposit address. */
const VALID_TRON_REFUND_ADDRESS = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

/**
 * Walk shop → order → wizard → USDT → Tron network → Continue, and return the
 * swap attempt minted through POST /openreceive/swaps.
 */
async function startUsdtTronSwap(page: Page): Promise<MintedAttempt> {
  await openShop(page);
  await addButtonToCart(page);
  await startCheckout(page);
  await selectFrameworkTab(page, "react");
  await expectWizardCurrencies(page);

  await page.getByRole("button", { name: /USDT/ }).click();
  await expect(page.getByRole("heading", { name: /Choose USDT network/ })).toBeVisible();
  const attempt = await mintAttempt(page, "/openreceive/swaps", async () => {
    // Scoped to the network step. The USDT TILE now names the networks that coin
    // can arrive on ("Tron · Solana · Ethereum"), so an unscoped "Tron" match
    // finds the tile itself and closes the step instead of answering it.
    await page
      .getByRole("group", { name: /Choose USDT network/ })
      .getByRole("button", { name: "Tron" })
      .first()
      .click();
    await page.getByRole("button", { name: "Continue" }).first().click();
  });
  expect(attempt.depositAddress).toBe(USDT_TRON_DEPOSIT_ADDRESS);
  expect(attempt.providerOrderId).toBeDefined();
  return attempt;
}

test("USDT on Tron: deposit renders, provider advances to done, settle pays the order", async ({
  page,
}) => {
  const attempt = await startUsdtTronSwap(page);
  const selector = { provider_order_id: attempt.providerOrderId as string };

  // Deposit panel: amount instruction, address, and the provider countdown.
  await expect(page.getByText(USDT_DEPOSIT_INSTRUCTION)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Address", exact: true })).toHaveValue(
    USDT_TRON_DEPOSIT_ADDRESS,
  );
  await expect(page.getByText("Waiting for your payment")).toBeVisible();
  await expect(page.getByText(/^\d{1,2}:\d{2}$/)).toBeVisible();

  // Advance the provider: awaiting_deposit → confirming → completed. The page
  // learns each step from its own status polling.
  await stepTestkitSwap(page, selector, "confirming");
  await expect(page.getByText("Confirming payment")).toBeVisible();
  await stepTestkitSwap(page, selector, "completed");
  await expect(page.getByText("Finalizing checkout")).toBeVisible();

  // The provider "paid" the shadow Lightning invoice: settle it in the wallet.
  await settleTestkitInvoice(page, attempt.paymentHash);
  await expectPaidReceipt(page);
});

test("USDT on Tron refund path: refund_required → validated address → confirmed refund", async ({
  page,
}) => {
  const attempt = await startUsdtTronSwap(page);
  const selector = { provider_order_id: attempt.providerOrderId as string };
  await expect(page.getByText(USDT_DEPOSIT_INSTRUCTION)).toBeVisible();

  await stepTestkitSwap(page, selector, "refund_required");
  await expect(page.getByText("Refund needed")).toBeVisible();

  // Submit a checksum-valid Tron address; the first submit stages it for review.
  const addressInput = page.getByPlaceholder("Tron refund address");
  await addressInput.fill(VALID_TRON_REFUND_ADDRESS);
  await page.getByRole("button", { name: "Review refund address" }).click();
  await expect(page.getByText(`Confirm refund to ${VALID_TRON_REFUND_ADDRESS}.`)).toBeVisible();

  // Confirming sends the refund request to the provider; the testkit provider
  // flips the order to refund_pending, which the next status poll renders.
  await page.getByRole("button", { name: "Confirm refund" }).click();
  await expect(page.getByText("Refund pending")).toBeVisible();
  await expect(page.getByText("Your refund request has been sent.")).toBeVisible();

  // The provider really received the confirmed, validated address.
  const state = await page.request.get("/__testkit/state");
  const body = (await state.json()) as {
    swap: {
      refund_calls: {
        provider_order_id?: string;
        providerOrderId?: string;
        refundAddress: string;
      }[];
    };
  };
  expect(body.swap.refund_calls).toContainEqual(
    expect.objectContaining({ refundAddress: VALID_TRON_REFUND_ADDRESS }),
  );
});
