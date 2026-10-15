import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
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
//   npm run trial:btcpay-route -- --store odoo|magento [--keep]

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
  /** What ran, for the passed.json entry. */
  readonly label: string;
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

const magentoDir = path.join(trialsRoot, "btcpay-route", "magento");

async function magentoCompose(network: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "docker",
      ["compose", "-p", "openreceive-btcpay-route-magento", ...args],
      {
        cwd: magentoDir,
        env: { ...process.env, BTCPAY_NETWORK: network },
        timeout: 30 * 60_000,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return `${stdout}\n${stderr}`;
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    // Head and tail: a PHP exception names itself at the top of a long trace.
    const output = `${failed.stdout ?? ""}\n${failed.stderr ?? ""}`.trim();
    const shown =
      output.length <= 3000 ? output : `${output.slice(0, 2000)}\n…\n${output.slice(-800)}`;
    throw new InfraError(`docker compose ${args.slice(0, 3).join(" ")} failed:\n${shown}`);
  }
}

/** One of the image's PHP scripts, inside the store; its RESULT line as key=value pairs. */
async function magentoScript(
  network: string,
  script: string,
  ...args: string[]
): Promise<Record<string, string>> {
  const output = await magentoCompose(network, [
    "exec",
    "-T",
    "-u",
    "www-data",
    "magento",
    "php",
    `/usr/local/share/btcpay-route/${script}`,
    ...args,
  ]);
  const line = output.split("\n").find((text) => text.startsWith("RESULT "));
  if (line === undefined)
    throw new InfraError(`${script} printed no RESULT:\n${output.slice(-1500)}`);
  return Object.fromEntries(
    line
      .slice("RESULT ".length)
      .split(" ")
      .map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
  );
}

/** Magento's REST API on the published port, as the store's own host name (its base URL). */
function magentoRest<T>(method: string, route: string, body?: unknown, token?: string): Promise<T> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const call = request(
      {
        host: "127.0.0.1",
        port: 18080,
        method,
        path: `/rest/V1${route}`,
        headers: {
          host: "magento",
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        timeout: 120_000,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => {
          if ((response.statusCode ?? 0) >= 400) {
            reject(
              new InfraError(
                `Magento ${method} ${route} answered ${response.statusCode}: ${text.slice(0, 300)}`,
              ),
            );
            return;
          }
          resolve(JSON.parse(text) as T);
        });
      },
    );
    call.on("error", reject);
    call.end(payload);
  });
}

const BUYER_ADDRESS = {
  firstname: "Widget",
  lastname: "Buyer",
  street: ["1 Main St"],
  city: "Austin",
  region_code: "TX",
  region_id: 57,
  postcode: "78701",
  country_id: "US",
  telephone: "5125550100",
  email: "buyer@widget-shop.test",
};

/**
 * Mage-OS 3.6 (Magento 2.4.9) with btcpayserver/magento2-plugin (Greenfield):
 * the merchant's settings and webhook, a guest's order through the REST
 * checkout with "Pay with Bitcoin", the module's forward-to-payment step that
 * the buyer's browser takes after Place Order, the payment, and the order paid
 * from BTCPay's webhook. The module's cron poll is the fallback, and the
 * checks say which one marked the order.
 */
async function runMagento(btcpay: Btcpay, wallet: TrialWallet, keep: boolean): Promise<Check[]> {
  const checks: Check[] = [];
  await magentoCompose(btcpay.network, ["down", "-v", "--remove-orphans"]);
  try {
    await magentoCompose(btcpay.network, ["build"]);
    await magentoCompose(btcpay.network, ["up", "-d", "--wait"]);
    // The module refuses an unrestricted key: it wants exactly the store
    // permissions its own "Generate API key" button asks BTCPay for.
    const scoped = await greenfield<{ apiKey: string }>(btcpay, "POST", "/api-keys", {
      label: "Magento",
      permissions: [
        "btcpay.store.cancreateinvoice",
        "btcpay.store.canmodifyinvoices",
        "btcpay.store.canviewinvoices",
        "btcpay.store.canviewstoresettings",
        "btcpay.store.webhooks.canmodifywebhooks",
      ].map((permission) => `${permission}:${btcpay.storeId}`),
    });
    await magentoCompose(btcpay.network, [
      "exec",
      "-T",
      "-u",
      "www-data",
      "-e",
      `BTCPAY_API_KEY=${scoped.apiKey}`,
      "-e",
      `BTCPAY_STORE_ID=${btcpay.storeId}`,
      "magento",
      "install-store",
    ]);
    const webhook = await magentoScript(btcpay.network, "install-webhook.php");
    // The module writes the webhook's new secret to the database and checks
    // deliveries against the config cache, so until the cache is refreshed
    // every delivery answers 400. A merchant refreshes it after setup.
    await magentoCompose(btcpay.network, [
      "exec",
      "-T",
      "-u",
      "www-data",
      "magento",
      "bin/magento",
      "cache:clean",
      "config",
    ]);
    checks.push(
      check(
        "store_webhook",
        webhook.webhook === "1",
        "Saving the BTCPay store created the store's webhook in BTCPay.",
        `webhook=${webhook.webhook}`,
      ),
    );
    const token = await magentoRest<string>("POST", "/integration/admin/token", {
      username: "owner",
      password: "Widget-shop-local-1",
    });
    await magentoRest(
      "POST",
      "/products",
      {
        product: {
          sku: "bezel",
          name: "Bezel",
          price: 12,
          status: 1,
          type_id: "simple",
          attribute_set_id: 4,
          visibility: 4,
          weight: 1,
          extension_attributes: { website_ids: [1], stock_item: { qty: 100, is_in_stock: true } },
        },
      },
      token,
    );
    // The new product is salable once the inventory indexes know it.
    await magentoCompose(btcpay.network, [
      "exec",
      "-T",
      "-u",
      "www-data",
      "magento",
      "bin/magento",
      "indexer:reindex",
    ]);
    const cart = await magentoRest<string>("POST", "/guest-carts");
    await magentoRest("POST", `/guest-carts/${cart}/items`, {
      cartItem: { sku: "bezel", qty: 1, quote_id: cart },
    });
    await magentoRest("POST", `/guest-carts/${cart}/shipping-information`, {
      addressInformation: {
        shipping_address: BUYER_ADDRESS,
        billing_address: BUYER_ADDRESS,
        shipping_carrier_code: "flatrate",
        shipping_method_code: "flatrate",
      },
    });
    const orderId = await magentoRest<number>("POST", `/guest-carts/${cart}/payment-information`, {
      email: BUYER_ADDRESS.email,
      paymentMethod: { method: "btcpay" },
      billingAddress: BUYER_ADDRESS,
    });
    const order = await magentoRest<{ increment_id: string; grand_total: number }>(
      "GET",
      `/orders/${orderId}`,
      undefined,
      token,
    );
    const forward = await magentoScript(
      btcpay.network,
      "forward-to-payment.php",
      order.increment_id,
    );
    const invoiceId =
      forward.url?.match(/\/i\/([A-Za-z0-9]+)/)?.[1] ??
      new URL(forward.url || "http://x/").searchParams.get("id") ??
      "";
    checks.push(
      check(
        "store_invoice",
        invoiceId.length > 0,
        "After Place Order with Pay with Bitcoin, the module created a BTCPay invoice and sent the buyer to it.",
        `order ${order.increment_id} for ${order.grand_total}: ${forward.url}`,
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
    let state: Record<string, string> = {};
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      state = await magentoScript(btcpay.network, "order-state.php", order.increment_id);
      if (state.invoiced === "1") break;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    checks.push(
      check(
        "store_notified",
        state.invoiced === "1",
        "BTCPay's webhook reached Magento and the module invoiced the order.",
        `order ${state.state}/${state.status}, invoiced ${state.invoiced}, paid ${state.paid}`,
      ),
    );
    if (state.invoiced !== "1") {
      // The module's 5-minute cron poll, run once by hand.
      await magentoCompose(btcpay.network, [
        "exec",
        "-T",
        "-u",
        "www-data",
        "magento",
        "bin/magento",
        "btcpay:invoices:update",
      ]);
      state = await magentoScript(btcpay.network, "order-state.php", order.increment_id);
    }
    checks.push(
      check(
        "store_order_paid",
        state.invoiced === "1" && Number(state.paid) >= order.grand_total,
        "Magento's order is invoiced and its whole total paid.",
        `order ${state.state}/${state.status}, paid ${state.paid}`,
      ),
    );
    return checks;
  } finally {
    if (!keep)
      await magentoCompose(btcpay.network, ["down", "-v", "--remove-orphans"]).catch(() => "");
  }
}

const STORES: Record<string, Store> = {
  odoo: {
    label: "Odoo 19 Community with btcpayserver/odoo 19.0.1.1",
    ssrfException: "odoo:8069",
    run: runOdoo,
  },
  magento: {
    label: "Mage-OS 3.6 (Magento 2.4.9) with btcpayserver/magento2-plugin 2.0.12",
    ssrfException: "magento:80",
    run: runMagento,
  },
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
    const passed = checks.every((item) => item.pass);
    if (passed) {
      // The published plugin that ran, and the BTCPay it ran on: the badge's facts.
      const receipt = JSON.parse(await readFile(`${directory}.plugin/download.json`, "utf8")) as {
        version: string;
        btcpayVersion: string;
      };
      const entry = {
        trial: name,
        date: new Date().toISOString().slice(0, 10),
        release: receipt.version.split(".").slice(0, 3).join("."),
        runs: 1,
        mode: "btcpay-route",
        store: store.label,
        btcpay: receipt.btcpayVersion,
      };
      console.log(`\npassed.json entry:\n${JSON.stringify(entry)}`);
    }
    process.exitCode = passed ? 0 : 1;
  } finally {
    await sandbox.stop(keep);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
