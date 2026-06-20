#!/usr/bin/env node

import http from "node:http";
import { pathToFileURL } from "node:url";
import { parseNwcConnectionUri } from "@openreceive/core";
import {
  TESTKIT_RELAY,
  TESTKIT_WALLET_PUBKEY,
  createTestkitReceiveClient
} from "@openreceive/testkit";

export const DEFAULT_MOCK_NWC =
  `nostr+walletconnect://${TESTKIT_WALLET_PUBKEY}` +
  `?relay=${encodeURIComponent(TESTKIT_RELAY)}` +
  `&secret=${"0".repeat(64)}`;

const MAX_BODY_BYTES = 64 * 1024;

export function createMockWalletService(options = {}) {
  const parsedNwc = parseNwcConnectionUri(options.nwc ?? DEFAULT_MOCK_NWC);
  const wallet = createTestkitReceiveClient({
    now: options.now,
    defaultExpirySeconds: options.defaultExpirySeconds,
    capabilitySummary: {
      walletPubkey: parsedNwc.walletPubkey,
      relays: parsedNwc.relays,
      ...(options.capabilitySummary ?? {})
    }
  });
  const notificationSubscribers = new Set();

  void wallet.subscribeToPaymentReceived((notification) => {
    const serialized = serializeJson(notification);
    for (const subscriber of notificationSubscribers) {
      subscriber(serialized);
    }
  });

  return {
    parsedNwc,
    wallet,
    health() {
      return {
        ok: true,
        wallet_pubkey: parsedNwc.walletPubkey,
        relay_count: parsedNwc.relays.length,
        invoice_count: wallet.listInvoices().length
      };
    },
    getInfo: () => wallet.preflight().then(serializeJson),
    makeInvoice: (body) => wallet.makeInvoice(makeInvoiceRequest(body)).then(serializeJson),
    lookupInvoice: (body) => wallet.lookupInvoice(lookupSelector(body)).then(serializeJson),
    listInvoices() {
      return serializeJson({
        invoices: wallet.listInvoices()
      });
    },
    settle(body) {
      return serializeJson(
        wallet.settleInvoice(lookupSelector(body), {
          ...(body.settled_at === undefined ? {} : { settled_at: numberFromJson(body.settled_at, "settled_at") }),
          ...(body.preimage === undefined ? {} : { preimage: stringFromJson(body.preimage, "preimage") })
        })
      );
    },
    expire(body) {
      return serializeJson(wallet.expireInvoice(lookupSelector(body)));
    },
    fail(body) {
      return serializeJson(wallet.failInvoice(lookupSelector(body)));
    },
    replayNotification(body) {
      return serializeJson({
        notifications: wallet.replayPaymentReceived(
          lookupSelector(body),
          body.count === undefined ? 1 : numberFromJson(body.count, "count")
        )
      });
    },
    subscribeNotification(handler) {
      notificationSubscribers.add(handler);
      return () => {
        notificationSubscribers.delete(handler);
      };
    }
  };
}

export function createMockWalletServer(options = {}) {
  const service = createMockWalletService(options);

  const server = http.createServer((request, response) => {
    void handleRequest(request, response, {
      service
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof NotFoundError ? 404 : 400;
      jsonResponse(response, status, {
        code: status === 404 ? "NOT_FOUND" : "INVALID_REQUEST",
        message
      });
    });
  });

  return {
    parsedNwc: service.parsedNwc,
    server,
    service,
    wallet: service.wallet,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      })
  };
}

async function handleRequest(request, response, context) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/healthz") {
    return jsonResponse(response, 200, context.service.health());
  }

  if (request.method === "GET" && url.pathname === "/nwc/get_info") {
    return jsonResponse(response, 200, await context.service.getInfo());
  }

  if (request.method === "POST" && url.pathname === "/nwc/make_invoice") {
    const body = await readJsonBody(request);
    const invoice = await context.service.makeInvoice(body);
    return jsonResponse(response, 200, invoice);
  }

  if (request.method === "POST" && url.pathname === "/nwc/lookup_invoice") {
    const body = await readJsonBody(request);
    const lookup = await context.service.lookupInvoice(body);
    return jsonResponse(response, 200, lookup);
  }

  if (request.method === "GET" && url.pathname === "/nwc/invoices") {
    return jsonResponse(response, 200, context.service.listInvoices());
  }

  if (request.method === "POST" && url.pathname === "/control/settle") {
    const body = await readJsonBody(request);
    const settled = context.service.settle(body);
    return jsonResponse(response, 200, settled);
  }

  if (request.method === "POST" && url.pathname === "/control/expire") {
    const body = await readJsonBody(request);
    return jsonResponse(response, 200, context.service.expire(body));
  }

  if (request.method === "POST" && url.pathname === "/control/fail") {
    const body = await readJsonBody(request);
    return jsonResponse(response, 200, context.service.fail(body));
  }

  if (request.method === "POST" && url.pathname === "/control/replay-notification") {
    const body = await readJsonBody(request);
    return jsonResponse(response, 200, context.service.replayNotification(body));
  }

  if (request.method === "GET" && url.pathname === "/notifications") {
    response.writeHead(200, {
      "cache-control": "no-store",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8"
    });
    response.write(": openreceive mock wallet notifications\n\n");
    const unsubscribe = context.service.subscribeNotification((notification) => {
      response.write(sseEvent("payment_received", notification));
    });
    request.on("close", () => {
      unsubscribe();
    });
    return;
  }

  throw new NotFoundError(`No mock wallet route for ${request.method} ${url.pathname}`);
}

function makeInvoiceRequest(body) {
  return {
    amount_msats: bigintFromJson(body.amount_msats, "amount_msats"),
    ...(body.description === undefined ? {} : { description: stringFromJson(body.description, "description") }),
    ...(body.description_hash === undefined ? {} : { description_hash: stringFromJson(body.description_hash, "description_hash") }),
    ...(body.expiry === undefined ? {} : { expiry: numberFromJson(body.expiry, "expiry") }),
    ...(body.metadata === undefined ? {} : { metadata: body.metadata })
  };
}

function lookupSelector(body) {
  const selector = {
    ...(body.payment_hash === undefined ? {} : { payment_hash: stringFromJson(body.payment_hash, "payment_hash") }),
    ...(body.invoice === undefined ? {} : { invoice: stringFromJson(body.invoice, "invoice") })
  };
  if (selector.payment_hash === undefined && selector.invoice === undefined) {
    throw new Error("lookup selector requires payment_hash or invoice");
  }
  return selector;
}

function bigintFromJson(value, field) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return BigInt(value);
  }
  throw new Error(`${field} must be a non-negative integer or integer string`);
}

function numberFromJson(value, field) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return Number(value);
  throw new Error(`${field} must be a safe integer`);
}

function stringFromJson(value, field) {
  if (typeof value === "string") return value;
  throw new Error(`${field} must be a string`);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
        reject(new Error("request body is too large"));
        request.destroy();
      }
    });
    request.on("error", reject);
    request.on("end", () => {
      if (body.trim() === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function jsonResponse(response, status, body) {
  if (response.headersSent) return;
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8"
  });
  response.end(`${JSON.stringify(serializeJson(body), null, 2)}\n`);
}

function serializeJson(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serializeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, serializeJson(entry)])
    );
  }
  return value;
}

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

class NotFoundError extends Error {}

export function startMockWalletCli() {
  const port = Number(process.env.OPENRECEIVE_MOCK_WALLET_PORT ?? 3798);
  const host = process.env.OPENRECEIVE_MOCK_WALLET_HOST ?? "127.0.0.1";
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error("OPENRECEIVE_MOCK_WALLET_PORT must be a TCP port.");
  }

  const instance = createMockWalletServer({
    nwc: process.env.OPENRECEIVE_MOCK_NWC
  });
  instance.server.listen(port, host, () => {
    const address = instance.server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`OpenReceive mock wallet listening on http://${host}:${actualPort}`);
    console.log(`Mock NWC: ${instance.parsedNwc.redacted}`);
    console.log("This service returns deterministic, non-payable invoice fixtures.");
  });

  const shutdown = () => {
    void instance.close().finally(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMockWalletCli();
}
