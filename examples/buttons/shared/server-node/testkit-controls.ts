/**
 * Test-only control surface for testkit wallet mode (`DEMO_WALLET=testkit`).
 *
 * Live under `/__testkit` ONLY when the demo booted against the
 * `@openreceive/testkit` fakes; in every other mode the whole prefix answers
 * 404 (JSON, never the SPA fallback) so the routes cannot be mistaken for a
 * production surface.
 *
 * FRAMEWORK-FREE, the same way shop-routes.ts is: `testkitControl` is the whole
 * behaviour, and the Express and Next.js adapters below and in the app router
 * only translate. That is what lets the harness point at any of the three Node
 * stacks rather than only the one whose glue happened to be written.
 *
 * Payload notes — keyed by what the fakes actually expose:
 * - Invoices are selected by `payment_hash` (or `invoice`), matching
 *   `TestkitInvoiceSelector`.
 * - Swaps are selected by `provider_order_id` (`testkit-swap-N`) and/or
 *   `pay_in_asset` — the testkit swap provider has no notion of the host order
 *   id, so `/swap-step` takes the provider-side keys.
 */

import type { SwapAttentionReason, SwapProviderState } from "@openreceive/node";
import type { TestkitReceiveClient, TestkitSwapProvider } from "@openreceive/testkit";
import express, { type Express, type Request, type Response } from "express";

export const SHOP_TESTKIT_PREFIX = "/__testkit";

export interface ShopTestkitFixtures {
  readonly client: TestkitReceiveClient;
  readonly swap: TestkitSwapProvider;
}

export interface TestkitResult {
  readonly status: number;
  readonly json: unknown;
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
 * One control call. `action` is the path segment after the prefix.
 *
 * `fixtures === undefined` is NOT testkit mode, and every action is a 404 —
 * probing the surface from any other mode proves it is off.
 */
export const testkitControl = (
  action: string,
  body: unknown,
  fixtures: ShopTestkitFixtures | undefined,
): TestkitResult => {
  if (fixtures === undefined) return notFound();

  // POST /__testkit/settle { payment_hash } — settle and emit the NWC-02
  // payment_received notification, exactly as a real wallet would.
  if (action === "settle") {
    const paymentHash = readString(body, "payment_hash");
    if (paymentHash === undefined) return invalid("payment_hash is required");
    try {
      const transaction = fixtures.client.settleInvoice(
        { payment_hash: paymentHash },
        { notify: true },
      );
      return { status: 200, json: { ok: true, transaction: plain(transaction) } };
    } catch (error) {
      return { status: 404, json: errorBody(404, messageOf(error)) };
    }
  }

  // POST /__testkit/expire { payment_hash } — force the invoice expired.
  if (action === "expire") {
    const paymentHash = readString(body, "payment_hash");
    if (paymentHash === undefined) return invalid("payment_hash is required");
    try {
      const transaction = fixtures.client.expireInvoice({ payment_hash: paymentHash });
      return { status: 200, json: { ok: true, transaction: plain(transaction) } };
    } catch (error) {
      return { status: 404, json: errorBody(404, messageOf(error)) };
    }
  }

  // POST /__testkit/swap-step { provider_order_id?, pay_in_asset?, state, attention_reason? }
  // Advance the scripted swap provider: the selected attempt(s) report `state`
  // on their next getStatus poll. `refund_required` and `attention` route
  // through the testkit's force helpers so their bookkeeping applies.
  if (action === "swap-step") {
    const providerOrderId = readString(body, "provider_order_id");
    const payInAsset = readString(body, "pay_in_asset");
    const state = readString(body, "state");
    if (providerOrderId === undefined && payInAsset === undefined) {
      return invalid("provider_order_id or pay_in_asset is required");
    }
    if (state === undefined || !SWAP_PROVIDER_STATES.includes(state as SwapProviderState)) {
      return invalid(`state must be one of: ${SWAP_PROVIDER_STATES.join(", ")}`);
    }

    const selector = {
      ...(payInAsset === undefined ? {} : { payInAsset }),
      ...(providerOrderId === undefined ? {} : { providerOrderId }),
    } as Parameters<TestkitSwapProvider["script"]>[0];
    const swapState = state as SwapProviderState;

    if (swapState === "refund_required") {
      fixtures.swap.forceRefundRequired(selector);
    } else if (swapState === "attention") {
      const reason = readString(body, "attention_reason");
      fixtures.swap.forceAttention(
        selector,
        ...(reason === undefined ? [] : [reason as SwapAttentionReason]),
      );
    } else {
      fixtures.swap.script(selector, [swapState]);
    }
    return { status: 200, json: { ok: true, state: swapState } };
  }

  // GET /__testkit/state — debug aid: current wallet invoices + swap counters.
  if (action === "state") {
    return {
      status: 200,
      json: plain({
        wallet: { invoices: fixtures.client.listInvoices() },
        swap: {
          create_calls: fixtures.swap.createCalls,
          quote_calls: fixtures.swap.quoteCalls,
          status_calls: fixtures.swap.statusCalls,
          refund_calls: fixtures.swap.refundCalls,
        },
      }),
    };
  }

  return notFound();
};

/** The Express adapter. Pass `fixtures` only in testkit mode. */
export function mountShopTestkitControls(
  app: Express,
  fixtures: ShopTestkitFixtures | undefined,
): void {
  app.use(SHOP_TESTKIT_PREFIX, express.json(), (req: Request, res: Response) => {
    const action = req.path.replace(/^\/+/, "");
    const result = testkitControl(action, req.body, fixtures);
    res.status(result.status).json(result.json);
  });
}

function readString(body: unknown, field: string): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The testkit reports msat amounts as bigints, which JSON.stringify refuses. */
function plain<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, entry: unknown) =>
      typeof entry === "bigint" ? Number(entry) : entry,
    ),
  );
}

const notFound = (): TestkitResult => ({ status: 404, json: errorBody(404, "Not found.") });

const invalid = (message: string): TestkitResult => ({
  status: 400,
  json: errorBody(400, message),
});

function errorBody(status: number, message: string) {
  return {
    code: status === 404 ? "NOT_FOUND" : "INVALID_REQUEST",
    message,
    retryable: false,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
