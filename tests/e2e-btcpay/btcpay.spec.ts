import { expect, type Page, test } from "@playwright/test";
import {
  createInvoice,
  createStore,
  fakeLsc,
  fakeLscUri,
  greenfield,
  invoiceStatus,
  login,
  payFromCustomer,
  testkitNwcUri,
  watchReloads,
} from "./stack.ts";

/**
 * The plugin plan's acceptance, through a real browser: a fresh store goes from "no
 * wallet" to a paid regtest invoice using only the setup page, then pays an invoice
 * through a swap in BTCPay's own checkout, refunds a failed one, and is refused a
 * spend-capable code. Serial: every test builds on the store the first one wires.
 */
test.describe.configure({ mode: "serial" });

let storeId = "";

/**
 * The pills are Vue-bound (`v-on:click.prevent`); before BTCPay's checkout app mounts,
 * a click would just follow the pill's `href="#…"`. The Lightning body is rendered by
 * the app, so its presence proves the app is up.
 */
async function checkoutReady(page: Page): Promise<void> {
  await expect(page.locator("#Lightning_BTC-LN")).toBeVisible();
}

/**
 * Picks a swap pill. The plugin's per-provider weight budget allows about three provider
 * creates per minute (a create costs 50 of 150, polls cost 1 each), so a run that creates
 * several swaps back to back can see the "rate limited" refusal; that is correct
 * behavior, so wait out the window once and try again.
 */
async function pickAsset(page: Page, label: string): Promise<void> {
  const panel = page.locator(".openreceive-swap");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await checkoutReady(page);
    await page.getByRole("link", { name: label }).click();
    await expect(panel).toBeVisible();
    await expect
      .poll(
        async () =>
          (await panel.getAttribute("data-state")) !== "loading" ||
          (await panel.locator(".alert-danger").count()) > 0,
        {
          timeout: 60_000,
        },
      )
      .toBe(true);
    if ((await panel.locator(".alert-danger").count()) === 0) return;
    const message = await panel.locator(".alert-danger").innerText();
    expect(message, "only the provider weight budget may refuse a create here").toMatch(
      /rate limited/i,
    );
    await page.waitForTimeout(61_000);
    await page.reload();
  }
  throw new Error("the provider budget did not free up");
}

function secretOf(nwcUri: string): string {
  const at = nwcUri.indexOf("secret=") + "secret=".length;
  return nwcUri.slice(at, at + 64);
}

test("setup page: paste a receive-only NWC code, test it, make it the store's Lightning node", async ({
  page,
  request,
}) => {
  storeId = await createStore(request);
  const nwc = await testkitNwcUri(request);
  await login(page);
  await page.goto(`/plugins/${storeId}/openreceive`);
  await expect(page.getByRole("heading", { name: "OpenReceive" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "1. Lightning Inbound Payments" })).toBeVisible();
  // Swaps settle into the wallet: the section does not exist until one is connected.
  await expect(page.getByRole("heading", { name: /2\. Swaps/ })).toHaveCount(0);

  await page.getByLabel("Receive-only NWC code").fill(nwc);
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText("Wallet ready")).toBeVisible();
  const report = page.locator(".card", { hasText: "Wallet ready" });
  await expect(report).toContainText("nip44_v2");
  await expect(report).toContainText("payment_received");
  await expect(report).toContainText("regtest");
  await expect(report).toContainText("no spend permissions");
  // The capability report never carries the secret (the textarea still holds the paste until it is saved).
  expect(await report.innerHTML()).not.toContain(secretOf(nwc));

  await page.getByLabel("Receive-only NWC code").fill(nwc);
  await page.getByRole("button", { name: "Save NWC Code" }).click();
  await expect(
    page.getByText("This store now receives Lightning payments into your NWC wallet."),
  ).toBeVisible();
  // Once saved, the page shows a calm one-liner (wallet id, relay), never the code.
  await expect(page.getByText("Wallet connected.")).toBeVisible();
  await expect(page.getByText("Invoices are minted in wallet")).toContainText("relay-tls");
  expect(await page.content()).not.toContain(secretOf(nwc));
  expect(await page.content()).not.toContain(nwc.slice(0, 60)); // not even the pubkey-bearing prefix; the placeholder is generic
  // The store nav now carries the plugin entry, and the swaps section now exists.
  await expect(page.locator("#Nav-OpenReceive")).toBeVisible();
  await expect(page.getByRole("heading", { name: /2\. Swaps/ })).toBeVisible();
});

test("setup page: a spend-capable code is refused with the reason, and admitted only with the override", async ({
  page,
  request,
}) => {
  const spend = await testkitNwcUri(request, true);
  await login(page);
  await page.goto(`/plugins/${storeId}/openreceive`);
  // The store is connected already: the paste box lives behind "Change NWC receive code", and the
  // risk checkbox does not exist until a test has found a spend method.
  await expect(page.getByLabel("This wallet cannot mint a receive-only code")).toHaveCount(0);
  await page.getByText("Change NWC receive code").click();
  await page.getByLabel("New receive-only NWC code").fill(spend);
  await page.getByRole("button", { name: "Save NWC Code" }).click();
  await expect(page.getByText("Wallet refused")).toBeVisible();
  await expect(page.locator(".card", { hasText: "Wallet refused" })).toContainText("pay_invoice");
  await expect(page.locator(".card", { hasText: "Wallet refused" })).toContainText(
    "get_a_nwc_code_to_receive_payments",
  );

  await page.getByLabel("New receive-only NWC code").fill(spend);
  await page
    .getByLabel("This wallet cannot mint a receive-only code and I accept the risk")
    .check();
  await page.getByRole("button", { name: "Save NWC Code" }).click();
  await expect(
    page.getByText("This store now receives Lightning payments into your NWC wallet."),
  ).toBeVisible();
  await expect(page.getByText("Spend-capable override on.")).toBeVisible();

  // Back to the receive-only wallet for the checkout specs. The override stays ticked
  // until it is unticked: the checkbox is on the page while the override is on.
  await page.getByText("Change NWC receive code").click();
  await page.getByLabel("New receive-only NWC code").fill(await testkitNwcUri(request));
  await page
    .getByLabel("This wallet cannot mint a receive-only code and I accept the risk")
    .uncheck();
  await page.getByRole("button", { name: "Save NWC Code" }).click();
  await expect(page.getByText("Wallet connected.")).toBeVisible();
  await expect(page.getByText("Spend-capable override on.")).toHaveCount(0);
});

test("checkout: a Lightning invoice minted in the NWC wallet flips to paid in the browser", async ({
  page,
  request,
}) => {
  const invoice = await createInvoice(request, storeId, "2.50");
  await page.goto(`/i/${invoice.id}`);
  const reloads = watchReloads(page);
  // BTCPay's own Lightning body, fed by our client's bolt11.
  await expect(page.locator("#Lightning_BTC-LN")).toBeVisible();
  const qrValue = await page
    .locator(".qr-container[data-clipboard]")
    .first()
    .getAttribute("data-clipboard");
  expect(qrValue?.toLowerCase()).toContain(invoice.bolt11.toLowerCase());

  await payFromCustomer(invoice.bolt11);
  await expect(page.getByRole("heading", { name: "Invoice Paid" })).toBeVisible();
  expect(reloads.count()).toBe(0);
  expect(await invoiceStatus(request, storeId, invoice.id)).toBe("Settled");
});

test("setup page: connect the swap provider, enable swaps, and the doctor is all green", async ({
  page,
  request,
}) => {
  const lsc = await fakeLscUri(request);
  await login(page);
  await page.goto(`/plugins/${storeId}/openreceive`);
  // No backup field until a primary code is saved.
  await expect(page.getByLabel("Backup Lightning Swap Connect code")).toHaveCount(0);
  await page.getByLabel("Lightning Swap Connect code (primary)").fill(lsc);
  await page.getByRole("button", { name: "Test provider" }).click();
  await expect(page.getByText("Provider fake-lsc-7788")).toBeVisible();
  await expect(page.getByText(/USDT · Tron — available/)).toBeVisible();

  // A saved primary code is what turns swaps on: there is no separate switch.
  await page.getByLabel("Lightning Swap Connect code (primary)").fill(lsc);
  await page.getByRole("button", { name: "Save swap settings" }).click();
  await expect(
    page.getByText(/Invoice expiration raised to 60 minutes|Swap settings saved/),
  ).toBeVisible();
  await expect(page.getByText("Swaps on.")).toBeVisible();
  await expect(page.getByText("Provider fake-lsc")).toBeVisible();
  // The form is folded away once a code is saved; the key and secret are not in the HTML.
  await expect(page.getByLabel("Lightning Swap Connect code (primary)")).toBeHidden();
  expect(await page.content()).not.toContain("test-secret");
  // The backup provider now exists, folded away behind its own disclosure.
  await page.getByText("Change swap provider").click();
  await expect(page.getByLabel("Backup Lightning Swap Connect code")).toBeHidden();
  await page.getByText("Backup provider").click();
  await expect(page.getByLabel("Backup Lightning Swap Connect code")).toBeVisible();

  // The probes render in place on the setup page (the same list as the /doctor page).
  await page.getByRole("button", { name: "Run a health check" }).click();
  await expect(page.getByRole("heading", { name: "OpenReceive", exact: true })).toBeVisible();
  // The results do not pop the "Change NWC receive code" box open.
  await expect(page.getByLabel("New receive-only NWC code")).toBeHidden();
  const probes = page.locator(".list-group-item");
  await expect(probes).toHaveCount(10);
  await expect(page.locator(".list-group-item", { hasText: "⚠️" })).toHaveCount(0);
  await expect(page.getByText("Provider fake-lsc-7788 reachable")).toBeVisible();
  await expect(page.getByText("Invoice expiration covers the provider window")).toBeVisible();
  // OK puts the results away again.
  await page.getByRole("link", { name: "OK", exact: true }).click();
  await expect(page.locator(".list-group-item")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run a health check" })).toBeVisible();
});

test("checkout: pay with USDT on Tron through the swap component until BTCPay shows Invoice Paid", async ({
  page,
  request,
}) => {
  await fakeLsc(request, "script", {
    selector: "USDT_TRON",
    states: ["confirming", "exchanging", "completed"],
  });
  const invoice = await createInvoice(request, storeId, "25.00");
  const consoleLog: string[] = [];
  page.on("console", (message) => consoleLog.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => consoleLog.push(`pageerror: ${error.message}`));
  await page.goto(`/i/${invoice.id}`);

  // Seven pills from the plugin, next to BTCPay's own.
  for (const label of [
    "USDT · Tron",
    "USDT · Solana",
    "USDC · Solana",
    "SOL · Solana",
    "ETH · Ethereum",
    "USDT · Ethereum",
    "USDC · Ethereum",
  ]) {
    await expect(page.getByRole("link", { name: label })).toBeVisible();
  }
  await pickAsset(page, "USDT · Tron");
  // Counted from here: pickAsset may reload once while waiting out the provider budget.
  const reloads = watchReloads(page);

  const panel = page.locator(".openreceive-swap");
  await expect(panel, `browser console:\n${consoleLog.join("\n")}`).toBeVisible();
  await expect(panel).toHaveAttribute("data-state", "awaiting_deposit");
  await expect(panel.getByText("Wrong currency or network = lost funds")).toBeVisible();
  await expect(panel.getByText(/USDT on the Tron network/)).toBeVisible();
  await expect(panel.locator("svg")).toBeVisible(); // the QR
  const address = await panel.getByLabel("Address").inputValue();
  expect(address).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
  const amount = await panel.getByLabel(/^Amount/).inputValue();
  expect(amount).toMatch(/^\d+(\.\d+)? USDT$/);
  await expect(panel.getByText(/Includes the provider's fee/)).toBeVisible();
  await expect(panel.getByText(/Address valid for/)).toContainText(/\d\d:\d\d/);

  // Copy row copies the bare address.
  await panel.getByRole("button", { name: "Copy" }).nth(1).click();
  await expect(panel.getByRole("button", { name: "Copied" })).toBeVisible();
  // The async clipboard API exists only in a secure context (https or localhost); over a
  // plain http host name the component falls back to execCommand, which cannot be read back.
  if (await page.evaluate(() => Boolean(navigator.clipboard))) {
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(address);
  }

  // The poller advances the scripted provider every 5 s; the component polls the swap
  // every 5 s and refreshes the invoice through BTCPay's status endpoint, so BTCPay's
  // own paid screen must take over with no reload.
  // The provider completes within a few polls, so the intermediate states may flash by
  // before a 5-second tick; the observable outcome is BTCPay's own paid screen.
  await expect(page.getByRole("heading", { name: "Invoice Paid" })).toBeVisible({
    timeout: 120_000,
  });
  expect(reloads.count()).toBe(0);
  expect(await invoiceStatus(request, storeId, invoice.id)).toBe("Settled");
});

test("checkout: an underpaid swap asks for a refund address, rejects a bad checksum, accepts a good one", async ({
  page,
  request,
}) => {
  const invoice = await createInvoice(request, storeId, "30.00");
  await page.goto(`/i/${invoice.id}`);
  await pickAsset(page, "USDT · Tron");
  const panel = page.locator(".openreceive-swap");
  await expect(panel).toHaveAttribute("data-state", "awaiting_deposit");
  // Force THIS order (by provider order id, from the merchant API) into an underpaid emergency.
  const rows = await greenfield<{ providerOrderId: string }[]>(
    request,
    "GET",
    `/api/v1/stores/${storeId}/openreceive/invoices/${invoice.id}/swaps`,
  );
  expect(rows).toHaveLength(1);
  await fakeLsc(request, "force-refund-required", {
    selector: rows[0]?.providerOrderId,
    reason: "underpaid",
  });
  await expect(panel).toHaveAttribute("data-state", "refund_required", { timeout: 60_000 });
  await expect(panel.getByText("Refund needed")).toBeVisible();
  await expect(panel.getByText(/below the quoted amount/)).toBeVisible();
  // The deposit instructions are gone: no address to keep paying to.
  await expect(panel.getByText(/Address valid for/)).toHaveCount(0);

  const input = panel.getByPlaceholder("Paste an address you control");
  await input.fill("TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBg");
  await panel.getByRole("button", { name: "Request refund" }).click();
  await expect(panel.getByText(/failed its checksum/)).toBeVisible();

  await input.fill("TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf");
  await panel.getByRole("button", { name: "Request refund" }).click();
  await expect(panel).toHaveAttribute("data-state", "refund_pending");
  await expect(panel.getByText("Refund pending")).toBeVisible();
  await expect(panel.getByText("TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf")).toBeVisible();

  // Merchant side: the invoice page lists the swap with its refund state.
  await login(page);
  await page.goto(`/invoices/${invoice.id}`);
  await expect(page.getByRole("heading", { name: "OpenReceive swaps" })).toBeVisible();
  await expect(page.getByText("Refund pending")).toBeVisible();
  await expect(page.getByText("underpaid")).toBeVisible();
});

test("checkout: switching back from a swap pill to Lightning keeps BTCPay's own body working", async ({
  page,
  request,
}) => {
  const invoice = await createInvoice(request, storeId, "25.00");
  await page.goto(`/i/${invoice.id}`);
  await pickAsset(page, "SOL · Solana");
  const panel = page.locator(".openreceive-swap");
  await expect(panel).toHaveAttribute("data-state", "awaiting_deposit");
  // Native rail: the QR encodes a solana: URI with the amount, and the warning is the quiet one.
  await expect(panel.getByText("Send exactly this amount")).toBeVisible();
  // With swap pills on the row, BTCPay's own Lightning pill carries the ₿ mark the plugin adds from <head> (the rule survives Vue's mount).
  const lightningPill = page
    .locator(".btcpay-pills a.payment-method:not(.openreceive-pill)")
    .first();
  expect(
    await lightningPill.evaluate((el) => getComputedStyle(el, "::before").backgroundImage),
  ).toContain("btc.svg");
  await page
    .getByRole("link", { name: /Lightning/ })
    .first()
    .click();
  await expect(page.locator("#Lightning_BTC-LN")).toBeVisible();
  await expect(panel).toHaveCount(0);
});
