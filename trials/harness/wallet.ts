import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { request } from "node:https";
import path from "node:path";
import { rootCertificates } from "node:tls";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compose, InfraError } from "./docker.ts";

// The trial wallet (trials/wallet/compose.yml): a NIP-47 wallet service with
// in-memory invoices on Rizful's public NWC relay, and a FixedFloat-compatible
// swap provider, so a shop under test gets a normal NWC code and swap URI
// without the merchant's real wallet. The NWC code works from anywhere; the
// swap provider is local, so a shop joins the stack's network and trusts its
// private CA through trialWalletOverride. The harness marks an invoice paid
// with settle(). A shop on that network also reaches the relay and the price
// feeds through the stack's interceptor (chaos.ts), which passes everything
// through until the chaos phase sets a rule for that shop.

const walletDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../wallet");
const certsDir = path.join(walletDir, "certs");
const PROJECT = "openreceive-trial-wallet";
const NETWORK = "openreceive-trial";
/** Both control ports are published on 127.0.0.1 only. */
const TESTKIT = "http://127.0.0.1:17890";
const FAKE_LSC = "https://127.0.0.1:17888";
// A changed interceptor runs beside the shared one under its own name and ports
// until it is rolled out; this points the harness at it.
const INTERCEPTOR = process.env.OPENRECEIVE_TRIAL_INTERCEPTOR_CONTROL ?? "http://127.0.0.1:17891";
const SPEND_TESTKIT = "http://127.0.0.1:17892";
/** Playwright's browser server, for WebKit (compose profile `webkit`). */
const WEBKIT_ENDPOINT = "ws://127.0.0.1:17894/";
const INTERCEPTOR_CONTAINER =
  process.env.OPENRECEIVE_TRIAL_INTERCEPTOR_CONTAINER ?? "openreceive-trial-wallet-interceptor-1";
/** The swap provider as a shop on the trial network reaches it. */
const FAKE_LSC_HOST = "fake-lsc:7788";
const UP_TIMEOUT_MS = 15 * 60 * 1000;
const SYSTEM_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
const BUNDLE_IN_SHOP = "/etc/ssl/certs/ca-certificates.crt";
const CA_IN_SHOP = "/etc/ssl/certs/openreceive-trial-ca.crt";
/** Compose's own rule for a service name. */
const SERVICE_NAME = /^[a-zA-Z0-9._-]+$/;

const COMPOSE_ARGS = ["-p", PROJECT, "-f", path.join(walletDir, "compose.yml")] as const;

const execFileAsync = promisify(execFile);

export interface TrialWallet {
  /** A receive-only `nostr+walletconnect://` code. It changes on every testkit restart. */
  readonly nwc: string;
  /** `lightning+swapconnect://fake-lsc:7788/?key=…&secret=…`. */
  readonly lsc: string;
  readonly network: typeof NETWORK;
  /** Absolute host path to the private CA certificate. */
  readonly caFile: string;
  /** Absolute host path to the host's system CAs plus the private CA, for a Debian bundle mount. */
  readonly caBundle: string;
  /** Mark one of the wallet's invoices paid. Unknown hashes throw. */
  settle: (paymentHash: string) => Promise<void>;
  /**
   * Move the test provider's swap order for this invoice to completed, as a
   * provider does once the deposit arrived. Nothing pays the invoice: settle it too.
   */
  completeSwap: (bolt11: string) => Promise<void>;
  /** Every invoice the wallet holds, paid or not, without preimages. */
  invoices: () => Promise<unknown>;
  /** The interceptor's address on the trial network, and the host names it answers for. */
  readonly interceptor: TrialInterceptor;
}

export interface TrialInterceptor {
  readonly ip: string;
  readonly hosts: readonly string[];
  /** The control API, on 127.0.0.1. */
  readonly control: string;
}

/** The CA the certs service minted into the stack's volume. */
async function readCa(): Promise<string> {
  const { stdout } = await execFileAsync(
    "docker",
    ["compose", ...COMPOSE_ARGS, "exec", "-T", "fake-lsc", "cat", "/certs/ca.crt"],
    { timeout: 30_000 },
  );
  if (!stdout.includes("-----BEGIN CERTIFICATE-----")) {
    throw new InfraError("The trial wallet's CA certificate is missing from its certs volume.");
  }
  return stdout.endsWith("\n") ? stdout : `${stdout}\n`;
}

async function testkitHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${TESTKIT}/health`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return false;
    const body = (await response.json()) as { relayConnected?: unknown };
    return body.relayConnected === true;
  } catch {
    return false;
  }
}

/** A fake-lsc control path over its TLS, trusting only the private CA: GET, or POST with a JSON body. */
function fakeLscJson(pathname: string, ca: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const options =
      body === undefined
        ? { ca, timeout: 5_000 }
        : {
            ca,
            timeout: 5_000,
            method: "POST",
            headers: { "content-type": "application/json" },
          };
    const call = request(`${FAKE_LSC}${pathname}`, options, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(
            new InfraError(`fake-lsc ${pathname.split("?")[0]} answered ${response.statusCode}.`),
          );
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new InfraError(`fake-lsc ${pathname.split("?")[0]} did not answer JSON.`));
        }
      });
    });
    call.on("timeout", () => call.destroy(new Error("timed out")));
    call.on("error", (error) => reject(new InfraError(`fake-lsc: ${error.message}`)));
    call.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** The interceptor's host list when it answers; undefined when it needs `up`. */
async function interceptorHosts(): Promise<string[] | undefined> {
  try {
    const response = await fetch(`${INTERCEPTOR}/health`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { hosts?: unknown };
    return Array.isArray(body.hosts) ? body.hosts.map(String) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The interceptor, started on its own when the rest of the stack is already
 * up: `up` for one service leaves testkit-nwc alone, so its code and its
 * invoices survive.
 */
async function startInterceptor(): Promise<TrialInterceptor> {
  let hosts = await interceptorHosts();
  if (hosts === undefined) {
    await compose(walletDir, [...COMPOSE_ARGS, "up", "-d", "--wait", "interceptor"], 10 * 60_000);
    hosts = await interceptorHosts();
  }
  if (hosts === undefined || hosts.length === 0) {
    throw new InfraError("The trial interceptor did not answer on its control port.");
  }
  const { stdout } = await execFileAsync(
    "docker",
    [
      "inspect",
      INTERCEPTOR_CONTAINER,
      "--format",
      `{{(index .NetworkSettings.Networks "${NETWORK}").IPAddress}}`,
    ],
    { timeout: 30_000 },
  );
  const ip = stdout.trim();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
    throw new InfraError(`The trial interceptor has no address on ${NETWORK}: ${ip || "(none)"}.`);
  }
  return { ip, hosts, control: INTERCEPTOR };
}

/** The CA when every service already answers; undefined when the stack needs `up`. */
async function healthyCa(): Promise<string | undefined> {
  try {
    const ca = await readCa();
    if (!(await testkitHealthy())) return undefined;
    await fakeLscJson("/__testkit/health", ca);
    return ca;
  } catch {
    return undefined;
  }
}

async function bringUp(): Promise<string> {
  await compose(
    walletDir,
    [...COMPOSE_ARGS, "up", "-d", "--wait", "--wait-timeout", String(UP_TIMEOUT_MS / 1000)],
    UP_TIMEOUT_MS + 60_000,
  );
  return readCa();
}

/**
 * Rewrite in place, never by rename: a running shop bind-mounts these files,
 * and a mount follows the inode, so a renamed file would leave it on the old CA.
 */
async function writeIfChanged(file: string, text: string): Promise<void> {
  const current = await readFile(file, "utf8").catch(() => undefined);
  if (current !== text) await writeFile(file, text, { mode: 0o644 });
}

async function writeTrust(ca: string): Promise<{ caFile: string; caBundle: string }> {
  await mkdir(certsDir, { recursive: true });
  const caFile = path.join(certsDir, "ca.crt");
  const caBundle = path.join(certsDir, "ca-bundle.crt");
  // Off Debian-family hosts, Node's own Mozilla roots stand in for the system bundle.
  const system = existsSync(SYSTEM_BUNDLE)
    ? await readFile(SYSTEM_BUNDLE, "utf8")
    : rootCertificates.join("\n");
  await writeIfChanged(caFile, ca);
  await writeIfChanged(caBundle, `${system.trimEnd()}\n${ca}`);
  return { caFile, caBundle };
}

async function nwcUri(): Promise<string> {
  const response = await fetch(`${TESTKIT}/uri`, { signal: AbortSignal.timeout(5_000) });
  const uri = (await response.text()).trim();
  if (!response.ok || !uri.startsWith("nostr+walletconnect://")) {
    throw new InfraError("The trial wallet did not hand out an NWC code.");
  }
  return uri;
}

async function lscUri(ca: string): Promise<string> {
  const body = (await fakeLscJson(
    `/__testkit/lsc-uri?host=${encodeURIComponent(FAKE_LSC_HOST)}`,
    ca,
  )) as { uri?: unknown };
  if (typeof body.uri !== "string" || !body.uri.startsWith("lightning+swapconnect://")) {
    throw new InfraError("The trial swap provider did not hand out an LSC URI.");
  }
  return body.uri;
}

async function settle(paymentHash: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/i.test(paymentHash)) {
    throw new InfraError("settle needs a 64-hex payment hash.");
  }
  const response = await fetch(`${TESTKIT}/settle/${paymentHash.toLowerCase()}`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) {
    throw new InfraError(`The trial wallet holds no invoice ${paymentHash}.`);
  }
  if (!response.ok) {
    throw new InfraError(`The trial wallet did not settle ${paymentHash}: ${response.status}.`);
  }
}

/**
 * Script one swap order to completed, found by its invoice. By order id, not
 * by asset: an asset script would also move every other trial's orders.
 */
async function completeSwap(bolt11: string, ca: string): Promise<void> {
  const listed = (await fakeLscJson("/__testkit/orders", ca)) as {
    orders?: { id: string; bolt11: string }[];
  };
  const order = listed.orders?.find((item) => item.bolt11 === bolt11);
  if (order === undefined) {
    throw new InfraError("The test swap provider holds no order for that invoice.");
  }
  await fakeLscJson("/__testkit/script", ca, { selector: order.id, states: ["completed"] });
}

async function invoices(): Promise<unknown> {
  const response = await fetch(`${TESTKIT}/invoices`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok)
    throw new InfraError(`The trial wallet's invoices answered ${response.status}.`);
  return response.json();
}

/**
 * Bring the trial wallet up, or reuse it when every service already answers.
 * The NWC code is read after start: the in-memory wallet mints a new one, and
 * forgets its invoices, whenever testkit-nwc restarts.
 */
export async function startTrialWallet(): Promise<TrialWallet> {
  const ca = (await healthyCa()) ?? (await bringUp());
  const { caFile, caBundle } = await writeTrust(ca);
  const interceptor = await startInterceptor();
  return {
    interceptor,
    nwc: await nwcUri(),
    lsc: await lscUri(ca),
    network: NETWORK,
    caFile,
    caBundle,
    settle,
    completeSwap: (bolt11: string) => completeSwap(bolt11, ca),
    invoices,
  };
}

/**
 * The spend-capable code for the spend-capable scenario, from the wallet
 * service that grants pay_invoice. Started alone: `up` for one service leaves
 * testkit-nwc and its invoices as they are.
 */
export async function spendCapableCode(): Promise<string> {
  let uri = await fetch(`${SPEND_TESTKIT}/uri`, { signal: AbortSignal.timeout(3_000) })
    .then((response) => response.text())
    .catch(() => "");
  if (!uri.trim().startsWith("nostr+walletconnect://")) {
    await compose(
      walletDir,
      [...COMPOSE_ARGS, "up", "-d", "--wait", "testkit-nwc-spend"],
      10 * 60_000,
    );
    uri = await fetch(`${SPEND_TESTKIT}/uri`, { signal: AbortSignal.timeout(5_000) }).then(
      (response) => response.text(),
    );
  }
  const code = uri.trim();
  if (!code.startsWith("nostr+walletconnect://")) {
    throw new InfraError("The spend-capable trial wallet did not hand out an NWC code.");
  }
  return code;
}

/** Remove the stack and its volumes; the next start mints a new CA and codes. */
export async function stopTrialWallet(): Promise<void> {
  await compose(walletDir, [...COMPOSE_ARGS, "down", "-v", "--remove-orphans"], 120_000);
}

/**
 * Safari's engine, from Playwright's own image: WebKit needs system libraries
 * a host seldom has. The server stays up between trials, on host networking so
 * it reaches each shop's 127.0.0.1 port, and its version follows the client's.
 */
export async function startWebkit(): Promise<import("@playwright/test").Browser> {
  const { webkit } = await import("@playwright/test");
  const { createRequire } = await import("node:module");
  const { version } = createRequire(import.meta.url)("@playwright/test/package.json") as {
    version: string;
  };
  const connect = () => webkit.connect(WEBKIT_ENDPOINT, { timeout: 15_000 });
  const running = await connect().catch(() => undefined);
  if (running !== undefined) return running;
  await compose(
    walletDir,
    [...COMPOSE_ARGS, "--profile", "webkit", "up", "-d", "--wait", "webkit"],
    10 * 60_000,
    { env: { PLAYWRIGHT_VERSION: version } },
  );
  return connect();
}

/**
 * Compose override YAML for a shop: each named service joins the trial
 * network beside its own default one, to reach fake-lsc, and trusts the
 * private CA. Node reads
 * NODE_EXTRA_CA_CERTS; OpenSSL (Python, PHP, Ruby, curl) reads the bundle,
 * mounted over the Debian path and named by SSL_CERT_FILE; Deno (Supabase's
 * edge-runtime) reads that bundle only with DENO_TLS_CA_STORE=system. With an
 * interceptor, each service also resolves the relay and price-feed host
 * names to it, through extra_hosts.
 */
export function trialWalletOverride(
  services: readonly string[],
  wallet: Pick<TrialWallet, "network" | "caFile" | "caBundle"> & {
    readonly interceptor?: Pick<TrialInterceptor, "ip" | "hosts">;
  },
): string {
  const names = [...new Set(services)];
  if (names.length === 0) throw new InfraError("trialWalletOverride needs at least one service.");
  for (const name of names) {
    if (!SERVICE_NAME.test(name)) throw new InfraError(`Not a compose service name: ${name}`);
  }
  const quote = (value: string): string => JSON.stringify(value);
  const lines = [
    "# Written by the trial harness: the trial wallet's network and private CA.",
    "services:",
  ];
  for (const name of names) {
    lines.push(
      `  ${name}:`,
      "    networks:",
      "      - default",
      `      - ${wallet.network}`,
      "    volumes:",
      "      - type: bind",
      `        source: ${quote(wallet.caBundle)}`,
      `        target: ${BUNDLE_IN_SHOP}`,
      "        read_only: true",
      "      - type: bind",
      `        source: ${quote(wallet.caFile)}`,
      `        target: ${CA_IN_SHOP}`,
      "        read_only: true",
      "    environment:",
      `      NODE_EXTRA_CA_CERTS: ${CA_IN_SHOP}`,
      `      SSL_CERT_FILE: ${BUNDLE_IN_SHOP}`,
      `      REQUESTS_CA_BUNDLE: ${BUNDLE_IN_SHOP}`,
      `      CURL_CA_BUNDLE: ${BUNDLE_IN_SHOP}`,
      "      DENO_TLS_CA_STORE: system",
    );
    if (wallet.interceptor !== undefined && wallet.interceptor.hosts.length > 0) {
      lines.push("    extra_hosts:");
      for (const host of wallet.interceptor.hosts) {
        if (!/^[a-z0-9.-]+$/.test(host)) throw new InfraError(`Not a host name: ${host}`);
        lines.push(`      - ${quote(`${host}:${wallet.interceptor.ip}`)}`);
      }
    }
  }
  lines.push("networks:", `  ${wallet.network}:`, "    external: true", "");
  return lines.join("\n");
}
