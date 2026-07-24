import type {
  Checkout,
  CreateCheckoutAmount,
  OpenReceive,
  SwapCheckout,
  SwapData,
} from "@openreceive/node";
import type { OpenReceiveHost } from "./host-payments.ts";
import type {
  OpenReceiveAuthorize,
  OpenReceiveAuthorizeAction,
  OpenReceiveAuthorizeResource,
  OpenReceiveRateLimit,
} from "./authorize.ts";
import { createRequestId, errorResponse, jsonResponse, OpenReceiveHttpError } from "./errors.ts";
import { matchRoute, normalizePrefix } from "./router.ts";

export interface CheckoutCreatedInput {
  readonly orderId: string;
  readonly paymentHash: string;
  readonly checkout: Checkout;
  /** Sensitive server-only provider state. Persist it on the payment attempt; never send it to a browser. */
  readonly swapData?: SwapData;
}

export type CheckoutCreatedHook = (input: CheckoutCreatedInput) => void | Promise<void>;

export interface ResolveCheckoutContext {
  readonly action: OpenReceiveAuthorizeAction;
  readonly request: Request;
  readonly orderId: string;
  readonly payInAsset?: string;
  /** Untrusted payer input. Use it only to locate/recompute host-owned data. */
  readonly input: Readonly<Record<string, unknown>>;
}

export interface ResolvedHostCheckout {
  /** Host-owned price. Payer input is never an amount authority. */
  readonly amount: CreateCheckoutAmount;
  /** Return the selected host payment attempt's hash to reuse or inspect its checkout. */
  readonly paymentHash?: string;
  /** Host-persisted safe checkout snapshot used for retry without a wallet read. */
  readonly checkout?: Checkout;
  /** Server-only structured provider state loaded from the host database. */
  readonly swapData?: SwapData;
}

export type ResolveCheckoutHook = (
  context: ResolveCheckoutContext,
) => ResolvedHostCheckout | Promise<ResolvedHostCheckout>;

export interface CreateOpenReceiveHttpHandlerOptions {
  readonly service: OpenReceive;
  /** Host authentication and authorization policy. OpenReceive never inspects host sessions. */
  readonly authorize: OpenReceiveAuthorize;
  /** Host authentication-independent payment integration returned by createOpenReceiveHost. */
  readonly host: OpenReceiveHost;
  readonly rateLimit?: OpenReceiveRateLimit;
  readonly prefix?: string;
}

export interface OpenReceiveHttpHandler {
  (request: Request): Promise<Response>;
  readonly prefix: string;
  handle(request: Request): Promise<Response>;
}

interface Runtime extends CreateOpenReceiveHttpHandlerOptions {
  readonly prefix: string;
}

export function createOpenReceiveHttpHandler(
  options: CreateOpenReceiveHttpHandlerOptions,
): OpenReceiveHttpHandler {
  if (options?.service === undefined) throw new TypeError("HTTP handler requires service.");
  if (options.authorize === undefined) {
    throw new TypeError("HTTP handler requires authorize; authentication belongs to the host.");
  }
  if (options.host === undefined) throw new TypeError("HTTP handler requires host.");
  const runtime: Runtime = {
    ...options,
    prefix: normalizePrefix(options.prefix ?? "/openreceive"),
  };
  const handle = async (request: Request): Promise<Response> => {
    const requestId = createRequestId();
    try {
      return await dispatch(runtime, request, requestId);
    } catch (error) {
      return errorResponse(error, requestId);
    }
  };
  const handler = handle as OpenReceiveHttpHandler;
  Object.defineProperties(handler, {
    prefix: { value: runtime.prefix, enumerable: true },
    handle: { value: handle, enumerable: true },
  });
  return handler;
}

async function dispatch(runtime: Runtime, request: Request, requestId: string): Promise<Response> {
  const url = new URL(request.url);
  const route = matchRoute(runtime.prefix, request.method, url.pathname);
  if (route === null)
    throw new OpenReceiveHttpError(404, "NOT_FOUND", "No OpenReceive route matched.");

  if (route.kind === "rates") {
    const currencies = url.searchParams
      .get("currencies")
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return jsonResponse(
      200,
      await runtime.service.listRates(currencies === undefined ? undefined : { currencies }),
      requestId,
    );
  }

  const body = await readJsonBody(request);
  const orderId = requiredString(body.order_id ?? body.orderId, "order_id");

  if (route.kind === "checkout.create") {
    rejectPayerAmount(body);
    await guard(runtime, "checkout.create", request, { order_id: orderId });
    const resolved = await resolveHost(runtime, "checkout.create", request, orderId, body);
    const checkout =
      resolved.paymentHash === undefined
        ? await runtime.service.createCheckout({
            orderId,
            amount: requiredAmount(resolved),
            ...optionalCheckoutFields(body),
          })
        : committedCheckout(orderId, resolved);
    if (resolved.paymentHash === undefined) {
      await commit(runtime, { orderId, paymentHash: checkout.paymentHash, checkout });
    }
    return jsonResponse(201, { checkout: httpCheckout(checkout) }, requestId);
  }

  if (route.kind === "payment.check") {
    const requestedPaymentHash = requiredPaymentHash(
      requiredString(body.payment_hash ?? body.paymentHash, "payment_hash"),
    );
    await guard(runtime, "payment.check", request, {
      order_id: orderId,
      payment_hash: requestedPaymentHash,
    });
    const resolved = await resolveHost(runtime, "payment.check", request, orderId, body);
    const paymentHash = selectedPaymentHash(resolved, requestedPaymentHash);
    const checked = await runtime.service.checkPayment({
      paymentHash,
      createdAt: requiredCheckout(resolved).createdAt,
    });
    if (checked.status === "settled" && checked.paidAt !== undefined) {
      await runtime.host.onPaid({
        paymentHash: checked.paymentHash,
        paidAt: checked.paidAt,
        details: checked.details,
      });
    }
    return jsonResponse(200, toSnakeCase(checked), requestId);
  }

  if (route.kind === "swap.quote") {
    rejectPayerAmount(body);
    const payInAsset = requiredString(body.pay_in_asset ?? body.payInAsset, "pay_in_asset");
    await guard(runtime, "swap.quote", request, { order_id: orderId });
    const resolved = await resolveHost(runtime, "swap.quote", request, orderId, body, payInAsset);
    return jsonResponse(
      200,
      toSnakeCase(
        await runtime.service.quoteSwap({
          amount: requiredAmount(resolved),
          payInAsset,
        }),
      ),
      requestId,
    );
  }

  if (route.kind === "swap.create") {
    rejectPayerAmount(body);
    const payInAsset = requiredString(body.pay_in_asset ?? body.payInAsset, "pay_in_asset");
    await guard(runtime, "swap.create", request, { order_id: orderId });
    const resolved = await resolveHost(runtime, "swap.create", request, orderId, body, payInAsset);
    const swap =
      resolved.paymentHash === undefined
        ? await runtime.service.createSwap({
            orderId,
            amount: requiredAmount(resolved),
            payInAsset,
            ...optionalCheckoutFields(body),
          })
        : await recoverCommittedSwap(runtime, orderId, resolved);
    if (resolved.paymentHash === undefined) {
      await commit(runtime, {
        orderId,
        paymentHash: swap.paymentHash,
        checkout: swap.checkout,
        swapData: swap.swapData,
      });
    }
    return jsonResponse(201, { swap: httpSwap(swap) }, requestId);
  }

  const action: OpenReceiveAuthorizeAction =
    route.kind === "swap.read" ? "swap.read" : "swap.refund";
  const requestedPaymentHash = requiredPaymentHash(
    requiredString(body.payment_hash ?? body.paymentHash, "payment_hash"),
  );
  await guard(runtime, action, request, {
    order_id: orderId,
    payment_hash: requestedPaymentHash,
  });
  const resolved = await resolveHost(runtime, action, request, orderId, body);
  const swapData = requiredSwapData(resolved.swapData);
  const paymentHash = selectedPaymentHash(resolved, requestedPaymentHash);
  if (route.kind === "swap.read") {
    return jsonResponse(
      200,
      toSnakeCase(
        await runtime.service.getSwap({
          orderId,
          paymentHash,
          swapData,
        }),
      ),
      requestId,
    );
  }
  const refundAddress = requiredString(body.refund_address ?? body.refundAddress, "refund_address");
  return jsonResponse(
    200,
    toSnakeCase(
      await runtime.service.refundSwap({
        orderId,
        paymentHash,
        swapData,
        refundAddress,
      }),
    ),
    requestId,
  );
}

async function resolveHost(
  runtime: Runtime,
  action: OpenReceiveAuthorizeAction,
  request: Request,
  orderId: string,
  input: Readonly<Record<string, unknown>>,
  payInAsset?: string,
): Promise<ResolvedHostCheckout> {
  return runtime.host.resolveCheckout({
    action,
    request,
    orderId,
    ...(payInAsset === undefined ? {} : { payInAsset }),
    input,
  });
}

async function guard(
  runtime: Runtime,
  action: OpenReceiveAuthorizeAction,
  request: Request,
  resource: OpenReceiveAuthorizeResource,
): Promise<void> {
  const context = { action, request, resource };
  if (runtime.rateLimit !== undefined && !(await runtime.rateLimit(context))) {
    throw new OpenReceiveHttpError(429, "RATE_LIMITED", "Too many requests.", { retryable: true });
  }
  if (!(await runtime.authorize(context))) {
    throw new OpenReceiveHttpError(403, "UNAUTHORIZED", "Not authorized for this action.");
  }
}

async function commit(runtime: Runtime, input: CheckoutCreatedInput): Promise<void> {
  try {
    await runtime.host.onCheckoutCreated(input);
  } catch (error) {
    if (error instanceof OpenReceiveHttpError) throw error;
    throw new OpenReceiveHttpError(
      409,
      "CONFLICT",
      "The host did not persist this payment attempt; payer instructions were withheld.",
    );
  }
}

function httpCheckout(checkout: Checkout): Record<string, unknown> {
  return {
    order_id: checkout.orderId,
    payment_hash: checkout.paymentHash,
    bolt11: checkout.bolt11,
    amount_msats: checkout.amountMsats,
    created_at: checkout.createdAt,
    expires_at: checkout.expiresAt,
    fiat_quote: checkout.fiatQuote === null ? null : toSnakeCase(checkout.fiatQuote),
  };
}

function httpSwap(swap: SwapCheckout): Record<string, unknown> {
  const { checkout, swapData: _swapData, ...rest } = swap;
  return {
    ...(toSnakeCase(rest) as Record<string, unknown>),
    checkout: httpCheckout(checkout),
  };
}

function optionalCheckoutFields(body: Record<string, unknown>) {
  const memo = optionalString(body.memo);
  const descriptionHash = optionalString(body.description_hash ?? body.descriptionHash);
  const metadata = readRecord(body.metadata);
  return {
    ...(memo === undefined ? {} : { memo }),
    ...(descriptionHash === undefined ? {} : { descriptionHash }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function selectedPaymentHash(resolved: ResolvedHostCheckout, requestedPaymentHash: string): string {
  const selected = requiredPaymentHash(resolved.paymentHash);
  if (selected !== requestedPaymentHash) {
    throw new OpenReceiveHttpError(
      404,
      "NOT_FOUND",
      "The selected payment attempt does not belong to this order.",
    );
  }
  return selected;
}

function requiredAmount(value: ResolvedHostCheckout): CreateCheckoutAmount {
  return value.amount;
}

function requiredCheckout(value: ResolvedHostCheckout): Checkout {
  if (value.checkout === undefined) {
    throw new OpenReceiveHttpError(
      409,
      "CONFLICT",
      "The host payment attempt has no checkout snapshot.",
    );
  }
  return value.checkout;
}

function requiredSwapData(value: SwapData | undefined): SwapData {
  if (value === undefined) {
    throw new OpenReceiveHttpError(404, "NOT_FOUND", "The host order has no swap data.");
  }
  return value;
}

function committedCheckout(
  orderId: string,
  resolved: ResolvedHostCheckout,
): Checkout {
  const paymentHash = requiredPaymentHash(resolved.paymentHash);
  const checkout = requiredCheckout(resolved);
  if (checkout.orderId !== orderId || checkout.paymentHash.toLowerCase() !== paymentHash) {
    throw new OpenReceiveHttpError(
      409,
      "CONFLICT",
      "The selected payment attempt is not a reusable pending checkout.",
    );
  }
  return structuredClone(checkout);
}

async function recoverCommittedSwap(
  runtime: Runtime,
  orderId: string,
  resolved: ResolvedHostCheckout,
): Promise<SwapCheckout> {
  const paymentHash = requiredPaymentHash(resolved.paymentHash);
  const swapData = requiredSwapData(resolved.swapData);
  const status = await runtime.service.getSwap({ orderId, paymentHash, swapData });
  const checkout = committedCheckout(orderId, resolved);
  if (status.orderId !== orderId || status.paymentHash !== paymentHash) {
    throw new OpenReceiveHttpError(
      409,
      "CONFLICT",
      "The host swap data does not match its payment hash.",
    );
  }
  return { ...status, checkout, swapData };
}

function rejectPayerAmount(body: Record<string, unknown>): void {
  if (body.amount !== undefined || body.amount_msats !== undefined) {
    throw new OpenReceiveHttpError(
      400,
      "INVALID_REQUEST",
      "This route does not accept a payer-supplied amount; the host resolves its order price.",
    );
  }
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const text = await request.text();
    const value = text.trim() === "" ? {} : JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new OpenReceiveHttpError(400, "INVALID_REQUEST", "Request body must be a JSON object.");
  }
}

function requiredPaymentHash(value: unknown): string {
  const hash = requiredString(value, "payment_hash").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new OpenReceiveHttpError(
      400,
      "INVALID_REQUEST",
      "payment_hash must be 64 hexadecimal characters.",
    );
  }
  return hash;
}

function requiredString(value: unknown, field: string): string {
  const result = optionalString(value);
  if (result === undefined)
    throw new OpenReceiveHttpError(400, "INVALID_REQUEST", `${field} is required.`);
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OpenReceiveHttpError(400, "INVALID_REQUEST", "metadata must be an object.");
  }
  return value as Record<string, unknown>;
}

function toSnakeCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toSnakeCase);
  if (typeof value === "bigint") return Number(value);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      toSnakeCase(item),
    ]),
  );
}
