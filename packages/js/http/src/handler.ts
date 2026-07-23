import type {
  Checkout,
  CreateCheckoutAmount,
  OpenReceive,
  SwapCheckout,
} from "@openreceive/node";
import {
  createDefaultAuthorize,
  type OpenReceiveAuthorize,
  type OpenReceiveAuthorizeAction,
  type OpenReceiveAuthorizeResource,
  type OpenReceiveRateLimit,
} from "./authorize.ts";
import { createRequestId, errorResponse, jsonResponse, OpenReceiveHttpError } from "./errors.ts";
import { matchRoute, normalizePrefix } from "./router.ts";
import type { CapabilityTokenManager } from "./tokens.ts";

export const ORDER_TOKEN_COOKIE_NAME = "openreceive_payment_capability";

export interface CheckoutCreatedInput {
  readonly orderId: string;
  readonly paymentHash: string;
  readonly checkout: Checkout;
  readonly swapRecoveryToken?: string;
}

export type CheckoutCreatedHook = (
  input: CheckoutCreatedInput,
) => void | Promise<void>;

export interface ResolveCheckoutAmountContext {
  readonly action: "checkout.create" | "swap.create";
  readonly request: Request;
  readonly orderId: string;
  readonly payInAsset?: string;
  /** Untrusted payer input. Use it only to locate/recompute the host-owned price. */
  readonly input: Readonly<Record<string, unknown>>;
}

export interface ResolvedHostCheckout {
  readonly amount: CreateCheckoutAmount;
  /** Return the host row's live hash to reuse a checkout instead of minting on retry. */
  readonly paymentHash?: string;
  readonly swapRecoveryToken?: string;
}

export type ResolveCheckoutAmountHook = (
  context: ResolveCheckoutAmountContext,
) => CreateCheckoutAmount | ResolvedHostCheckout | Promise<CreateCheckoutAmount | ResolvedHostCheckout>;

export interface CreateOpenReceiveHttpHandlerOptions {
  readonly service: OpenReceive;
  /** Host policy. Checkout creation should validate the host-owned order price. */
  readonly authorize: OpenReceiveAuthorize;
  /** Recomputes the price from host-owned order/catalog data for each create request. */
  readonly resolveCheckoutAmount: ResolveCheckoutAmountHook;
  /** Persists payment_hash (and swap token) before payer instructions are exposed. */
  readonly onCheckoutCreated: CheckoutCreatedHook;
  readonly rateLimit?: OpenReceiveRateLimit;
  readonly capabilities?: CapabilityTokenManager;
  readonly prefix?: string;
}

export interface OpenReceiveHttpHandler {
  (request: Request): Promise<Response>;
  readonly prefix: string;
  handle(request: Request): Promise<Response>;
}

interface Runtime extends CreateOpenReceiveHttpHandlerOptions {
  readonly prefix: string;
  readonly capabilities: CapabilityTokenManager;
}

export function createOpenReceiveHttpHandler(
  options: CreateOpenReceiveHttpHandlerOptions,
): OpenReceiveHttpHandler {
  if (options?.service === undefined) throw new TypeError("HTTP handler requires service.");
  if (options.authorize === undefined) {
    throw new TypeError("HTTP handler requires authorize; checkout price authority belongs to the host.");
  }
  if (options.resolveCheckoutAmount === undefined) {
    throw new TypeError("HTTP handler requires resolveCheckoutAmount; payer input is not a price authority.");
  }
  if (options.onCheckoutCreated === undefined) {
    throw new TypeError("HTTP handler requires onCheckoutCreated to persist payment_hash before responding.");
  }
  const prefix = normalizePrefix(options.prefix ?? "/openreceive");
  const capabilities = options.capabilities ?? serviceCapabilities(options.service);
  const runtime: Runtime = { ...options, prefix, capabilities };
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
    prefix: { value: prefix, enumerable: true },
    handle: { value: handle, enumerable: true },
  });
  return handler;
}

async function dispatch(runtime: Runtime, request: Request, requestId: string): Promise<Response> {
  const url = new URL(request.url);
  const route = matchRoute(runtime.prefix, request.method, url.pathname);
  if (route === null) throw new OpenReceiveHttpError(404, "NOT_FOUND", "No OpenReceive route matched.");

  if (route.kind === "rates") {
    const currencies = url.searchParams.get("currencies")?.split(",").map((value) => value.trim()).filter(Boolean);
    return jsonResponse(200, await runtime.service.listRates(currencies === undefined ? undefined : { currencies }), requestId);
  }

  const body = await readJsonBody(request);
  if (route.kind === "checkout.create") {
    const orderId = requiredString(body.order_id ?? body.orderId, "order_id");
    rejectPayerAmount(body);
    await guard(runtime, "checkout.create", request, { order_id: orderId }, null);
    const resolved = normalizeResolvedCheckout(await runtime.resolveCheckoutAmount({
      action: "checkout.create",
      request,
      orderId,
      input: body,
    }));
    const checkout = resolved.paymentHash === undefined
      ? await runtime.service.createCheckout({
          orderId,
          amount: resolved.amount,
          ...optionalCheckoutFields(body),
        })
      : await recoverCommittedCheckout(runtime, orderId, resolved.paymentHash);
    const accessToken = await runtime.capabilities.mint({
      orderId,
      paymentHash: checkout.paymentHash,
      expiresAt: Math.max(checkout.expiresAt, unixNow() + 86_400),
    });
    if (resolved.paymentHash === undefined) {
      await commit(runtime, { orderId, paymentHash: checkout.paymentHash, checkout });
    }
    return jsonResponse(201, {
      checkout: httpCheckout(checkout),
      order_access_token: accessToken,
    }, requestId, [["set-cookie", capabilityCookie(runtime.prefix, accessToken, request)]]);
  }

  if (route.kind === "payment.check") {
    const paymentHash = requiredPaymentHash(body.payment_hash ?? body.paymentHash);
    await guard(runtime, "payment.check", request, { payment_hash: paymentHash }, extractToken(request));
    return jsonResponse(200, toSnakeCase(await runtime.service.checkPayment({ paymentHash })), requestId);
  }

  if (route.kind === "swap.quote") {
    await guard(runtime, "swap.quote", request, {}, extractToken(request));
    return jsonResponse(200, toSnakeCase(await runtime.service.quoteSwap({
      amount: readAmount(body.amount),
      payInAsset: requiredString(body.pay_in_asset ?? body.payInAsset, "pay_in_asset"),
    })), requestId);
  }

  if (route.kind === "swap.create") {
    const orderId = requiredString(body.order_id ?? body.orderId, "order_id");
    rejectPayerAmount(body);
    const payInAsset = requiredString(body.pay_in_asset ?? body.payInAsset, "pay_in_asset");
    await guard(runtime, "swap.create", request, { order_id: orderId }, extractToken(request));
    const resolved = normalizeResolvedCheckout(await runtime.resolveCheckoutAmount({
      action: "swap.create",
      request,
      orderId,
      payInAsset,
      input: body,
    }));
    const swap = resolved.paymentHash === undefined
      ? await runtime.service.createSwap({
          orderId,
          amount: resolved.amount,
          payInAsset,
          ...optionalCheckoutFields(body),
        })
      : await recoverCommittedSwap(runtime, orderId, resolved);
    const accessToken = await runtime.capabilities.mint({
      orderId,
      paymentHash: swap.paymentHash,
      expiresAt: Math.max(swap.providerExpiresAt, unixNow() + 86_400),
    });
    if (resolved.paymentHash === undefined) {
      await commit(runtime, {
        orderId,
        paymentHash: swap.paymentHash,
        checkout: swap.checkout,
        swapRecoveryToken: swap.swapRecoveryToken,
      });
    }
    return jsonResponse(201, {
      swap: httpSwap(swap),
      order_access_token: accessToken,
    }, requestId, [["set-cookie", capabilityCookie(runtime.prefix, accessToken, request)]]);
  }

  const recoveryToken = requiredString(
    body.swap_recovery_token ?? body.recovery_token ?? body.recoveryToken,
    "swap_recovery_token",
  );
  const action: OpenReceiveAuthorizeAction =
    route.kind === "swap.read"
      ? "swap.read"
      : route.kind === "swap.refund.confirm"
        ? "swap.refund.confirm"
        : "swap.refund";
  await guard(runtime, action, request, { recovery_token_present: true }, extractToken(request), true);

  if (route.kind === "swap.read") {
    return jsonResponse(200, toSnakeCase(await runtime.service.getSwap({ recoveryToken })), requestId);
  }
  const refundAddress = requiredString(body.refund_address ?? body.refundAddress, "refund_address");
  if (route.kind === "swap.refund.confirm") {
    return jsonResponse(201, toSnakeCase(await runtime.service.createSwapRefundConfirmation({
      recoveryToken,
      refundAddress,
    })), requestId);
  }
  return jsonResponse(200, toSnakeCase(await runtime.service.refundSwap({
    recoveryToken,
    refundAddress,
    confirmationToken: requiredString(
      body.confirmation_token ?? body.confirmationToken,
      "confirmation_token",
    ),
  })), requestId);
}

async function guard(
  runtime: Runtime,
  action: OpenReceiveAuthorizeAction,
  request: Request,
  resource: OpenReceiveAuthorizeResource,
  token: string | null,
  recoveryCapability = false,
): Promise<void> {
  const capability = token === null ? null : await runtime.capabilities.verify(token);
  const tokenValid = recoveryCapability || (
    capability !== null &&
    (resource.order_id === undefined || capability.orderId === resource.order_id) &&
    (resource.payment_hash === undefined || capability.paymentHash === resource.payment_hash)
  );
  const context = { action, request, resource, token, tokenValid };
  if (runtime.rateLimit !== undefined && !(await runtime.rateLimit(context))) {
    throw new OpenReceiveHttpError(429, "RATE_LIMITED", "Too many requests.", { retryable: true });
  }
  if (!(await runtime.authorize(context))) {
    throw new OpenReceiveHttpError(403, "UNAUTHORIZED", "Not authorized for this action.");
  }
}

function serviceCapabilities(service: OpenReceive): CapabilityTokenManager {
  return {
    mint: (input) => service.mintCapabilityToken(input),
    verify: (token) => token == null
      ? Promise.resolve(null)
      : service.verifyCapabilityToken(token).then((payload) =>
          payload === null ? null : { version: 1 as const, issuedAt: 0, ...payload }),
  };
}

async function commit(runtime: Runtime, input: CheckoutCreatedInput): Promise<void> {
  try {
    await runtime.onCheckoutCreated(input);
  } catch (error) {
    if (error instanceof OpenReceiveHttpError) throw error;
    throw new OpenReceiveHttpError(
      409,
      "CONFLICT",
      "The host did not persist this payment hash; payer instructions were withheld.",
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
  const { checkout, swapRecoveryToken, ...rest } = swap;
  return {
    ...(toSnakeCase(rest) as Record<string, unknown>),
    checkout: httpCheckout(checkout),
    swap_recovery_token: swapRecoveryToken,
  };
}

function optionalCheckoutFields(body: Record<string, unknown>) {
  const memo = optionalString(body.memo);
  const descriptionHash = optionalString(body.description_hash ?? body.descriptionHash);
  const metadata = readRecord(body.metadata);
  const idempotencyKey = optionalString(body.idempotency_key ?? body.idempotencyKey);
  return {
    ...(memo === undefined ? {} : { memo }),
    ...(descriptionHash === undefined ? {} : { descriptionHash }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

function readAmount(value: unknown): CreateCheckoutAmount {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OpenReceiveHttpError(400, "INVALID_REQUEST", "amount is required.");
  }
  const amount = value as Record<string, unknown>;
  if (amount.sats !== undefined) {
    if (typeof amount.sats !== "string" && typeof amount.sats !== "number") {
      throw new OpenReceiveHttpError(400, "INVALID_REQUEST", "amount.sats is invalid.");
    }
    return { sats: amount.sats };
  }
  return {
    currency: requiredString(amount.currency, "amount.currency"),
    value: requiredString(amount.value, "amount.value"),
  };
}

function normalizeResolvedCheckout(
  value: CreateCheckoutAmount | ResolvedHostCheckout,
): ResolvedHostCheckout {
  if ("amount" in value) return value;
  return { amount: value };
}

async function recoverCommittedCheckout(
  runtime: Runtime,
  orderId: string,
  paymentHash: string,
  expiresAt?: number,
): Promise<Checkout> {
  const checkout = await runtime.service.recoverCheckout({
    orderId,
    paymentHash,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
  if (checkout !== null) return checkout;
  throw new OpenReceiveHttpError(
    409,
    "CONFLICT",
    "The host order has a payment hash that is not a reusable pending checkout.",
  );
}

async function recoverCommittedSwap(
  runtime: Runtime,
  orderId: string,
  resolved: ResolvedHostCheckout,
): Promise<SwapCheckout> {
  if (resolved.paymentHash === undefined || resolved.swapRecoveryToken === undefined) {
    throw new OpenReceiveHttpError(409, "CONFLICT", "The host order is missing its swap recovery token.");
  }
  const status = await runtime.service.getSwap({ recoveryToken: resolved.swapRecoveryToken });
  const checkout = await recoverCommittedCheckout(
    runtime,
    orderId,
    resolved.paymentHash,
    status.providerExpiresAt,
  );
  if (status.orderId !== orderId || status.paymentHash !== resolved.paymentHash.toLowerCase()) {
    throw new OpenReceiveHttpError(409, "CONFLICT", "The host swap recovery token does not match its payment hash.");
  }
  return { ...status, checkout };
}

function rejectPayerAmount(body: Record<string, unknown>): void {
  if (body.amount !== undefined || body.amount_msats !== undefined) {
    throw new OpenReceiveHttpError(
      400,
      "INVALID_REQUEST",
      "Checkout create does not accept a payer-supplied amount; the host resolves its order price.",
    );
  }
}

export function extractToken(request: Request): string | null {
  const authorization = request.headers.get("authorization")?.trim();
  const match = authorization === undefined ? null : /^bearer\s+(.+)$/i.exec(authorization);
  if (match?.[1]) return match[1].trim();
  const header = request.headers.get("x-openreceive-order-token")?.trim();
  if (header) return header;
  const cookie = request.headers.get("cookie");
  if (cookie !== null) {
    for (const part of cookie.split(";")) {
      const [name, ...value] = part.trim().split("=");
      if (name === ORDER_TOKEN_COOKIE_NAME) return value.join("=");
    }
  }
  return null;
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

function capabilityCookie(prefix: string, token: string, request: Request): string {
  return [
    `${ORDER_TOKEN_COOKIE_NAME}=${token}`,
    `Path=${prefix}`,
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=86400",
    ...(new URL(request.url).protocol === "https:" ? ["Secure"] : []),
  ].join("; ");
}

function requiredPaymentHash(value: unknown): string {
  const hash = requiredString(value, "payment_hash").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new OpenReceiveHttpError(400, "INVALID_REQUEST", "payment_hash must be 64 hexadecimal characters.");
  }
  return hash;
}

function requiredString(value: unknown, field: string): string {
  const result = optionalString(value);
  if (result === undefined) throw new OpenReceiveHttpError(400, "INVALID_REQUEST", `${field} is required.`);
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
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
    toSnakeCase(item),
  ]));
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

export { createDefaultAuthorize };
