import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { btcpayMerchant, installPlugin } from "./btcpay.ts";
import { startTrialChain } from "./chain.ts";
import { InfraError } from "./docker.ts";
import { check } from "./live.ts";
import { prepareShop, startShop } from "./sandbox.ts";
import type { Check, Platform } from "./types.ts";
import { startTrialWallet, type TrialWallet, trialWalletOverride } from "./wallet.ts";

// The BTCPay route (to-do item 11): a store on another platform takes payments
// through its own BTCPay Server integration, and BTCPay takes them with the
// OpenReceive plugin. A platform is listed only after this runs it end to end
// on one machine: the btcpay trial's stock BTCPay with the published plugin and
// the trial wallet, the store in Docker on BTCPay's network, one order paid
// over Lightning, and the store's own order paid. No model is involved.
//
//   npm run trial:btcpay-route -- --store odoo [--keep]

const execFileAsync = promisify(execFile);
const trialsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface Btcpay {
  /** As the host reaches it. */
  readonly baseUrl: string;
  readonly network: string;
  readonly apiKey: string;
  readonly storeId: string;
  readonly email: string;
  readonly password: string;
}

interface Store {
  /** BTCPay 2.4.5 refuses outbound HTTP to private addresses unless listed. */
  readonly ssrfException: string;
  readonly run: (btcpay: Btcpay, wallet: TrialWallet, keep: boolean) => Promise<Check[]>;
}

async function greenfield<T>(
  btcpay: Btcpay,
  method: string,
  route: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${btcpay.baseUrl}/api/v1${route}`, {
    method,
    headers: { authorization: `token ${btcpay.apiKey}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new InfraError(`BTCPay ${method} ${route} answered ${response.status}.`);
  return (await response.json()) as T;
}

/**
 * A legacy access-token pairing code the store owner approved, for stores on
 * BTCPay's BitPay-compatible API. Only BTCPay's UI makes one: Store Settings >
 * Access Tokens > Create, then Approve.
 */
async function approvedPairingCode(btcpay: Btcpay, label: string): Promise<string> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${btcpay.baseUrl}/login`);
    await page.fill("#Email", btcpay.email);
    await page.fill("#Password", btcpay.password);
    await Promise.all([page.waitForLoadState("networkidle"), page.click("#LoginButton")]);
    await page.goto(`${btcpay.baseUrl}/stores/${btcpay.storeId}/tokens/create`);
    await page.fill("input[name=Label]", label);
    await Promise.all([page.waitForLoadState("networkidle"), page.click("#page-primary")]);
    // The create step lands on the approval page, whose one button pairs the code.
    await Promise.all([page.waitForLoadState("networkidle"), page.click("#page-primary")]);
    const code = new URL(page.url()).searchParams.get("pairingCode");
    if (!code) throw new InfraError(`BTCPay showed no approved pairing code (${page.url()}).`);
    return code;
  } finally {
    await browser.close();
  }
}

/** Pay a BTCPay invoice's Lightning invoice on the trial wallet; true once BTCPay says Settled. */
async function payInvoice(
  btcpay: Btcpay,
  wallet: TrialWallet,
  invoiceId: string,
): Promise<boolean> {
  const methods = await greenfield<{ paymentMethodId: string; destination: string }[]>(
    btcpay,
    "GET",
    `/stores/${btcpay.storeId}/invoices/${invoiceId}/payment-methods`,
  );
  const bolt11 = methods.find((method) => method.paymentMethodId === "BTC-LN")?.destination;
  if (bolt11 === undefined) throw new InfraError(`Invoice ${invoiceId} has no Lightning method.`);
  const listed = (await wallet.invoices()) as
    | { invoice?: string; bolt11?: string; paymentHash?: string; payment_hash?: string }[]
    | {
        invoices?: {
          invoice?: string;
          bolt11?: string;
          paymentHash?: string;
          payment_hash?: string;
        }[];
      };
  const rows = Array.isArray(listed) ? listed : (listed.invoices ?? []);
  const row = rows.find((item) => (item.bolt11 ?? item.invoice) === bolt11);
  const hash = row?.paymentHash ?? row?.payment_hash;
  if (hash === undefined)
    throw new InfraError("The trial wallet holds no invoice for that BOLT11.");
  await wallet.settle(hash);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const invoice = await greenfield<{ status: string }>(
      btcpay,
      "GET",
      `/stores/${btcpay.storeId}/invoices/${invoiceId}`,
    );
    if (invoice.status === "Settled") return true;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return false;
}

const odooDir = path.join(trialsRoot, "btcpay-route", "odoo");
const ODOO_URL = "http://127.0.0.1:18069";

async function odooCompose(
  network: string,
  args: readonly string[],
  input?: string,
): Promise<string> {
  const child = execFileAsync(
    "docker",
    ["compose", "-p", "openreceive-btcpay-route-odoo", ...args],
    {
      cwd: odooDir,
      env: { ...process.env, BTCPAY_NETWORK: network },
      timeout: 15 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (input !== undefined) {
    child.child.stdin?.end(input);
  }
  const { stdout, stderr } = await child;
  return `${stdout}\n${stderr}`;
}

/** Runs one of the store's shell scripts and returns its RESULT line as key=value pairs. */
async function odooShell(
  network: string,
  script: string,
  env: Record<string, string>,
): Promise<Record<string, string>> {
  const output = await odooCompose(
    network,
    [
      "run",
      "--rm",
      "-T",
      ...Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
      "odoo",
      "odoo",
      "shell",
      "-d",
      "shop",
      "--no-http",
    ],
    await readFile(path.join(odooDir, script), "utf8"),
  );
  const line = output.split("\n").find((text) => text.startsWith("RESULT "));
  if (line === undefined)
    throw new InfraError(`odoo shell ${script} printed no RESULT:\n${output.slice(-1500)}`);
  return Object.fromEntries(
    line
      .slice("RESULT ".length)
      .split(" ")
      .map((pair) => pair.split("="))
      .filter((pair) => pair.length === 2),
  );
}

/**
 * Odoo 19 with btcpayserver/odoo (the BitPay-compatible API): the merchant pairs
 * the provider, a buyer's quotation gets a transaction, the payment form posts
 * it to /btcpay/checkout, the buyer pays the invoice BTCPay shows, BTCPay
 * notifies Odoo, and Odoo's post-processing confirms the order.
 */
async function runOdoo(btcpay: Btcpay, wallet: TrialWallet, keep: boolean): Promise<Check[]> {
  const checks: Check[] = [];
  await odooCompose(btcpay.network, ["down", "-v", "--remove-orphans"]);
  try {
    await odooCompose(btcpay.network, ["build"]);
    await odooCompose(btcpay.network, ["up", "-d", "--wait", "odoo-db"]);
    await odooCompose(btcpay.network, [
      "run",
      "--rm",
      "odoo",
      "odoo",
      "-d",
      "shop",
      "-i",
      "sale_management,payment_btcpayserver",
      "--without-demo=all",
      "--stop-after-init",
    ]);
    const code = await approvedPairingCode(btcpay, "Odoo");
    const setup = await odooShell(btcpay.network, "setup.py", { PAIRING_CODE: code });
    checks.push(
      check(
        "store_paired",
        setup.paired === "True",
        "Odoo paired its BTCPay provider with a code the store owner approved.",
        `order ${setup.order}, ${setup.amount} ${setup.tx ?? ""}`,
      ),
    );
    await odooCompose(btcpay.network, ["up", "-d", "odoo"]);
    const deadline = Date.now() + 180_000;
    while (
      !(await fetch(`${ODOO_URL}/web/login`).then(
        (r) => r.ok,
        () => false,
      ))
    ) {
      if (Date.now() > deadline) throw new InfraError("Odoo did not answer within 3 minutes.");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    // What the payment form's redirect posts.
    const checkout = await fetch(`${ODOO_URL}/btcpay/checkout`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ reference: setup.tx ?? "" }),
      redirect: "manual",
    });
    const location = checkout.headers.get("location") ?? "";
    const invoiceId = new URL(location, ODOO_URL).searchParams.get("id") ?? "";
    checks.push(
      check(
        "store_invoice",
        checkout.status === 303 && invoiceId.length > 0,
        "Odoo's checkout created a BTCPay invoice and sent the buyer to it.",
        `${checkout.status} ${location}`,
      ),
    );
    if (invoiceId.length === 0) return checks;
    const settled = await payInvoice(btcpay, wallet, invoiceId);
    checks.push(
      check(
        "btcpay_settled",
        settled,
        "The trial wallet paid the invoice's Lightning invoice and BTCPay marked it Settled.",
        invoiceId,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const after = await odooShell(btcpay.network, "check.py", { TX_REFERENCE: setup.tx ?? "" });
    checks.push(
      check(
        "store_notified",
        after.tx_state === "done",
        "BTCPay's notification reached Odoo and set the transaction done.",
        `tx ${after.tx_state}, BTCPay status ${after.btcpay_status}`,
      ),
      check(
        "store_order_paid",
        after.order_state === "sale",
        "Odoo confirmed the buyer's order once the payment was done.",
        `order ${after.order_state}, paid ${after.amount_paid}`,
      ),
    );
    return checks;
  } finally {
    if (!keep)
      await odooCompose(btcpay.network, ["down", "-v", "--remove-orphans"]).catch(() => "");
  }
}

const STORES: Record<string, Store> = {
  odoo: { ssrfException: "odoo:8069", run: runOdoo },
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const name = argv[argv.indexOf("--store") + 1];
  const keep = argv.includes("--keep");
  const store = name === undefined ? undefined : STORES[name];
  if (!argv.includes("--store") || store === undefined) {
    console.log(
      `Usage: npm run trial:btcpay-route -- --store <${Object.keys(STORES).join("|")}> [--keep]`,
    );
    process.exitCode = 2;
    return;
  }
  const platform = JSON.parse(
    await readFile(path.join(trialsRoot, "platforms", "btcpay", "platform.json"), "utf8"),
  ) as Platform;
  const wallet = await startTrialWallet();
  await startTrialChain();
  const directory = await prepareShop(
    path.join(trialsRoot, "platforms", "btcpay", "fixture"),
    "btcpay",
    { ...platform.platform_env, BTCPAY_SSRFEXCEPTIONS: store.ssrfException },
    platform.service,
    trialWalletOverride(platform.wallet_services ?? ["btcpayserver"], wallet),
  );
  const sandbox = await startShop(
    directory,
    path.join(trialsRoot, "platforms", "btcpay", "seed"),
    platform,
  );
  try {
    console.log(await installPlugin(directory));
    const merchant = await btcpayMerchant(directory);
    const btcpay: Btcpay = {
      baseUrl: sandbox.baseUrl,
      network: `${path.basename(directory).toLowerCase()}_default`,
      apiKey: merchant.apiKey,
      storeId: merchant.storeId,
      email: merchant.email,
      password: merchant.password,
    };
    // The merchant's step in the plugin: the store's Lightning node is the wallet.
    await greenfield(btcpay, "PUT", `/stores/${btcpay.storeId}/openreceive/settings`, {
      nwcUri: wallet.nwc,
    });
    const checks = await store.run(btcpay, wallet, keep);
    for (const item of checks) {
      console.log(
        `${item.pass ? "pass" : "FAIL"} ${item.id}: ${item.summary}${item.evidence ? ` (${item.evidence})` : ""}`,
      );
    }
    process.exitCode = checks.every((item) => item.pass) ? 0 : 1;
  } finally {
    await sandbox.stop(keep);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
