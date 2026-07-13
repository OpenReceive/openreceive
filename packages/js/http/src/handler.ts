// Only TYPES are imported from @openreceive/node (erased at build): keeping value imports out means
// tsup never bundles node's runtime graph (pg/yaml/wallet SDKs) into this runtime-agnostic package.
import type {
  OpenReceive,
  CheckoutAmountSource,
  CreateCheckoutRequest,
  OrderStatus,
  SwapAttempt,
  SwapQuoteResponse,
} from "@openreceive/node";
import {
  createDefaultAuthorize,
  type OpenReceiveAuthorize,
  type OpenReceiveAuthorizeAction,
  type OpenReceiveAuthorizeResource,
  type OpenReceiveRateLimit,
} from "./authorize.ts";
import { createRequestId, errorResponse, jsonResponse, OpenReceiveHttpError } from "./errors.ts";
import type { PrepareCheckout, PrepareCheckoutResult } from "./prepare-checkout.ts";
import { createPreparedOrderStore, type PreparedOrderStore } from "./prepared-order-store.ts";
import { type MatchedRoute, matchRoute, normalizePrefix } from "./router.ts";
import {
  toHttpCheckout,
  toHttpOrderStatus,
  toHttpSwapAttempt,
  toHttpSwapOption,
} from "./serialize.ts";
import { createOrderAccessTokenManager, type OrderAccessTokenManager } from "./tokens.ts";

/**
 * Name of the httpOnly cookie the create route sets with the minted per-order token, and which
 * {@link extractToken} reads back on same-origin reads. Path-scoped to `{prefix}/orders/{orderId}`
 * so the browser only ever sends an order's own token to that order's read route.
 */
export const ORDER_TOKEN_COOKIE_NAME = "openreceive_order_token";

/** How long (seconds) the order-token cookie lives; matched to a typical checkout session window. */
const ORDER_TOKEN_COOKIE_MAX_AGE = 86400;

/**
 * Merge a host-resolved amount source with the base create request into a service-ready request.
 * Mirrors `applyOrderAmount` in @openreceive/node; inlined here to avoid a value import from node.
 */
function applyOrderAmount(
  base: Omit<CreateCheckoutRequest, "amount">,
  resolved: CheckoutAmountSource,
): CreateCheckoutRequest {
  return { ...base, amount: resolved.amount };
}

/** Options for {@link createOpenReceiveHttpHandler}. `service` and `prepareCheckout` are required. */
export interface CreateOpenReceiveHttpHandlerOptions {
  /** The host's already-constructed OpenReceive service (created with the host's DB + wallet). */
  readonly service: OpenReceive;
  /**
   * Host hook for POST /prepare. Validates the cart / looks up orders and returns the authoritative
   * amount (and optional summary). Required: create-checkout reads that amount from prepare persist
   * and never trusts a client-supplied price.
   */
  readonly prepareCheckout: PrepareCheckout;
  /** Host authorization policy. Defaults to the token-gated Tier policy (Tier 3 denied). */
  readonly authorize?: OpenReceiveAuthorize;
  /** Host rate-limit hook. When omitted, no rate limiting is applied. */
  readonly rateLimit?: OpenReceiveRateLimit;
  /** Capability-token manager. Defaults to one backed by `service.store` / `service.namespace`. */
  readonly tokens?: OrderAccessTokenManager;
  /** Mount prefix for all routes. Defaults to `/openreceive`. */
  readonly prefix?: string;
}

/** The framework-agnostic Fetch handler returned by {@link createOpenReceiveHttpHandler}. */
export interface OpenReceiveHttpHandler {
  (request: Request): Promise<Response>;
  /** The normalized mount prefix all routes live under. */
  readonly prefix: string;
  /** Alias for calling the handler directly. */
  handle(request: Request): Promise<Response>;
}

interface HandlerRuntime {
  readonly service: OpenReceive;
  readonly tokens: OrderAccessTokenManager;
  readonly authorize: OpenReceiveAuthorize;
  readonly rateLimit?: OpenReceiveRateLimit;
  readonly prepareCheckout: PrepareCheckout;
  readonly preparedOrders: PreparedOrderStore;
  readonly prefix: string;
}

const ORDER_ACTION_TO_AUTHORIZE: Record<string, OpenReceiveAuthorizeAction> = {
  status: "order.read",
  swap_quote: "swap.quote",
  start_swap: "swap.start",
  refund_swap: "swap.refund",
  refresh_swap: "swap.refresh",
};

/**
 * Build a Web-standard Fetch handler that serves the OpenReceive routes on top of a host-provided
 * `service`. The returned function is `(request: Request) => Promise<Response>` and also exposes
 * `.prefix` and a `.handle` alias.
 */
export function createOpenReceiveHttpHandler(
  options: CreateOpenReceiveHttpHandlerOptions,
): OpenReceiveHttpHandler {
  if (options === undefined || options.service === undefined) {
    throw new TypeError("createOpenReceiveHttpHandler requires a `service`.");
  }

  if (options.prepareCheckout === undefined) {
    throw new TypeError(
      "createOpenReceiveHttpHandler requires a `prepareCheckout` hook — POST /prepare is the " +
        "sole price authority; create-checkout never trusts a client-supplied price.",
    );
  }
  const prepareCheckout = options.prepareCheckout;

  const prefix = normalizePrefix(options.prefix ?? "/openreceive");
  const tokens =
    options.tokens ??
    createOrderAccessTokenManager(options.service.store, { namespace: options.service.namespace });
  const authorize = options.authorize ?? createDefaultAuthorize();
  const preparedOrders = createPreparedOrderStore(options.service.store);

  if (options.authorize === undefined) {
    console.warn(
      "OpenReceive: no authorize policy configured — Tier-3 admin routes (invoice.sweep) will always return 403.",
    );
  }

  const runtime: HandlerRuntime = {
    service: options.service,
    tokens,
    authorize,
    rateLimit: options.rateLimit,
    prepareCheckout,
    preparedOrders,
    prefix,
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
  Object.defineProperty(handler, "prefix", { value: prefix, enumerable: true });
  Object.defineProperty(handler, "handle", { value: handle, enumerable: true });
  return handler;
}

async function dispatch(
  runtime: HandlerRuntime,
  request: Request,
  requestId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const route = matchRoute(runtime.prefix, request.method, url.pathname);
  if (route === null) {
    throw new OpenReceiveHttpError(404, "NOT_FOUND", "No OpenReceive route matched this path.");
  }

  switch (route.kind) {
    case "checkout.prepare":
      return await handlePrepareCheckout(runtime, request, requestId);
    case "checkout.create":
      return await handleCreateCheckout(runtime, request, requestId);
    case "checkout.read":
      return await handleGetCheckout(runtime, request, route, requestId);
    case "order.action":
      return await handleOrderAction(runtime, request, route, requestId);
    case "order.summary":
      return await handleOrderSummary(runtime, request, route, requestId);
    case "swap.options":
      return await handleSwapOptions(runtime, request, route, requestId);
    case "rates":
      return await handleRates(runtime, request, url, requestId);
    case "invoice.sweep":
      return await handleSweep(runtime, request, requestId);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handlePrepareCheckout(
  runtime: HandlerRuntime,
  request: Request,
  requestId: string,
): Promise<Response> {
  const body = await readJsonBody(request);
  const token = extractToken(request);

  await guard(runtime, "checkout.prepare", request, {}, token);

  let prepared: PrepareCheckoutResult | null;
  try {
    prepared = await runtime.prepareCheckout({ body, request });
  } catch (error) {
    if (error instanceof OpenReceiveHttpError) throw error;
    const message = error instanceof Error ? error.message : "prepareCheckout rejected the request.";
    throw new OpenReceiveHttpError(400, "INVALID_REQUEST", message);
  }

  if (prepared === null) {
    throw new OpenReceiveHttpError(404, "NOT_FOUND", "Order not found.");
  }
  if (!isPrepareResult(prepared)) {
    throw new OpenReceiveHttpError(
      400,
      "INVALID_REQUEST",
      "prepareCheckout must return { amount: { sats } | { currency, value } } (or null for not found).",
    );
  }

  const orderId =
    typeof prepared.orderId === "string" && prepared.orderId.length > 0
      ? prepared.orderId
      : crypto.randomUUID();

  await runtime.preparedOrders.persist(orderId, {
    amount: prepared.amount,
    ...(prepared.summary === undefined ? {} : { summary: prepared.summary }),
    ...(prepared.metadata === undefined ? {} : { metadata: prepared.metadata }),
  });

  return jsonResponse(
    201,
    {
      order_id: orderId,
      ...(prepared.summary === undefined ? {} : { summary: prepared.summary }),
    },
    requestId,
  );
}

async function handleCreateCheckout(
  runtime: HandlerRuntime,
  request: Request,
  requestId: string,
): Promise<Response> {
  const body = await readJsonBody(request);
  const orderId = readOrderId(body);
  const token = extractToken(request);

  await guard(runtime, "checkout.create", request, { order_id: orderId }, token);

  // Client prices are never trusted on this route. `amount` is rejected so a tampered
  // client cannot quietly underpay; tip-jar / donation hosts honor a payer-chosen amount inside
  // prepareCheckout (typically via the prepare body) and persist it explicitly.
  rejectClientAmountFields(body);

  const stored = await runtime.preparedOrders.read(orderId);
  if (stored === null) {
    throw new OpenReceiveHttpError(404, "NOT_FOUND", "Order not found.");
  }
  const resolved: CheckoutAmountSource = {
    amount: stored.amount as CheckoutAmountSource["amount"],
  };

  const metadata = readMetadata(body);
  const memo = readString(body.memo);
  const descriptionHash = readString(body.description_hash ?? body.descriptionHash);
  const mintLightning = body.mint_lightning === false || body.mintLightning === false ? false : true;
  const base = {
    orderId,
    mintLightning,
    ...(memo === undefined ? {} : { memo }),
    ...(descriptionHash === undefined ? {} : { descriptionHash }),
    ...(metadata === undefined ? {} : { metadata }),
  } satisfies Omit<CreateCheckoutRequest, "amount">;

  const createRequest = applyOrderAmount(base, resolved);
  const checkout = toHttpCheckout(await runtime.service.getOrCreateCheckout(createRequest));

  // Mint the per-order capability token. It is only returned on the first checkout for an order;
  // later checkouts replay the same order and get no token (`created: false`).
  const minted = await runtime.tokens.mint(orderId);
  if (minted.created && minted.token !== undefined) {
    // On the mint, also drop the token as an httpOnly cookie scoped to this order's read route, so a
    // same-origin browser is auto-authorized for its own order with no client-side token handling.
    const cookie = buildOrderTokenCookie(runtime.prefix, orderId, minted.token, request);
    return jsonResponse(201, { checkout, order_access_token: minted.token }, requestId, [
      ["set-cookie", cookie],
    ]);
  }

  return jsonResponse(201, { checkout }, requestId);
}

async function handleOrderSummary(
  runtime: HandlerRuntime,
  request: Request,
  route: Extract<MatchedRoute, { kind: "order.summary" }>,
  requestId: string,
): Promise<Response> {
  const token = extractToken(request);
  const orderId = route.orderId;
  await guard(runtime, "order.summary", request, { order_id: orderId }, token);

  const stored = await runtime.preparedOrders.read(orderId);
  if (stored === null) {
    throw new OpenReceiveHttpError(404, "NOT_FOUND", "Order not found.");
  }

  return jsonResponse(
    200,
    {
      order_id: orderId,
      ...(stored.summary === undefined ? {} : { summary: stored.summary }),
    },
    requestId,
  );
}

/**
 * Build the `Set-Cookie` value for the minted order token: httpOnly + SameSite=Lax, path-scoped to
 * `{prefix}/orders/{orderId}` so the browser only sends it to that order's read route, and `Secure`
 * only over https (so localhost http dev keeps working).
 */
function buildOrderTokenCookie(
  prefix: string,
  orderId: string,
  token: string,
  request: Request,
): string {
  const path = `${prefix}/orders/${encodeURIComponent(orderId)}`;
  const attributes = [
    `${ORDER_TOKEN_COOKIE_NAME}=${token}`,
    `Path=${path}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${ORDER_TOKEN_COOKIE_MAX_AGE}`,
  ];
  if (isHttpsRequest(request)) {
    attributes.push("Secure");
  }
  return attributes.join("; ");
}

/** True when the request arrived over https, directly or via an `x-forwarded-proto: https` proxy. */
function isHttpsRequest(request: Request): boolean {
  return (
    new URL(request.url).protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https"
  );
}

async function handleGetCheckout(
  runtime: HandlerRuntime,
  request: Request,
  route: Extract<MatchedRoute, { kind: "checkout.read" }>,
  requestId: string,
): Promise<Response> {
  const token = extractToken(request);
  const checkoutId = route.checkoutId;

  // Rate-limit before touching the service. The order id needed to authorize is not known until the
  // checkout is fetched, so authorize is applied after the lookup (below) rather than via `guard`.
  // tokenValid is still unknown here (no order id yet), so it is false for the rate-limit context.
  await enforceRateLimit(
    runtime,
    "checkout.read",
    request,
    { checkout_id: checkoutId },
    token,
    false,
  );

  // Fetch first to learn the owning order id for the default token gate (404 if the checkout is
  // unknown). A denied authorize returns 403 without leaking the fetched checkout body.
  const checkout = await runtime.service.getCheckout({ checkoutId });
  const resource: OpenReceiveAuthorizeResource = {
    checkout_id: checkoutId,
    order_id: checkout.orderId,
  };
  const tokenValid = await computeTokenValid(runtime, resource, token);
  const allowed = await runtime.authorize({
    action: "checkout.read",
    request,
    resource,
    token,
    tokenValid,
  });
  if (!allowed) {
    throw new OpenReceiveHttpError(403, "UNAUTHORIZED", "Not authorized to read this checkout.");
  }

  return jsonResponse(200, toHttpCheckout(checkout), requestId);
}

async function handleOrderAction(
  runtime: HandlerRuntime,
  request: Request,
  route: Extract<MatchedRoute, { kind: "order.action" }>,
  requestId: string,
): Promise<Response> {
  const body = await readJsonBody(request);
  const orderId = route.orderId;
  const action = body.action === undefined ? "status" : body.action;
  if (typeof action !== "string" || !(action in ORDER_ACTION_TO_AUTHORIZE)) {
    // Unknown action fails loud with a 400 and is never silently treated as `status`. Rejected
    // before the service is called (and before authorize, since there is no valid action to gate).
    throw new OpenReceiveHttpError(
      400,
      "INVALID_REQUEST",
      `Unknown order action: ${JSON.stringify(action)}. Expected "status", "swap_quote", "start_swap", "refund_swap", or "refresh_swap".`,
    );
  }
  const authorizeAction = ORDER_ACTION_TO_AUTHORIZE[action];

  const token = extractToken(request);
  const resource: OpenReceiveAuthorizeResource = { order_id: orderId };
  if (
    (action === "refund_swap" || action === "refresh_swap") &&
    typeof body.attempt_id === "string"
  ) {
    resource.attempt_id = body.attempt_id;
  }

  await guard(runtime, authorizeAction, request, resource, token);

  // Path order id is authoritative. Call the typed camelCase service methods directly —
  // there is no parallel snake_case `order()` dispatcher on the SDK.
  if (action === "status") {
    const order = await runtime.service.getOrder({ orderId });
    const swap = await runtime.service.swapOptions({ orderId });
    const status: OrderStatus = {
      ...order,
      swapsEnabled: swap.enabled,
      swapPayOptions: swap.enabled ? swap.options : [],
    };
    return jsonResponse(200, toHttpOrderStatus(status), requestId);
  }

  if (action === "swap_quote") {
    const payInAsset = requiredString(body.pay_in_asset, "pay_in_asset");
    const quote: SwapQuoteResponse = await runtime.service.swapQuote({ orderId, payInAsset });
    return jsonResponse(200, { quote: toHttpSwapOption(quote) }, requestId);
  }

  if (action === "start_swap") {
    const payInAsset = requiredString(body.pay_in_asset, "pay_in_asset");
    const attempt: SwapAttempt = await runtime.service.startSwap({ orderId, payInAsset });
    return jsonResponse(200, { attempt: toHttpSwapAttempt(attempt) }, requestId);
  }

  if (action === "refresh_swap") {
    const attemptId = requiredString(body.attempt_id, "attempt_id");
    const attempt: SwapAttempt = await runtime.service.refreshSwap({ attemptId });
    return jsonResponse(200, { attempt: toHttpSwapAttempt(attempt) }, requestId);
  }

  // refund_swap
  const attemptId = requiredString(body.attempt_id, "attempt_id");
  const refundAddress = requiredString(body.refund_address, "refund_address");
  const refundNonce = requiredString(body.refund_nonce, "refund_nonce");
  const attempt: SwapAttempt = await runtime.service.refundSwap({
    attemptId,
    refundAddress,
    refundNonce,
    confirm: body.confirm === true,
  });
  return jsonResponse(200, { attempt: toHttpSwapAttempt(attempt) }, requestId);
}

async function handleSwapOptions(
  runtime: HandlerRuntime,
  request: Request,
  route: Extract<MatchedRoute, { kind: "swap.options" }>,
  requestId: string,
): Promise<Response> {
  const token = extractToken(request);
  await guard(runtime, "swap.options", request, { order_id: route.orderId }, token);
  const result = await runtime.service.swapOptions({ orderId: route.orderId });
  return jsonResponse(
    200,
    {
      enabled: result.enabled,
      options: result.options.map(toHttpSwapOption),
    },
    requestId,
  );
}

async function handleRates(
  runtime: HandlerRuntime,
  _request: Request,
  url: URL,
  requestId: string,
): Promise<Response> {
  // Public Tier-1 read: no authorize / rate-limit gate. `base` is accepted for wire parity but only
  // Bitcoin is supported as the base asset, so it is not forwarded.
  const currenciesParam = url.searchParams.get("currencies");
  const currencies =
    currenciesParam === null
      ? undefined
      : currenciesParam
          .split(",")
          .map((currency) => currency.trim())
          .filter((currency) => currency.length > 0);

  const rates = await runtime.service.listRates(
    currencies === undefined ? undefined : { currencies },
  );
  return jsonResponse(200, rates, requestId);
}

async function handleSweep(
  runtime: HandlerRuntime,
  request: Request,
  requestId: string,
): Promise<Response> {
  // Tier-3 admin, fails closed: the default policy denies invoice.sweep, so a host must opt in with
  // its own `authorize` for this to reach the service.
  const token = extractToken(request);
  await guard(runtime, "invoice.sweep", request, {}, token);
  const result = await runtime.service.sweepPendingInvoices();
  return jsonResponse(200, result, requestId);
}

// ---------------------------------------------------------------------------
// Guards + parsing
// ---------------------------------------------------------------------------

async function guard(
  runtime: HandlerRuntime,
  action: OpenReceiveAuthorizeAction,
  request: Request,
  resource: OpenReceiveAuthorizeResource,
  token: string | null,
): Promise<void> {
  // Precompute token validity once so both rate-limit and authorize see the same `ctx.tokenValid`,
  // and policies never have to reach for the token manager themselves.
  const tokenValid = await computeTokenValid(runtime, resource, token);
  await enforceRateLimit(runtime, action, request, resource, token, tokenValid);
  const allowed = await runtime.authorize({ action, request, resource, token, tokenValid });
  if (!allowed) {
    throw new OpenReceiveHttpError(403, "UNAUTHORIZED", "Not authorized for this action.");
  }
}

/** Verify the presented token against the resource's order, or false when either is absent. */
async function computeTokenValid(
  runtime: HandlerRuntime,
  resource: OpenReceiveAuthorizeResource,
  token: string | null,
): Promise<boolean> {
  return resource.order_id && token ? await runtime.tokens.verify(resource.order_id, token) : false;
}

async function enforceRateLimit(
  runtime: HandlerRuntime,
  action: OpenReceiveAuthorizeAction,
  request: Request,
  resource: OpenReceiveAuthorizeResource,
  token: string | null,
  tokenValid: boolean,
): Promise<void> {
  if (runtime.rateLimit === undefined) return;
  const allowed = await runtime.rateLimit({ action, request, resource, token, tokenValid });
  if (!allowed) {
    throw new OpenReceiveHttpError(429, "RATE_LIMITED", "Too many requests.", { retryable: true });
  }
}

/**
 * Prefer `Authorization: Bearer <t>` (scheme case-insensitive), then `X-OpenReceive-Order-Token`,
 * then the path-scoped `openreceive_order_token` cookie. A header token always wins over the cookie;
 * because the cookie is scoped to `{prefix}/orders/{orderId}`, the value the browser sends to that
 * read route is exactly that order's token.
 */
export function extractToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = /^bearer\s+(.+)$/i.exec(authorization.trim());
    if (match !== null && match[1].trim().length > 0) {
      return match[1].trim();
    }
  }
  const header = request.headers.get("x-openreceive-order-token");
  if (header !== null && header.trim().length > 0) {
    return header.trim();
  }
  const cookieHeader = request.headers.get("cookie");
  if (cookieHeader !== null) {
    const cookieToken = readCookie(cookieHeader, ORDER_TOKEN_COOKIE_NAME);
    if (cookieToken !== undefined && cookieToken.length > 0) {
      return cookieToken;
    }
  }
  return null;
}

/** Read a single cookie value by name from a `Cookie` request header (`name=value; name2=value2`). */
function readCookie(header: string, name: string): string | undefined {
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new OpenReceiveHttpError(400, "INVALID_REQUEST", "Unable to read request body.");
  }
  if (text.trim().length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OpenReceiveHttpError(400, "INVALID_REQUEST", "Request body must be valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OpenReceiveHttpError(400, "INVALID_REQUEST", "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function readOrderId(body: Record<string, unknown>): string {
  const orderId = readString(body.order_id ?? body.orderId);
  if (orderId === undefined) {
    throw new OpenReceiveHttpError(400, "INVALID_REQUEST", "order_id is required.");
  }
  return orderId;
}

/** Fail loud when a client tries to set the price on the create-checkout route. */
function rejectClientAmountFields(body: Record<string, unknown>): void {
  for (const key of ["amount", "sats", "usd"] as const) {
    if (body[key] !== undefined) {
      throw new OpenReceiveHttpError(
        400,
        "INVALID_REQUEST",
        `Create checkout does not accept client-supplied '${key}'. Provide the price via prepareCheckout.`,
      );
    }
  }
}

function isPrepareResult(value: unknown): value is {
  amount: CheckoutAmountSource["amount"];
  orderId?: string;
  summary?: unknown;
  metadata?: Record<string, unknown>;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!("amount" in record) || record.amount === null || typeof record.amount !== "object") {
    return false;
  }
  const amount = record.amount as Record<string, unknown>;
  const hasSats = "sats" in amount;
  const hasCurrencyValue = "currency" in amount && "value" in amount;
  return (hasSats && !hasCurrencyValue) || (!hasSats && hasCurrencyValue);
}

function readMetadata(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const metadata = body.metadata;
  if (metadata === undefined) return undefined;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new OpenReceiveHttpError(400, "INVALID_REQUEST", "metadata must be a JSON object.");
  }
  return metadata as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(value: unknown, field: string): string {
  const text = readString(value);
  if (text === undefined) {
    throw new OpenReceiveHttpError(400, "INVALID_REQUEST", `${field} is required.`);
  }
  return text;
}
