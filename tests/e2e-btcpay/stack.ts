import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type APIRequestContext, expect, type Page } from "@playwright/test";

/** Where the running stack is, from the browser test's point of view. */
export const stack = {
  btcpay: process.env.OPENRECEIVE_BTCPAY_URL ?? "http://127.0.0.1:14180",
  email: process.env.OPENRECEIVE_BTCPAY_EMAIL ?? "e2e@openreceive.test",
  password: process.env.OPENRECEIVE_BTCPAY_PASSWORD ?? "OpenReceive-e2e-Passw0rd!",
  testkit: process.env.OPENRECEIVE_E2E_TESTKIT_URL ?? "http://127.0.0.1:17790",
  testkitSpend: process.env.OPENRECEIVE_E2E_TESTKIT_SPEND_URL ?? "http://127.0.0.1:17791",
  fakeLsc: process.env.OPENRECEIVE_E2E_FAKELSC_URL ?? "https://127.0.0.1:17788",
  fakeLscHost: process.env.OPENRECEIVE_E2E_FAKELSC_HOST ?? "fake-lsc:7788",
  customerLnd: process.env.OPENRECEIVE_E2E_CUSTOMER_LND_URL,
  network: process.env.OPENRECEIVE_E2E_NETWORK ?? "openreceive-btcpay_default",
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The Greenfield key e2e.sh saved; BTCPay closes registration after the first admin. */
export function apiKey(): string {
  const fromEnv = process.env.OPENRECEIVE_BTCPAY_API_KEY;
  if (fromEnv) return fromEnv;
  const saved = path.join(repoRoot, "packages/dotnet/docker/.state/e2e-store");
  if (!existsSync(saved)) {
    throw new Error(
      "No API key: set OPENRECEIVE_BTCPAY_API_KEY or run packages/dotnet/docker/e2e.sh once (it saves one).",
    );
  }
  return readFileSync(saved, "utf8").trim().split(/\s+/)[1] ?? "";
}

export async function greenfield<T = unknown>(
  request: APIRequestContext,
  method: "GET" | "POST" | "PUT",
  route: string,
  body?: unknown,
): Promise<T> {
  const response = await request.fetch(`${stack.btcpay}${route}`, {
    method,
    headers: { Authorization: `token ${apiKey()}`, "Content-Type": "application/json" },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.ok(), `${method} ${route} -> ${response.status()} ${await response.text()}`).toBe(
    true,
  );
  return (await response.json()) as T;
}

export async function createStore(request: APIRequestContext): Promise<string> {
  const store = await greenfield<{ id: string }>(request, "POST", "/api/v1/stores", {
    name: `OpenReceive browser e2e ${new Date().toISOString()}`,
    defaultCurrency: "USD",
  });
  return store.id;
}

export async function createInvoice(
  request: APIRequestContext,
  storeId: string,
  amount: string,
): Promise<{ id: string; bolt11: string }> {
  const invoice = await greenfield<{ id: string }>(
    request,
    "POST",
    `/api/v1/stores/${storeId}/invoices`,
    {
      amount,
      currency: "USD",
      checkout: { paymentMethods: ["BTC-LN"] },
    },
  );
  const methods = await greenfield<{ paymentMethodId: string; destination: string }[]>(
    request,
    "GET",
    `/api/v1/stores/${storeId}/invoices/${invoice.id}/payment-methods`,
  );
  const lightning = methods.find((m) => m.paymentMethodId === "BTC-LN");
  expect(lightning?.destination, "the invoice has a BTC-LN bolt11").toMatch(/^lnbcrt/);
  return { id: invoice.id, bolt11: lightning?.destination ?? "" };
}

export async function invoiceStatus(
  request: APIRequestContext,
  storeId: string,
  invoiceId: string,
) {
  const invoice = await greenfield<{ status: string }>(
    request,
    "GET",
    `/api/v1/stores/${storeId}/invoices/${invoiceId}`,
  );
  return invoice.status;
}

export async function testkitNwcUri(
  request: APIRequestContext,
  spendCapable = false,
): Promise<string> {
  const response = await request.get(`${spendCapable ? stack.testkitSpend : stack.testkit}/uri`);
  expect(response.ok()).toBe(true);
  return (await response.text()).trim();
}

export async function fakeLscUri(request: APIRequestContext): Promise<string> {
  const response = await request.get(
    `${stack.fakeLsc}/__testkit/lsc-uri?host=${encodeURIComponent(stack.fakeLscHost)}`,
  );
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { uri: string }).uri;
}

export async function fakeLsc(
  request: APIRequestContext,
  control: string,
  body: unknown,
): Promise<void> {
  const response = await request.post(`${stack.fakeLsc}/__testkit/${control}`, { data: body });
  expect(response.ok(), `fake-lsc ${control} -> ${response.status()}`).toBe(true);
}

/**
 * Pays a BOLT11 from customer_lnd (REST, no macaroons). LND 0.21 dropped the legacy
 * sync route, so the router API is used; it streams status objects until final.
 */
export async function payFromCustomer(bolt11: string): Promise<void> {
  const body = JSON.stringify({
    payment_request: bolt11,
    timeout_seconds: 60,
    fee_limit_sat: 1000,
  });
  let text: string;
  if (stack.customerLnd) {
    const response = await fetch(`${stack.customerLnd.replace(/\/$/, "")}/v2/router/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    text = await response.text();
  } else {
    const run = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        stack.network,
        "openreceive-regtest-helper:local",
        "curl",
        "-sS",
        "-m",
        "120",
        "-X",
        "POST",
        "-H",
        "Content-Type: application/json",
        "--data",
        body,
        "http://customer_lnd:8080/v2/router/send",
      ],
      { encoding: "utf8" },
    );
    expect(run.status, run.stderr).toBe(0);
    text = run.stdout;
  }
  const lines = text.trim().split("\n").filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1] ?? "{}") as { result?: { status?: string } };
  expect(last.result?.status, text.slice(-400)).toBe("SUCCEEDED");
}

/** BTCPay's cookie login, through the real form. */
export async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(stack.email);
  await page.getByLabel("Password").fill(stack.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** Counts full-page navigations, to prove a screen changed by itself. */
export function watchReloads(page: Page): { readonly count: () => number } {
  let loads = 0;
  page.on("load", () => {
    loads += 1;
  });
  return { count: () => loads };
}
