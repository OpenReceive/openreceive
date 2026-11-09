import { createServer } from "node:http";
import { createTestkitReceiveClient } from "../../packages/js/testkit/src/index.ts";

// One fake wallet that every instance of a two-instance shop shares, the way
// two app processes share one NWC connection. It runs in the test process and
// wraps the ordinary testkit client over plain HTTP, so an instance written in
// any language reaches the same invoices, and each mint and history page is
// counted in one place.

const json = (value) =>
  JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? Number(item) : item));

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString();
      resolve(text.length === 0 ? {} : JSON.parse(text));
    });
    request.on("error", reject);
  });
}

function numeric(body, field) {
  if (body[field] === undefined || body[field] === null) return;
  body[field] = Number(body[field]);
}

export async function startSharedWallet() {
  const client = createTestkitReceiveClient();
  // `scans` counts history pages; `scanPasses` counts walks (a page at offset 0).
  // `scanPassTimes` holds the time of each walk: a pass makes one or two walks
  // at once, so a burst of them is one pass.
  const stats = {
    mints: 0,
    scans: 0,
    scanPasses: 0,
    scanPassTimes: [],
    scanInstances: new Set(),
    fulfilled: [],
  };

  const server = createServer(async (request, response) => {
    try {
      const body = await readBody(request);
      let result = {};
      if (request.url === "/make_invoice") {
        numeric(body, "amount_msats");
        numeric(body, "expiry");
        stats.mints += 1;
        result = await client.makeInvoice(body);
      } else if (request.url === "/list_transactions") {
        for (const field of ["from", "until", "limit", "offset"]) numeric(body, field);
        stats.scans += 1;
        if (!body.offset) {
          stats.scanPasses += 1;
          stats.scanPassTimes.push(Date.now());
          stats.scanInstances.add(request.headers["x-edge-instance"] ?? "unknown");
        }
        result = await client.listTransactions(body);
      } else if (request.url === "/fulfilled") {
        stats.fulfilled.push(body);
      } else {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(json(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(json({ error: String(error?.message ?? error) }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    stats,
    settle(paymentHash) {
      return client.settleInvoice({ payment_hash: paymentHash });
    },
    /** The notification a wallet would publish for this settled invoice, as JSON. */
    transaction(paymentHash) {
      const row = client.listInvoices().find((item) => item.payment_hash === paymentHash);
      return JSON.parse(json(row));
    },
    /** Walks grouped into passes: a gap of over a second starts a new pass. */
    passCount() {
      let passes = 0;
      let last = 0;
      for (const at of stats.scanPassTimes) {
        if (at - last > 1_000) passes += 1;
        last = at;
      }
      return passes;
    },
    resetCounters() {
      stats.mints = 0;
      stats.scans = 0;
      stats.scanPasses = 0;
      stats.scanPassTimes.length = 0;
      stats.scanInstances.clear();
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
