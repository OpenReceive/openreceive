import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import mysql from "mysql2/promise";
import pg from "pg";
import {
  createHost,
  createHttpHandler,
  maybeReconcilePayments,
  paymentsSchemaStatements,
  startNotificationListener,
} from "../../../packages/js/http/src/index.ts";
import { createOpenReceive } from "../../../packages/js/node/src/index.ts";
import { createTestkitSwapProvider } from "../../../packages/js/testkit/src/index.ts";

// One app process of a two-instance shop, on real Postgres or MySQL. See
// two-instances.test.mjs for what drives it; the contract every instance
// program in this folder keeps is written at the top of that file.

const instance = process.env.EDGE_INSTANCE ?? "a";
const port = Number(process.env.EDGE_PORT);
const kind = process.env.EDGE_DB_KIND as "postgres" | "mysql";
const url = process.env.EDGE_DB_URL as string;
const walletUrl = process.env.EDGE_WALLET_URL as string;
const limitPerHour = Number(process.env.EDGE_RATE_LIMIT_PER_HOUR ?? 60);

async function walletCall(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${walletUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-edge-instance": instance },
    body: JSON.stringify(body, (_key, value) =>
      typeof value === "bigint" ? Number(value) : value,
    ),
  });
  const parsed = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`wallet ${path}: ${JSON.stringify(parsed)}`);
  return parsed;
}

interface SqlHandle {
  query(sql: string, params?: readonly unknown[]): Promise<unknown>;
  end(): Promise<void>;
}

const db: SqlHandle =
  kind === "postgres"
    ? new pg.Pool({ connectionString: url, max: 16 })
    : mysql.createPool({ uri: url, connectionLimit: 16 });

async function migrate(): Promise<void> {
  for (const statement of paymentsSchemaStatements(kind)) {
    await db.query(statement);
  }
  await db.query(
    "CREATE TABLE IF NOT EXISTS edge_fulfillments (reference VARCHAR(255) NOT NULL, payment_hash VARCHAR(64) NOT NULL, instance VARCHAR(16) NOT NULL)",
  );
}

let notificationHandler: ((notification: unknown) => void) | undefined;

const client = {
  capabilitySummary: {
    walletPubkey: "f".repeat(64),
    relays: ["wss://relay.test.openreceive.local"],
    methods: ["make_invoice", "list_transactions"],
    encryption: "nip04",
    spendCapabilityAdvertised: false,
    receiveCheckoutReady: true,
    warnings: [],
  },
  async preflight() {
    return this.capabilitySummary;
  },
  makeInvoice: (request: unknown) => walletCall("/make_invoice", request),
  listTransactions: (request: unknown) => walletCall("/list_transactions", request),
  async subscribeNotifications(handler: (notification: unknown) => void) {
    notificationHandler = handler;
    return () => {
      notificationHandler = undefined;
    };
  },
  close() {},
};

function read(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/** Holds the request until the shared moment, so both instances act at once. */
async function waitUntil(atMs: unknown): Promise<void> {
  const delay = Number(atMs ?? 0) - Date.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

async function serve(): Promise<void> {
  const service = await createOpenReceive({
    client: client as never,
    priceProviders: [],
    // The testkit provider answers from the order it is handed when it never
    // created that order, as a real provider does: nothing here is shared.
    swap: { provider: createTestkitSwapProvider() },
  });
  const placeholder = kind === "postgres" ? "$1, $2, $3" : "?, ?, ?";
  const host = createHost({
    db: db as never,
    amountFor: () => ({ sats: 1234 }),
    onPaid: async ({ reference, paymentHash, query }) => {
      await query(
        `INSERT INTO edge_fulfillments (reference, payment_hash, instance) VALUES (${placeholder})`,
        [reference, paymentHash, instance],
      );
      await walletCall("/fulfilled", { reference, payment_hash: paymentHash, instance });
    },
  });
  const handler = createHttpHandler({
    service,
    host,
    authorize: () => true,
    rateLimiting: {
      limitPerHour,
      ip: (context) => context.request.headers.get("x-edge-client-ip") ?? undefined,
    },
  });
  await startNotificationListener({ service, host });

  createServer(async (request, response) => {
    try {
      const path = (request.url ?? "/").split("?")[0] as string;
      const raw = await read(request);
      if (path === "/__health") return send(response, 200, { instance });
      const body = raw.length === 0 ? {} : JSON.parse(raw.toString());
      if (path === "/__settle") {
        await waitUntil(body.at_ms);
        await host.onPaid({ paymentHash: body.payment_hash, paidAt: body.paid_at });
        return send(response, 200, { ok: true });
      }
      if (path === "/__reconcile") {
        await waitUntil(body.at_ms);
        const pass = await maybeReconcilePayments({ service, host });
        return send(response, 200, { reason: pass.reason });
      }
      if (path === "/__notify") {
        await waitUntil(body.at_ms);
        notificationHandler?.({
          type: "payment_received",
          payment_hash: body.payment_hash,
          transaction: body.transaction,
        });
        return send(response, 200, { ok: true });
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers.set(key, value);
      }
      const answer = await handler(
        new Request(`http://${request.headers.host}${request.url}`, {
          method: request.method,
          headers,
          ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: raw }),
        }),
        { native: request },
      );
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      response.end(await answer.text());
    } catch (error) {
      send(response, 500, { error: String((error as Error)?.message ?? error) });
    }
  }).listen(port, "127.0.0.1");
}

if (process.argv.includes("migrate")) {
  await migrate();
  await db.end();
} else {
  await serve();
}
