/**
 * Test-only control surface for testkit wallet mode (`DEMO_WALLET=testkit`).
 *
 * Mounted under `/__testkit` ONLY when the demo boots against the
 * `@openreceive/testkit` fakes; in every other mode the whole prefix 404s so
 * the routes cannot be mistaken for a production surface (and the SPA fallback
 * never serves index.html for them).
 *
 * Payload notes — keyed by what the fakes actually expose:
 * - Invoices are selected by `payment_hash` (or `invoice`), matching
 *   `TestkitInvoiceSelector`.
 * - Swaps are selected by `provider_order_id` (`testkit-swap-N`) and/or
 *   `pay_in_asset` — the testkit swap provider has no notion of the host
 *   order id, so `/swap-step` takes the provider-side keys.
 */

import express, { type Express, type Request, type Response, type Router } from "express";
import type { SwapAttentionReason, SwapProviderState } from "@openreceive/node";
import type { TestkitReceiveClient, TestkitSwapProvider } from "@openreceive/testkit";

export const SHOP_TESTKIT_PREFIX = "/__testkit";

export interface ShopTestkitFixtures {
  readonly client: TestkitReceiveClient;
  readonly swap: TestkitSwapProvider;
}

const SWAP_PROVIDER_STATES: readonly SwapProviderState[] = [
  "creating_provider_order",
  "awaiting_deposit",
  "confirming",
  "exchanging",
  "paying_invoice",
  "completed",
  "expired",
  "refund_required",
  "refund_pending",
  "refunded",
  "attention",
  "failed",
];

/**
 * Mount the `/__testkit` control routes. Pass `fixtures` only in testkit
 * wallet mode; with `undefined` the entire prefix answers 404 (JSON, not the
 * SPA fallback), so probing it from any other mode proves the surface is off.
 */
export function mountShopTestkitControls(
  app: Express,
  fixtures: ShopTestkitFixtures | undefined,
): void {
  if (fixtures === undefined) {
    app.use(SHOP_TESTKIT_PREFIX, (_req: Request, res: Response) => {
      res.status(404).json({ code: "NOT_FOUND", message: "Not found.", retryable: false });
    });
    return;
  }
  app.use(SHOP_TESTKIT_PREFIX, createTestkitControlRouter(fixtures));
}

function createTestkitControlRouter(fixtures: ShopTestkitFixtures): Router {
  const router = express.Router();

  // POST /__testkit/settle { payment_hash } — settle + emit the NWC-02
  // payment_received notification, exactly like a real wallet would.
  router.post("/settle", (req, res) => {
    const paymentHash = readString(req.body, "payment_hash");
    if (paymentHash === undefined) {
      return void sendError(res, 400, "payment_hash is required");
    }
    try {
      const transaction = fixtures.client.settleInvoice(
        { payment_hash: paymentHash },
        { notify: true },
      );
      sendJson(res, 200, { ok: true, transaction });
    } catch (error) {
      sendError(res, 404, messageOf(error));
    }
  });

  // POST /__testkit/expire { payment_hash } — force the invoice expired.
  router.post("/expire", (req, res) => {
    const paymentHash = readString(req.body, "payment_hash");
    if (paymentHash === undefined) {
      return void sendError(res, 400, "payment_hash is required");
    }
    try {
      const transaction = fixtures.client.expireInvoice({ payment_hash: paymentHash });
      sendJson(res, 200, { ok: true, transaction });
    } catch (error) {
      sendError(res, 404, messageOf(error));
    }
  });

  // POST /__testkit/swap-step { provider_order_id?, pay_in_asset?, state, attention_reason? }
  // Advance the scripted swap provider: the selected attempt(s) report `state`
  // on their next getStatus poll. `refund_required` and `attention` route
  // through the testkit's force helpers so their bookkeeping applies.
  router.post("/swap-step", (req, res) => {
    const providerOrderId = readString(req.body, "provider_order_id");
    const payInAsset = readString(req.body, "pay_in_asset");
    const state = readString(req.body, "state");
    if (providerOrderId === undefined && payInAsset === undefined) {
      return void sendError(res, 400, "provider_order_id or pay_in_asset is required");
    }
    if (state === undefined || !SWAP_PROVIDER_STATES.includes(state as SwapProviderState)) {
      return void sendError(res, 400, `state must be one of: ${SWAP_PROVIDER_STATES.join(", ")}`);
    }
    const selector = {
      ...(payInAsset === undefined ? {} : { payInAsset }),
      ...(providerOrderId === undefined ? {} : { providerOrderId }),
    } as Parameters<TestkitSwapProvider["script"]>[0];
    const swapState = state as SwapProviderState;
    if (swapState === "refund_required") {
      fixtures.swap.forceRefundRequired(selector);
    } else if (swapState === "attention") {
      const reason = readString(req.body, "attention_reason");
      fixtures.swap.forceAttention(
        selector,
        ...(reason === undefined ? [] : [reason as SwapAttentionReason]),
      );
    } else {
      fixtures.swap.script(selector, [swapState]);
    }
    sendJson(res, 200, { ok: true, state: swapState });
  });

  // GET /__testkit/state — debug aid: current wallet invoices + swap counters.
  router.get("/state", (_req, res) => {
    sendJson(res, 200, {
      wallet: {
        invoices: fixtures.client.listInvoices(),
      },
      swap: {
        create_calls: fixtures.swap.createCalls,
        quote_calls: fixtures.swap.quoteCalls,
        status_calls: fixtures.swap.statusCalls,
        refund_calls: fixtures.swap.refundCalls,
      },
    });
  });

  // Anything else under the prefix 404s inside the router — never falls
  // through to the SPA fallback.
  router.use((_req, res) => {
    res.status(404).json({ code: "NOT_FOUND", message: "Not found.", retryable: false });
  });

  return router;
}

function readString(body: unknown, field: string): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** JSON response that survives the testkit's bigint msat amounts. */
function sendJson(res: Response, status: number, payload: unknown): void {
  res
    .status(status)
    .type("application/json")
    .send(
      JSON.stringify(payload, (_key, value: unknown) =>
        typeof value === "bigint" ? Number(value) : value,
      ),
    );
}

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({
    code: status === 404 ? "NOT_FOUND" : "INVALID_REQUEST",
    message,
    retryable: false,
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
