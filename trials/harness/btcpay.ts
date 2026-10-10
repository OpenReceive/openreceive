import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stagePublishedPlugin } from "../../tools/dotnet/published-plugin.mjs";
import { compose, InfraError } from "./docker.ts";
import { check, type PaidPath } from "./live.ts";
import type { ShopEvidence } from "./sandbox.ts";
import type { Check } from "./types.ts";

// A BTCPay Server trial. The shop is a stock BTCPay deployment
// (platforms/btcpay/fixture) that the merchant has set up: an admin, the
// Widget Shop store, a Point of Sale app with five products, and an admin's
// Greenfield key in the deployment's .env for the agent. There is no app
// code; the agent installs nothing but configures the store. BTCPay installs
// plugins only from its own UI, so when the agent asks, the merchant installs
// OpenReceive from the Plugin Directory: the harness stages the published
// package exactly as BTCPay's Install button does and restarts the server.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVICE = "btcpayserver";
const PLUGINS = "/root/.btcpayserver/Plugins";
const PLUGIN = "BTCPayServer.Plugins.OpenReceive";
const ADMIN_EMAIL = "owner@widget-shop.test";
const ADMIN_PASSWORD = "Widget-shop-local-1!";
const PRODUCTS = [
  { id: "widget-1", title: "Widget", price: 5 },
  { id: "widget-2", title: "Gadget", price: 12 },
  { id: "widget-3", title: "Gizmo", price: 20 },
  { id: "widget-4", title: "Doohickey", price: 35 },
  { id: "widget-5", title: "Thingamajig", price: 50 },
];

/** What the harness keeps about a trial's BTCPay, beside the shop and never in it. */
interface BtcpayState {
  readonly baseUrl: string;
  /** The harness's own key; the agent's key is a different one, in the shop's .env. */
  readonly apiKey: string;
  readonly storeId: string;
  readonly appId: string;
}

function stateFile(directory: string): string {
  return `${directory}.btcpay.json`;
}

/** Beside the shop: the published package, staged before it is copied in. */
function stagingDir(directory: string): string {
  return `${directory}.plugin`;
}

export async function removeBtcpayState(directory: string): Promise<void> {
  await rm(stateFile(directory), { force: true });
  await rm(stagingDir(directory), { recursive: true, force: true });
}

async function greenfield<T>(
  baseUrl: string,
  method: string,
  route: string,
  auth: string | undefined,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/api/v1${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(auth === undefined ? {} : { authorization: auth }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  return { status: response.status, body: (text === "" ? null : JSON.parse(text)) as T };
}

async function required<T>(call: Promise<{ status: number; body: T }>, what: string): Promise<T> {
  const result = await call;
  if (result.status < 200 || result.status >= 300) {
    throw new InfraError(`BTCPay ${what} answered ${result.status}.`);
  }
  return result.body;
}

async function loadState(directory: string): Promise<BtcpayState> {
  return JSON.parse(await readFile(stateFile(directory), "utf8")) as BtcpayState;
}

/**
 * The merchant's own setup, before the agent starts: the first user (an
 * admin), a key for the harness, the store and its Point of Sale app, and a
 * second admin key that the deployment's .env hands the agent.
 */
export async function setupBtcpay(directory: string, baseUrl: string): Promise<void> {
  const user = await greenfield(baseUrl, "POST", "/users", undefined, {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    isAdministrator: true,
  });
  if (user.status !== 201)
    throw new InfraError(`BTCPay did not create its admin (${user.status}).`);
  const basic = `Basic ${Buffer.from(`${ADMIN_EMAIL}:${ADMIN_PASSWORD}`).toString("base64")}`;
  const key = async (label: string): Promise<string> =>
    (
      await required(
        greenfield<{ apiKey: string }>(baseUrl, "POST", "/api-keys", basic, {
          label,
          permissions: ["unrestricted"],
        }),
        "API key",
      )
    ).apiKey;
  const apiKey = await key("Trial harness");
  const auth = `token ${apiKey}`;
  const store = await required(
    greenfield<{ id: string }>(baseUrl, "POST", "/stores", auth, {
      name: "Widget Shop",
      defaultCurrency: "USD",
    }),
    "store",
  );
  const app = await required(
    greenfield<{ id: string }>(baseUrl, "POST", `/stores/${store.id}/apps/pos`, auth, {
      appName: "Widget Shop",
      title: "Widget Shop",
      currency: "USD",
      defaultView: "Static",
      template: JSON.stringify(PRODUCTS.map((item) => ({ ...item, priceType: "Fixed" }))),
    }),
    "Point of Sale app",
  );
  const agentKey = await key("Widget Shop automation");
  await writeFile(
    path.join(directory, ".env"),
    `BTCPAY_URL=${baseUrl}\nBTCPAY_API_KEY=${agentKey}\nBTCPAY_STORE_ID=${store.id}\n`,
    { mode: 0o600 },
  );
  const state: BtcpayState = { baseUrl, apiKey, storeId: store.id, appId: app.id };
  await writeFile(stateFile(directory), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

/** The plugin answers its settings route once BTCPay has loaded it. */
async function pluginLoaded(state: BtcpayState): Promise<boolean> {
  const settings = await greenfield(
    state.baseUrl,
    "GET",
    `/stores/${state.storeId}/openreceive/settings`,
    `token ${state.apiKey}`,
  ).catch(() => ({ status: 0 }));
  return settings.status === 200;
}

export async function inspectBtcpay(directory: string, baseUrl: string): Promise<ShopEvidence> {
  const state = await loadState(directory);
  const app = await required(
    greenfield<{ items?: unknown[] }>(
      baseUrl,
      "GET",
      `/apps/pos/${state.appId}`,
      `token ${state.apiKey}`,
    ),
    "Point of Sale app",
  );
  const env = await compose(directory, ["exec", "-T", SERVICE, "printenv"], 30_000);
  return {
    baseUrl,
    productCount: app.items?.length ?? 0,
    openreceive: await pluginLoaded(state),
    nwcInEnv: /^(?:NWC_URI|LSC_URI_)/m.test(env.stdout),
  };
}

/**
 * The agent asking the merchant to install the plugin from BTCPay's UI, the
 * only way the directions allow. Quoting the rule ("never invent an
 * installer") is not a request.
 */
export function asksPluginInstall(text: string): boolean {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .some(
      (sentence) =>
        /\binstall/i.test(sentence) &&
        /plugin directory|plugins? (?:menu|page)|plug(?:-in)? icon|restart now|install and restart|manage plugins/i.test(
          sentence,
        ) &&
        !/\b(?:do not|don't|never)\b/i.test(sentence),
    );
}

/** The BTCPay version the fixture runs, from its image tag. */
async function btcpayVersion(directory: string): Promise<string> {
  const composeFile = await readFile(path.join(directory, "compose.yml"), "utf8");
  const version = composeFile.match(/btcpayserver\/btcpayserver:(\d+\.\d+\.\d+)/)?.[1];
  if (version === undefined) throw new InfraError("The BTCPay fixture names no image version.");
  return version;
}

async function waitForPlugin(state: BtcpayState): Promise<void> {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    if (await pluginLoaded(state)) return;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new InfraError("BTCPay did not load OpenReceive within 5 minutes of the install.");
}

/**
 * The merchant installs OpenReceive from the Plugin Directory: the published
 * package and its manifest, queued for BTCPay's own installer, then a restart.
 * Returns what the merchant says.
 */
export async function installPlugin(directory: string): Promise<string> {
  const state = await loadState(directory);
  if (await pluginLoaded(state)) {
    return "OpenReceive is already installed: the store's menu shows it.";
  }
  const staged = stagingDir(directory);
  await stagePublishedPlugin({
    root: repoRoot,
    btcpayVersion: await btcpayVersion(directory),
    pluginDir: staged,
  });
  for (const file of [`${PLUGIN}.btcpay`, `${PLUGIN}.json`, "commands"]) {
    await compose(
      directory,
      ["cp", path.join(staged, file), `${SERVICE}:${PLUGINS}/${file}`],
      60_000,
    );
  }
  await compose(directory, ["restart", SERVICE], 120_000);
  await compose(directory, ["up", "-d", "--wait", "--wait-timeout", "300", SERVICE], 360_000);
  await waitForPlugin(state);
  return "Done: I installed OpenReceive from the Plugin Directory and BTCPay restarted.";
}

interface Settings {
  readonly lightningNodeIsOpenReceive?: boolean;
  readonly allowSpendCapableWallet?: boolean;
  readonly swapsEnabled?: boolean;
  readonly lscPrimaryConfigured?: boolean;
}

/**
 * The store as the agent left it, read with the harness's own key. BTCPay's
 * health check is a page in its UI, so these stand in for doctor: the wallet
 * is the store's Lightning node without the spend override, and swaps are on.
 */
export async function btcpayChecks(directory: string, swaps: boolean): Promise<Check[]> {
  const state = await loadState(directory);
  const settings = await greenfield<Settings>(
    state.baseUrl,
    "GET",
    `/stores/${state.storeId}/openreceive/settings`,
    `token ${state.apiKey}`,
  ).catch((error: unknown) => ({ status: 0, body: { error: String(error) } as Settings }));
  const body = settings.body ?? {};
  const evidence = `${settings.status} ${JSON.stringify(body).slice(0, 300)}`;
  const checks = [
    check(
      "btcpay_wallet_connected",
      settings.status === 200 &&
        body.lightningNodeIsOpenReceive === true &&
        body.allowSpendCapableWallet === false,
      "The store's Lightning node is the OpenReceive wallet, without the spend override.",
      evidence,
    ),
  ];
  if (swaps) {
    checks.push(
      check(
        "btcpay_swaps_on",
        settings.status === 200 && body.swapsEnabled === true && body.lscPrimaryConfigured === true,
        "Swaps are on with the merchant's LSC code.",
        evidence,
      ),
    );
  }
  return checks;
}

interface PaymentMethod {
  readonly paymentMethodId?: string;
  readonly destination?: string;
  readonly additionalData?: { readonly paymentHash?: string };
}

/**
 * A buyer pays through the store's own Point of Sale: the buy form makes a
 * BTCPay invoice whose Lightning method is the wallet's BOLT11; the trial
 * wallet settles it; BTCPay's checkout and its invoice both report it paid.
 */
export async function liveBtcpayChecks(
  directory: string,
  paid?: PaidPath["settle"],
): Promise<Check[]> {
  const state = await loadState(directory);
  const auth = `token ${state.apiKey}`;
  const checks: Check[] = [];
  const health = await fetch(`${state.baseUrl}/api/v1/health`)
    .then((response) => response.status)
    .catch(() => 0);
  checks.push(
    check("live_health", health === 200, "BTCPay answers GET /api/v1/health.", `${health}`),
  );
  try {
    const buy = await fetch(`${state.baseUrl}/apps/${state.appId}/pos`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ choiceKey: PRODUCTS[0]?.id ?? "widget-1" }),
      redirect: "manual",
    });
    const invoiceId = (buy.headers.get("location") ?? "").match(/\/i\/([A-Za-z0-9]+)/)?.[1];
    if (invoiceId === undefined) {
      throw new Error(`the Point of Sale answered ${buy.status} without an invoice`);
    }
    const methods = await greenfield<PaymentMethod[]>(
      state.baseUrl,
      "GET",
      `/stores/${state.storeId}/invoices/${invoiceId}/payment-methods`,
      auth,
    );
    const lightning = (methods.body ?? []).find((method) => method.paymentMethodId === "BTC-LN");
    const bolt11 = lightning?.destination?.match(/^ln[a-z0-9]+$/i)?.[0];
    checks.push(
      check(
        "live_invoice",
        bolt11 !== undefined,
        "The buyer's Point of Sale order got a Lightning invoice.",
        bolt11 === undefined
          ? `${methods.status} ${JSON.stringify(methods.body).slice(0, 300)}`
          : `${invoiceId} ${bolt11.slice(0, 16)}…`,
      ),
    );
    const paymentHash = lightning?.additionalData?.paymentHash;
    if (paid === undefined || paymentHash === undefined || !/^[0-9a-f]{64}$/.test(paymentHash)) {
      return checks;
    }
    await paid(paymentHash);
    const deadline = Date.now() + 60_000;
    let checkout = "";
    let invoice = "";
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      checkout = await fetch(`${state.baseUrl}/i/${invoiceId}/status`)
        .then(async (response) => (await response.json()) as { status?: string })
        .then((body) => body.status ?? "")
        .catch(() => "");
      invoice =
        (
          await greenfield<{ status?: string }>(
            state.baseUrl,
            "GET",
            `/stores/${state.storeId}/invoices/${invoiceId}`,
            auth,
          )
        ).body?.status ?? "";
      if (checkout === "Settled" && invoice === "Settled") break;
    }
    checks.push(
      check(
        "live_settled",
        checkout === "Settled",
        "After the wallet settled the invoice, BTCPay's checkout reported it paid.",
        `checkout status: ${checkout || "(unread)"}`,
      ),
      check(
        "live_order_paid",
        invoice === "Settled",
        "BTCPay's own invoice for the order is Settled.",
        `invoice ${invoiceId} status: ${invoice || "(unread)"}`,
      ),
    );
  } catch (error) {
    checks.push(
      check(
        "live_invoice",
        false,
        "The buyer's Point of Sale order got a Lightning invoice.",
        String(error),
      ),
    );
  }
  return checks;
}
