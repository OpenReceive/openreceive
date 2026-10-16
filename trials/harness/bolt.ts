import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Browser, Page } from "playwright";
import { InfraError } from "./docker.ts";
import {
  type Answer,
  backToBackCheck,
  type CheckoutClient,
  check,
  type LiveOptions,
  paidChecks,
  SWAP_PRODUCT,
  swapOrderChecks,
} from "./live.ts";
import { publishedPort } from "./sandbox.ts";
import type { Check } from "./types.ts";

// The live checks for a Bolt shop. Its pages are a Vite React app and its
// payment routes a Supabase Edge Function on another site, so the buyer is a
// browser: Chromium opens the shop as https://widget-shop.bolt.host, signs up,
// buys through the shop's own page and waits for the page's checkout to get
// an invoice from https://<ref>.supabase.co/functions/v1/openreceive. Both
// names reach this machine through a TLS front with a throwaway certificate.
// The rest of the checks call the function as that page does: the buyer's
// access token, the page's origin, a cross-site fetch.

const execFileAsync = promisify(execFile);

/** Where Bolt publishes the shop, and the project ref in the fixture's .env. */
export const BOLT_SHOP_HOST = "widget-shop.bolt.host";
const SHOP_ORIGIN = `https://${BOLT_SHOP_HOST}`;
const SUPABASE_REF = "widgetshopboltdemoab";
const SUPABASE_HOST = `${SUPABASE_REF}.supabase.co`;
const FUNCTION_PATH = "/functions/v1/openreceive";
const BUYER_PASSWORD = "widget-shop-buyer";
const ORDER_PATH =
  /\/(?:orders|checkout)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
const CREATE_URL = /\/functions\/v1\/[^/]+\/checkouts$/;

/** An HTTPS front for both names, a hop to the shop's two published ports. */
async function startFront(
  webPort: number,
  gatewayPort: number,
): Promise<{ server: Server; port: number; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "ortrial-bolt-tls-"));
  await execFileAsync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=bolt-trial",
    "-addext",
    `subjectAltName=DNS:${BOLT_SHOP_HOST},DNS:${SUPABASE_HOST}`,
    "-keyout",
    path.join(dir, "key.pem"),
    "-out",
    path.join(dir, "cert.pem"),
  ]);
  const upstream: Record<string, number> = {
    [BOLT_SHOP_HOST]: webPort,
    [SUPABASE_HOST]: gatewayPort,
  };
  const server = createServer(
    {
      key: await readFile(path.join(dir, "key.pem")),
      cert: await readFile(path.join(dir, "cert.pem")),
    },
    (incoming, outgoing) => {
      const port = upstream[(incoming.headers.host ?? "").split(":")[0] ?? ""];
      if (port === undefined) {
        outgoing.writeHead(421);
        outgoing.end();
        return;
      }
      const hop = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method: incoming.method,
          path: incoming.url,
          headers: incoming.headers,
        },
        (answer) => {
          outgoing.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(outgoing);
        },
      );
      hop.on("error", (error) => {
        outgoing.writeHead(502);
        outgoing.end(String(error));
      });
      incoming.pipe(hop);
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new InfraError("The TLS front has no port.");
  return { server, port: address.port, dir };
}

/** One POST through node:http, so Origin and Sec-Fetch-Site go as a browser sends them. */
function post(
  base: URL,
  pathname: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Answer> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: base.hostname,
        port: base.port,
        method: "POST",
        path: pathname,
        headers: { "content-type": "application/json", ...headers },
      },
      (answer) => {
        let text = "";
        answer.setEncoding("utf8");
        answer.on("data", (chunk: string) => {
          text += chunk;
        });
        answer.on("end", () =>
          resolve({
            status: answer.statusCode ?? 0,
            body: text,
            ms: Math.round(performance.now() - started),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(JSON.stringify(body));
  });
}

/** The page's checkout calls, made with a Supabase access token from the shop's origin. */
class TokenBuyer implements CheckoutClient {
  constructor(
    private readonly gateway: URL,
    private readonly token: string,
    private readonly retryDelayMs: number,
  ) {}

  private call(route: string, body: Record<string, string>): Promise<Answer> {
    return post(
      this.gateway,
      `${FUNCTION_PATH}${route}`,
      {
        authorization: `Bearer ${this.token}`,
        origin: SHOP_ORIGIN,
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "cors",
      },
      body,
    );
  }

  async createCheckout(reference: string): Promise<Answer> {
    let result = await this.call("/checkouts", { reference });
    for (let retry = 0; retry < 2 && result.status === 503; retry += 1) {
      if (!/"retryable"\s*:\s*true/.test(result.body)) break;
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      result = await this.call("/checkouts", { reference });
    }
    return result;
  }

  prepareCheckout(reference: string): Promise<Answer> {
    return this.call("/checkouts/prepare", { reference });
  }

  createSwap(reference: string, payInAsset: string): Promise<Answer> {
    return this.call("/swaps", { reference, pay_in_asset: payInAsset });
  }

  swapStatus(reference: string, paymentHash: string): Promise<Answer> {
    return this.call("/swaps/status", { reference, payment_hash: paymentHash });
  }

  checkPayment(reference: string, paymentHash: string): Promise<Answer> {
    return this.call("/payments/check", { reference, payment_hash: paymentHash });
  }
}

/** The fixture's public anon key, as Bolt writes it into the project's .env. */
async function anonKey(directory: string): Promise<string> {
  // The repository tracks .env.example; the image copies it to .env.
  for (const name of [".env", ".env.example"]) {
    const env = await readFile(path.join(directory, name), "utf8").catch(() => "");
    const key = env.match(/^VITE_SUPABASE_ANON_KEY=(\S+)$/m)?.[1];
    if (key !== undefined) return key;
  }
  throw new InfraError("The Bolt shop has no VITE_SUPABASE_ANON_KEY in .env or .env.example.");
}

/** A second user, through Supabase Auth's own sign-up. */
async function signUp(
  gateway: URL,
  anon: string,
  tag: string,
): Promise<{ token: string; id: string }> {
  const response = await fetch(new URL("/auth/v1/signup", gateway), {
    method: "POST",
    headers: { apikey: anon, "content-type": "application/json" },
    body: JSON.stringify({ email: `${tag}-${Date.now()}@shop.test`, password: BUYER_PASSWORD }),
  });
  const body = (await response.json()) as { access_token?: string; user?: { id?: string } };
  if (!response.ok || body.access_token === undefined || body.user?.id === undefined) {
    throw new InfraError(`Supabase Auth refused a sign-up: ${response.status}`);
  }
  return { token: body.access_token, id: body.user.id };
}

/** The signed-in buyer's access token, from supabase-js's storage in the page. */
async function pageToken(page: Page): Promise<string> {
  const token = await page.evaluate((ref) => {
    const raw = localStorage.getItem(`sb-${ref}-auth-token`);
    return raw === null
      ? null
      : ((JSON.parse(raw) as { access_token?: string }).access_token ?? null);
  }, SUPABASE_REF);
  if (token === null) throw new Error("the page holds no Supabase session after sign-up");
  return token;
}

/**
 * Buy a product through the shop's own page and wait for the page's checkout
 * to create its invoice: picking Bitcoin first when the checkout offers a
 * choice of methods. Answers the order id and the create call's answer.
 */
async function buyThroughPage(
  page: Page,
  product: number,
  pick = true,
): Promise<{ order: string; created?: Answer }> {
  await page.goto(`${SHOP_ORIGIN}/`);
  const item = page.locator(`li[data-product-id="${product}"]`);
  const button =
    (await item.count()) > 0
      ? item.getByRole("button", { name: /buy/i })
      : page.getByRole("button", { name: /buy/i }).nth(product - 1);
  const created = page.waitForResponse(
    (response) =>
      CREATE_URL.test(new URL(response.url()).pathname) && response.request().method() === "POST",
    { timeout: 60_000 },
  );
  await button.click();
  await page.waitForURL(ORDER_PATH, { timeout: 30_000 });
  const order = new URL(page.url()).pathname.match(ORDER_PATH)?.[1] ?? "";
  if (!pick) {
    created.catch(() => undefined);
    return { order };
  }
  return { order, created: await pickBitcoinAndWait(page, created) };
}

async function pickBitcoinAndWait(
  page: Page,
  created: Promise<import("playwright").Response>,
): Promise<Answer | undefined> {
  const started = performance.now();
  const picked = page
    .getByRole("button", { name: /bitcoin/i })
    .first()
    .click({ timeout: 45_000 })
    .catch(() => undefined);
  const response = await created.catch(() => undefined);
  await picked;
  if (response === undefined) return undefined;
  return {
    status: response.status(),
    body: await response.text(),
    ms: Math.round(performance.now() - started),
  };
}

const hashOf = (body: string) => body.match(/"payment_hash"\s*:\s*"([0-9a-f]{64})"/)?.[1];
const bolt11Of = (body: string) => body.match(/"bolt11"\s*:\s*"(ln[a-z0-9]+)"/i)?.[1];

export async function liveBoltChecks(
  directory: string,
  webBase: string,
  options: LiveOptions = {},
): Promise<Check[]> {
  const retryDelayMs = options.retryDelayMs ?? 5_000;
  const checks: Check[] = [];
  const health = await fetch(`${webBase}/health`)
    .then((response) => response.status)
    .catch(() => 0);
  checks.push(check("live_health", health === 200, "The shop answers GET /health.", `${health}`));

  const webPort = Number(new URL(webBase).port);
  const gatewayPort = Number(await publishedPort(directory, "gateway", 8000));
  const gateway = new URL(`http://127.0.0.1:${gatewayPort}`);
  const anon = await anonKey(directory);
  const front = await startFront(webPort, gatewayPort);
  const { chromium } = await import("playwright");
  let browser: Browser | undefined;
  const pageErrors: string[] = [];
  try {
    browser = await chromium.launch({
      args: [
        `--host-resolver-rules=MAP ${BOLT_SHOP_HOST}:443 127.0.0.1:${front.port}, MAP ${SUPABASE_HOST}:443 127.0.0.1:${front.port}`,
      ],
    });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(String(error)));

    // The buyer signs up on the shop's own sign-in page.
    await page.goto(`${SHOP_ORIGIN}/login`);
    await page.locator('input[type="email"]').first().fill(`buyer-${Date.now()}@shop.test`);
    await page.locator('input[type="password"]').first().fill(BUYER_PASSWORD);
    await page
      .getByRole("button", { name: /create account|sign up/i })
      .first()
      .click();
    await page.waitForFunction(
      (ref) => localStorage.getItem(`sb-${ref}-auth-token`) !== null,
      SUPABASE_REF,
      { timeout: 30_000 },
    );
    const token = await pageToken(page);
    const buyer = new TokenBuyer(gateway, token, retryDelayMs);

    const { order, created } = await buyThroughPage(page, 1);
    const bolt11 = created === undefined ? undefined : bolt11Of(created.body);
    const paymentHash = created === undefined ? undefined : hashOf(created.body);
    checks.push(
      check(
        "live_page_invoice",
        created?.status === 201 && bolt11 !== undefined,
        "The order's own page showed a checkout that got a Lightning invoice from the server function, with the buyer's token, across sites.",
        created === undefined
          ? `order ${order || "(none)"}: the page never asked the function for an invoice`
          : `${created.status} ${bolt11 === undefined ? created.body.slice(0, 300) : `${bolt11.slice(0, 16)}…`}`,
      ),
    );
    if (order === "") throw new Error("the shop's Buy did not lead to an order page");

    const own = await buyer.createCheckout(order);
    checks.push(
      check(
        "live_invoice",
        own.status === 201 && hashOf(own.body) !== undefined && hashOf(own.body) === paymentHash,
        "The buyer's own order, asked for again with the buyer's token, got the page's invoice.",
        `${own.status} in ${own.ms} ms${hashOf(own.body) === paymentHash ? "" : `: ${own.body.slice(0, 300)}`}`,
      ),
    );

    // Another signed-in user, and the bare anon key that supabase.functions.invoke
    // sends for nobody: neither may pay for this order.
    const stranger = await signUp(gateway, anon, "stranger");
    const theirs = await new TokenBuyer(gateway, stranger.token, retryDelayMs).createCheckout(
      order,
    );
    checks.push(
      check(
        "live_refuses_stranger",
        [401, 403, 404].includes(theirs.status),
        "The function refused a checkout for someone else's order, from another signed-in user.",
        `${theirs.status} ${theirs.body.slice(0, 200)}`,
      ),
    );
    const nobody = await new TokenBuyer(gateway, anon, retryDelayMs).createCheckout(order);
    checks.push(
      check(
        "live_refuses_anon_key",
        [401, 403, 404].includes(nobody.status),
        "The function refused a checkout sent with the project's anon key and no user.",
        `${nobody.status} ${nobody.body.slice(0, 200)}`,
      ),
    );

    checks.push(await priceCheck(gateway, anon, token, buyer));

    if (paymentHash !== undefined) {
      checks.push(await backToBackCheck(buyer, order, "", paymentHash));
      // A reload of the order page resumes its checkout: the same invoice.
      const again = page.waitForResponse(
        (response) =>
          CREATE_URL.test(new URL(response.url()).pathname) &&
          response.request().method() === "POST",
        { timeout: 60_000 },
      );
      await page.reload();
      const reloaded = await pickBitcoinAndWait(page, again);
      checks.push(
        check(
          "live_reload",
          reloaded?.status === 201 && hashOf(reloaded.body) === paymentHash,
          "A reload of the order page resumed the same checkout: the same invoice.",
          reloaded === undefined
            ? "after the reload the page never asked for an invoice"
            : `${reloaded.status} ${hashOf(reloaded.body) === paymentHash ? "same payment hash" : reloaded.body.slice(0, 200)}`,
        ),
      );
      if (options.paid !== undefined) {
        checks.push(...(await paidChecks(buyer, order, "", paymentHash, options.paid, options)));
      }
    }
    if (options.swap !== undefined) {
      try {
        // A new order, with no Lightning invoice yet: the swap is its first payment.
        const swapOrder = await buyThroughPage(page, SWAP_PRODUCT, false);
        checks.push(...(await swapOrderChecks(buyer, swapOrder.order, "", options.swap, options)));
      } catch (error) {
        checks.push(
          check("live_swap_paid", false, "The buyer paid an order by swap.", String(error)),
        );
      }
    }
  } catch (error) {
    if (!checks.some((item) => item.id === "live_page_invoice")) {
      checks.push(
        check(
          "live_page_invoice",
          false,
          "The order's own page showed a checkout that got a Lightning invoice from the server function.",
          String(error),
        ),
      );
    } else {
      checks.push(
        check("live_bolt_buyer", false, "The buyer's checks ran to the end.", String(error)),
      );
    }
  } finally {
    await browser?.close();
    front.server.close();
    await rm(front.dir, { recursive: true, force: true });
  }
  checks.push({
    id: "live_page_no_errors",
    severity: "polish",
    pass: pageErrors.length === 0,
    summary: "The shop's pages threw no errors while the buyer signed up, bought and paid.",
    evidence: pageErrors.length === 0 ? undefined : pageErrors.slice(0, 5).join("\n"),
  });
  return checks;
}

/**
 * The price is the catalog's, whatever the browser writes: a buyer who
 * inserts an order for the $12.50 product at $0.01, as a Bolt page could, is
 * refused, or is charged $12.50.
 */
async function priceCheck(
  gateway: URL,
  anon: string,
  token: string,
  buyer: TokenBuyer,
): Promise<Check> {
  const summary =
    "An order the browser wrote at $0.01 for the $12.50 product was refused, or charged $12.50.";
  const user = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
    sub?: string;
  };
  const inserted = await fetch(new URL("/rest/v1/orders?select=id", gateway), {
    method: "POST",
    headers: {
      apikey: anon,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      prefer: "return=representation",
    },
    body: JSON.stringify({
      user_id: user.sub,
      product_id: SWAP_PRODUCT,
      title: "Gadget",
      total: 0.01,
      currency: "USD",
    }),
  });
  const text = await inserted.text();
  if (!inserted.ok)
    return check("live_price_from_database", true, summary, `insert refused: ${inserted.status}`);
  const id = (JSON.parse(text) as { id?: string }[])[0]?.id;
  if (id === undefined)
    return check("live_price_from_database", true, summary, "insert returned no row");
  const created = await buyer.createCheckout(id);
  const fiat = created.body.match(
    /"fiat"\s*:\s*\{\s*"currency"\s*:\s*"([A-Z]+)"\s*,\s*"value"\s*:\s*"([0-9.]+)"/,
  );
  const charged = fiat === null ? undefined : `${fiat[2]} ${fiat[1]}`;
  return check(
    "live_price_from_database",
    created.status !== 201 || (fiat !== null && Number(fiat[2]) === 12.5),
    summary,
    created.status === 201
      ? `charged ${charged ?? created.body.slice(0, 200)}`
      : `${created.status} ${created.body.slice(0, 200)}`,
  );
}
