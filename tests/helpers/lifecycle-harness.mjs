// P1 harness: real browser components -> real HTTP handler -> real SQL repository
// on in-memory SQLite -> testkit fake wallet + fake swap provider. No network, no
// real wallet, no server socket: the components' fetch is the handler itself.
import {
  createOpenReceiveHost,
  createOpenReceiveHttpHandler,
} from "../../packages/js/http/src/index.ts";
import { createOpenReceive } from "../../packages/js/node/src/index.ts";
import {
  createTestkitReceiveClient,
  createTestkitSwapProvider,
} from "../../packages/js/testkit/src/index.ts";
import { memoryPaymentsDb } from "./factories.mjs";

/**
 * Build the full in-memory stack. Clocks default to real unix time because the
 * browser layer compares `expires_at` against `Date.now()`; determinism comes from
 * scheduling (see installFastTimers/until), not from freezing the calendar.
 */
export async function createLifecycleStack(options = {}) {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const wallet = createTestkitReceiveClient({ now });
  const swapProvider = createTestkitSwapProvider({ now });
  const service = await createOpenReceive({
    client: wallet,
    clock: now,
    swap: { provider: swapProvider },
  });
  const db = memoryPaymentsDb();
  const orders = new Map();
  const settlements = [];
  const host = createOpenReceiveHost({
    db,
    loadOrder: (orderId) => orders.get(orderId) ?? null,
    amountForOrder: (order) => order.amount,
    onPaid: async (settlement) => {
      settlements.push(settlement);
    },
  });
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    host,
  });
  const requests = [];
  const fetchStub = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url, "http://harness.local");
    const record = {
      method: init?.method ?? (typeof input === "object" ? input.method : "GET"),
      path: url.pathname,
      body: parseBody(init?.body),
    };
    const response = await handler(new Request(url, init));
    record.status = response.status;
    record.responseBody = await response
      .clone()
      .json()
      .catch(() => undefined);
    requests.push(record);
    return response;
  };
  return {
    service,
    wallet,
    swapProvider,
    handler,
    orders,
    settlements,
    requests,
    fetchStub,
    addOrder(orderId, sats = 1234) {
      orders.set(orderId, { amount: { sats } });
    },
    checkCalls() {
      return requests.filter((entry) => entry.path.endsWith("/payments/check"));
    },
    async close() {
      await service.close();
    },
  };
}

function parseBody(body) {
  if (typeof body !== "string") return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * Clamp every timer delay so second-scale countdowns and 3s poll intervals run in
 * tens of milliseconds. Clamps down only; call the returned restore() when done.
 */
export function installFastTimers(maxDelayMs = 25) {
  const original = {
    setInterval: globalThis.setInterval,
    setTimeout: globalThis.setTimeout,
  };
  globalThis.setInterval = (fn, delay, ...args) =>
    original.setInterval(fn, Math.min(delay ?? 0, maxDelayMs), ...args);
  globalThis.setTimeout = (fn, delay, ...args) =>
    original.setTimeout(fn, Math.min(delay ?? 0, maxDelayMs), ...args);
  return () => {
    globalThis.setInterval = original.setInterval;
    globalThis.setTimeout = original.setTimeout;
  };
}

/** Poll until predicate() is truthy (its value is returned) or fail with `label`. */
export async function until(
  predicate,
  { timeoutMs = 8000, stepMs = 10, label = "condition" } = {},
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}
