import type { PaymentDetails } from "@openreceive/core";
import type {
  CheckoutInvoice,
  CreateCheckoutAmount,
  OpenReceive,
  PaymentCheck,
  SwapCheckout,
  SwapData,
} from "@openreceive/node";
import type { OpenReceiveHost } from "./host-payments.ts";
import {
  maybeReconcileOpenReceivePayments,
  type OpenReceiveOpportunisticReconcileResult,
} from "./reconcile-gate.ts";
import type {
  OpenReceiveAuthorize,
  OpenReceiveAuthorizeAction,
  OpenReceiveAuthorizeResource,
  OpenReceiveRateLimit,
} from "./authorize.ts";
import {
  bigintToJsonNumber,
  createRequestId,
  errorResponse,
  isServiceErrorShape,
  jsonResponse,
  OpenReceiveHttpError,
} from "./errors.ts";
import {
  createOpenReceiveIpRateLimit,
  openReceiveClientIp,
  openReceiveClientIpBucket,
  type OpenReceiveIpRateLimitConfig,
} from "./rate-limit.ts";
import { matchRoute, normalizePrefix } from "./router.ts";

export interface CheckoutCreatedInput {
  readonly orderId: string;
  readonly paymentHash: string;
  readonly checkout: CheckoutInvoice;
  /** Sensitive server-only provider state. Persist it on the payment attempt; never send it to a browser. */
  readonly swapData?: SwapData;
  /**
   * Client IP the adapter attributed to this request, stored on the attempt row.
   * Backs the opt-in `rateLimiting` option; absent when no IP was attributable.
   */
  readonly clientIp?: string;
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
  readonly checkout?: CheckoutInvoice;
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
  /**
   * Built-in per-IP invoice rate limiting. OFF by default: shared-IP deployments
   * (point-of-sale terminals, kiosks, NAT'd venues) mint many invoices from one
   * address and must never be blocked by an accidental default. Recommended for
   * public web shops: `rateLimiting: true` caps invoice creation at 60 per IP per
   * rolling hour, counted from `openreceive_payments` rows by `client_ip` — limits
   * survive restarts and span instances sharing the database. Requires a repository
   * that can count (the built-in SQL repository does); construction throws otherwise
   * rather than degrading to per-process memory. Applies only when a new attempt
   * would be minted — reuse of a committed attempt is never throttled — and fails
   * open per-request when no client IP is attributable. Pass a config object to
   * tune limits or the payer-facing message. Mutually exclusive with a custom
   * `rateLimit` hook.
   */
  readonly rateLimiting?: boolean | OpenReceiveIpRateLimitConfig;
  /**
   * Opportunistic settlement discovery, ON by default: every mounted route
   * (including unauthenticated `GET /rates`) first runs one durably gated
   * reconcile pass when payment attempts are pending, so abandoned checkouts
   * settle on any later OpenReceive call with no long-running process. The
   * durable `openreceive_meta` gate (min 2s, stretched by invoice age) is
   * shared by every worker on the host database, so rapid calls collapse to
   * one real wallet scan per interval; `payments/check` serves the requested
   * hash from that same pass — one gate claim per request, never a second
   * per-invoice wallet walk. Requires `payments.claimReconcileGate` (the
   * built-in SQL repository has it); construction throws otherwise rather
   * than degrading silently. Pass `false` to disable (e.g. when a dedicated
   * notifications worker owns scanning) or `{ minIntervalSeconds }` to tune.
   */
  readonly opportunisticReconcile?: boolean | { readonly minIntervalSeconds?: number };
  /** Clock override (unix seconds) for the opportunistic reconcile gate. */
  readonly clock?: () => number;
  readonly prefix?: string;
}

export interface OpenReceiveHttpHandler {
  (request: Request, extras?: { native?: unknown }): Promise<Response>;
  readonly prefix: string;
  handle(request: Request, extras?: { native?: unknown }): Promise<Response>;
}

interface Runtime extends CreateOpenReceiveHttpHandlerOptions {
  readonly prefix: string;
  /** Single client-IP resolution used for BOTH row stamping and limit counting. */
  readonly extractClientIp: (context: {
    readonly action: OpenReceiveAuthorizeAction;
    readonly request: Request;
    readonly resource: OpenReceiveAuthorizeResource;
    readonly native?: unknown;
  }) => string | undefined;
  /** Resolved opportunistic-reconcile tuning; undefined means disabled. */
  readonly reconcile: { readonly minIntervalSeconds?: number } | undefined;
}

export function createOpenReceiveHttpHandler(
  options: CreateOpenReceiveHttpHandlerOptions,
): OpenReceiveHttpHandler {
  if (options?.service === undefined) throw new TypeError("HTTP handler requires service.");
  if (options.authorize === undefined) {
    throw new TypeError("HTTP handler requires authorize; authentication belongs to the host.");
  }
  if (options.host === undefined) throw new TypeError("HTTP handler requires host.");
  // rateLimiting: false means disabled, so it composes with a custom rateLimit hook.
  if (
    options.rateLimiting !== undefined &&
    options.rateLimiting !== false &&
    options.rateLimit !== undefined
  ) {
    throw new TypeError("Pass either rateLimiting or a custom rateLimit hook, not both.");
  }
  const rateLimit = options.rateLimit ?? resolveRateLimiting(options);
  // Opportunistic reconcile is the default settlement path; it needs the
  // durable CAS gate, so a custom repository without one must opt out
  // explicitly rather than silently degrade (same idiom as rateLimiting).
  const reconcile =
    options.opportunisticReconcile === false
      ? undefined
      : typeof options.opportunisticReconcile === "object"
        ? options.opportunisticReconcile
        : {};
  if (reconcile !== undefined && typeof options.host.payments.claimReconcileGate !== "function") {
    throw new TypeError(
      "Opportunistic reconcile (on by default) requires payments.claimReconcileGate — a durable " +
        "compare-and-set gate shared by every worker (the built-in SQL repository implements it " +
        "over openreceive_meta). Implement it on the custom repository, or pass " +
        "opportunisticReconcile: false and run your own settlement worker.",
    );
  }
  // The IP that gets stored on committed rows must be the same value the
  // limiter counts with: one resolved extractor (custom `ip` or the adapter
  // default), normalized into the same bucket the limiter uses (IPv6 /64,
  // v4-mapped collapsed).
  const rawExtractClientIp =
    (typeof options.rateLimiting === "object" ? options.rateLimiting.ip : undefined) ??
    openReceiveClientIp;
  const extractClientIp: Runtime["extractClientIp"] = (context) => {
    const ip = rawExtractClientIp(context);
    return ip === undefined || ip.length === 0 ? undefined : openReceiveClientIpBucket(ip);
  };
  const runtime: Runtime = {
    ...options,
    ...(rateLimit === undefined ? {} : { rateLimit }),
    extractClientIp,
    reconcile,
    prefix: normalizePrefix(options.prefix ?? "/openreceive"),
  };
  const handle = async (request: Request, extras?: { native?: unknown }): Promise<Response> => {
    const requestId = createRequestId();
    try {
      return await dispatch(runtime, request, requestId, extras?.native);
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

async function dispatch(
  runtime: Runtime,
  request: Request,
  requestId: string,
  native?: unknown,
): Promise<Response> {
  const url = new URL(request.url);
  const route = matchRoute(runtime.prefix, request.method, url.pathname);
  if (route === null)
    throw new OpenReceiveHttpError(
      404,
      "NOT_FOUND",
      "No OpenReceive route matched this method and path.",
    );

  // Any OpenReceive call is a settlement trigger: after the route matches and
  // before its own work, run one durably gated reconcile pass (never throws;
  // a failed scan must not fail this request). `payments/check` consumes this
  // pass result below — exactly one gate claim per request.
  const reconcilePass: OpenReceiveOpportunisticReconcileResult | undefined =
    runtime.reconcile === undefined
      ? undefined
      : await maybeReconcileOpenReceivePayments({
          service: runtime.service,
          host: runtime.host,
          ...(runtime.reconcile.minIntervalSeconds === undefined
            ? {}
            : { minIntervalSeconds: runtime.reconcile.minIntervalSeconds }),
          ...(runtime.clock === undefined ? {} : { clock: runtime.clock }),
        });

  if (route.kind === "rates") {
    const currencies = ratesCurrencies(url.searchParams.get("currencies"));
    return jsonResponse(
      200,
      await runtime.service.listRates(currencies === undefined ? undefined : { currencies }),
      requestId,
    );
  }

  const body = await readJsonBody(request);
  // Before the generic field whitelist, so a payer pricing attempt is refused
  // by name instead of as an unexpected field.
  rejectPayerAmount(body);
  assertDeclaredFields(route.kind, body);
  const orderId = requiredString(body.order_id, "order_id", MAX_ORDER_ID_LENGTH);

  if (route.kind === "checkout.prepare") {
    await guard(runtime, "checkout.prepare", request, { order_id: orderId }, native);
    const resolved = await resolveHost(runtime, "checkout.prepare", request, orderId, body);
    const prepared = await runtime.service.prepareCheckout({
      amount: requiredAmount(resolved),
    });
    const swapOptions = await runtime.service.listSwapOptions({
      amountMsats: prepared.amountMsats,
    });
    return jsonResponse(
      200,
      {
        order_id: orderId,
        amount_msats: prepared.amountMsats,
        fiat_quote: prepared.fiatQuote === null ? null : toSnakeCase(prepared.fiatQuote),
        payment_methods: toSnakeCase(swapOptions.options),
      },
      requestId,
    );
  }

  if (route.kind === "checkout.create") {
    await enforceAuthorize(runtime, "checkout.create", request, { order_id: orderId }, native);
    const resolved = await resolveHost(runtime, "checkout.create", request, orderId, body);
    // Rate limits meter minting only: re-serving the order's already-committed
    // attempt costs no wallet call and no row, so a capped payer can still
    // re-fetch instructions they were already given.
    if (resolved.paymentHash === undefined) {
      await enforceRateLimit(runtime, "checkout.create", request, { order_id: orderId }, native);
    }
    const checkout =
      resolved.paymentHash === undefined
        ? await runtime.service.createCheckout({
            orderId,
            amount: requiredAmount(resolved),
            ...optionalCheckoutFields(body),
          })
        : committedCheckout(orderId, resolved);
    if (resolved.paymentHash === undefined) {
      const clientIp = runtime.extractClientIp({
        action: "checkout.create",
        request,
        resource: { order_id: orderId },
        native,
      });
      await commit(runtime, {
        orderId,
        paymentHash: checkout.paymentHash,
        checkout,
        ...(clientIp === undefined ? {} : { clientIp }),
      });
    }
    return jsonResponse(201, { checkout: httpCheckout(checkout) }, requestId);
  }

  if (route.kind === "payment.check") {
    const requestedPaymentHash = requiredPaymentHash(
      requiredString(body.payment_hash, "payment_hash"),
    );
    await guard(
      runtime,
      "payment.check",
      request,
      { order_id: orderId, payment_hash: requestedPaymentHash },
      native,
    );
    const resolved = await resolveHost(runtime, "payment.check", request, orderId, body);
    const paymentHash = selectedPaymentHash(resolved, requestedPaymentHash);
    // Status refresh never adds its own per-invoice wallet walk: the requested
    // hash is served from the dispatch-level gated pass when this request won
    // the gate, and from the host row otherwise (`gate_busy`, a hash outside
    // the pending set, or opportunistic reconcile disabled). One gate claim
    // per request; open tabs polling every ~3s share the one global scan.
    const fromPass =
      reconcilePass !== undefined && reconcilePass.reason === "ran"
        ? reconcilePass.checks.find(
            (check) => check.paymentHash.toLowerCase() === paymentHash.toLowerCase(),
          )
        : undefined;
    // A scan that did not see the invoice reports `not_found`; wallets that
    // ignore `unpaid: true` do that for every live invoice. The committed row
    // is the durable truth, so serving it keeps the status from flapping
    // between the request that won the gate and the ones that did not (the
    // pass has already recorded any terminal transition on that row).
    const checkedBody =
      fromPass !== undefined && fromPass.status !== "not_found"
        ? passCheckedBody(fromPass)
        : await rowCheckedBody(runtime, orderId, paymentHash);
    // Catalog warms on the first check; clients keep "Loading currencies…" until
    // payment_methods is present (even as an empty Lightning-only list).
    const checkout = requiredCheckout(resolved);
    const swapOptions = await runtime.service.listSwapOptions({
      amountMsats: checkout.amountMsats,
    });
    return jsonResponse(
      200,
      {
        ...checkedBody,
        payment_methods: toSnakeCase(swapOptions.options),
      },
      requestId,
    );
  }

  if (route.kind === "swap.quote") {
    const payInAsset = requiredString(body.pay_in_asset, "pay_in_asset");
    await guard(runtime, "swap.quote", request, { order_id: orderId }, native);
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
    const payInAsset = requiredString(body.pay_in_asset, "pay_in_asset");
    await enforceAuthorize(runtime, "swap.create", request, { order_id: orderId }, native);
    const resolved = await resolveHost(runtime, "swap.create", request, orderId, body, payInAsset);
    if (resolved.paymentHash === undefined) {
      await enforceRateLimit(runtime, "swap.create", request, { order_id: orderId }, native);
    }
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
      const clientIp = runtime.extractClientIp({
        action: "swap.create",
        request,
        resource: { order_id: orderId },
        native,
      });
      await commit(runtime, {
        orderId,
        paymentHash: swap.paymentHash,
        checkout: swap.checkout,
        swapData: swap.swapData,
        ...(clientIp === undefined ? {} : { clientIp }),
      });
    }
    return jsonResponse(201, { swap: httpSwap(swap) }, requestId);
  }

  const action: OpenReceiveAuthorizeAction =
    route.kind === "swap.read" ? "swap.read" : "swap.refund";
  const requestedPaymentHash = requiredPaymentHash(
    requiredString(body.payment_hash, "payment_hash"),
  );
  await guard(
    runtime,
    action,
    request,
    { order_id: orderId, payment_hash: requestedPaymentHash },
    native,
  );
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
  const refundAddress = requiredString(body.refund_address, "refund_address");
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

/**
 * Turn the `rateLimiting` option into the runtime `rateLimit` hook. `undefined`/`false`
 * disable it (the default). Counting is repository-backed and mandatory: every minted
 * invoice is already a row carrying `client_ip`, so the limit is a COUNT over rows the
 * host stores anyway and survives restarts / spans instances sharing the database. A
 * repository without `countAttemptsFromIp` (and no custom counter in the config) fails
 * handler construction instead of silently falling back to process-local memory.
 */
function resolveRateLimiting(
  options: CreateOpenReceiveHttpHandlerOptions,
): OpenReceiveRateLimit | undefined {
  if (options.rateLimiting === undefined || options.rateLimiting === false) return undefined;
  const config = options.rateLimiting === true ? {} : options.rateLimiting;
  const payments = options.host.payments;
  const countAttemptsFromIp =
    config.countAttemptsFromIp ?? payments.countAttemptsFromIp?.bind(payments);
  return createOpenReceiveIpRateLimit({
    ...config,
    ...(countAttemptsFromIp === undefined ? {} : { countAttemptsFromIp }),
  });
}

async function guard(
  runtime: Runtime,
  action: OpenReceiveAuthorizeAction,
  request: Request,
  resource: OpenReceiveAuthorizeResource,
  native?: unknown,
): Promise<void> {
  await enforceRateLimit(runtime, action, request, resource, native);
  await enforceAuthorize(runtime, action, request, resource, native);
}

// Create actions call these separately: authorize first, then the rate limit only
// once the host has resolved whether a new attempt must be minted (reuse is exempt).
async function enforceRateLimit(
  runtime: Runtime,
  action: OpenReceiveAuthorizeAction,
  request: Request,
  resource: OpenReceiveAuthorizeResource,
  native?: unknown,
): Promise<void> {
  if (runtime.rateLimit === undefined) return;
  if (!(await runtime.rateLimit({ action, request, resource, native }))) {
    throw new OpenReceiveHttpError(429, "RATE_LIMITED", "Too many requests.", {
      retryable: true,
      retryAfterSeconds: 60,
    });
  }
}

async function enforceAuthorize(
  runtime: Runtime,
  action: OpenReceiveAuthorizeAction,
  request: Request,
  resource: OpenReceiveAuthorizeResource,
  native?: unknown,
): Promise<void> {
  if (!(await runtime.authorize({ action, request, resource, native }))) {
    throw new OpenReceiveHttpError(403, "UNAUTHORIZED", "Not authorized for this action.");
  }
}

async function commit(runtime: Runtime, input: CheckoutCreatedInput): Promise<void> {
  try {
    await runtime.host.onCheckoutCreated(input);
  } catch (error) {
    // Meaningful repository refusals ("already paid", "live attempt for the
    // same method") keep their own status and message.
    if (error instanceof OpenReceiveHttpError || isServiceErrorShape(error)) throw error;
    // Anything else is infrastructure failing to persist (database down, bug):
    // retryable 503, never a payer-blaming conflict.
    throw new OpenReceiveHttpError(
      503,
      "INTERNAL",
      "The host could not persist this payment attempt; payer instructions were withheld. Please retry.",
      { retryable: true },
    );
  }
}

/** `payments/check` body for the request that won the gate: straight from the pass. */
function passCheckedBody(checked: PaymentCheck): Record<string, unknown> {
  const { details, ...checkedPublic } = checked;
  return {
    ...(toSnakeCase(checkedPublic) as Record<string, unknown>),
    ...(details === undefined ? {} : { details: publicPaymentDetails(details) }),
  };
}

/**
 * `payments/check` body from the host row (`gate_busy`, a hash outside the
 * pending set, or opportunistic reconcile disabled). Row `attention` serves as
 * `pending` on the wire — it is operator state, not payer information — and
 * the row path never emits `not_found`. `details` stays contract-optional:
 * there is no persisted wallet snapshot, only the pass provides it.
 */
async function rowCheckedBody(
  runtime: Runtime,
  orderId: string,
  paymentHash: string,
): Promise<Record<string, unknown>> {
  const rows = await runtime.host.payments.listForOrder(orderId);
  const record = rows.find((row) => row.paymentHash.toLowerCase() === paymentHash.toLowerCase());
  if (record === undefined) {
    // resolveHost selected this hash from the same repository moments ago.
    throw new OpenReceiveHttpError(404, "NOT_FOUND", "Payment attempt not found for this order.");
  }
  return {
    payment_hash: record.paymentHash.toLowerCase(),
    status: record.status === "attention" ? "pending" : record.status,
    ...(record.paidAt === null ? {} : { paid_at: record.paidAt }),
  };
}

function httpCheckout(checkout: CheckoutInvoice): Record<string, unknown> {
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

// Payer-supplied description_hash is deliberately NOT accepted: it would let any
// client make the merchant's wallet mint an invoice committing to arbitrary
// content. Hosts minting hash-committed invoices do so server-side via the service.
function optionalCheckoutFields(body: Record<string, unknown>) {
  const memo = optionalString(body.memo);
  if (memo !== undefined && memo.length > MAX_MEMO_LENGTH) {
    throw new OpenReceiveHttpError(
      400,
      "INVALID_REQUEST",
      `memo must be ${MAX_MEMO_LENGTH} characters or fewer.`,
    );
  }
  const metadata = readRecord(body.metadata);
  return {
    ...(memo === undefined ? {} : { memo }),
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
  if (value.amount === undefined || value.amount === null) {
    throw new OpenReceiveHttpError(
      500,
      "INTERNAL",
      "The host resolved this order without an amount.",
    );
  }
  return value.amount;
}

function requiredCheckout(value: ResolvedHostCheckout): CheckoutInvoice {
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

function committedCheckout(orderId: string, resolved: ResolvedHostCheckout): CheckoutInvoice {
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

/** Spec-declared length caps (openreceive-http.v1.yaml request schemas). */
const MAX_ORDER_ID_LENGTH = 200;
const MAX_MEMO_LENGTH = 500;

/**
 * Contract bodies are tiny (ids, an asset name, a short memo, small metadata),
 * so anything beyond this cap is rejected before authorize runs — the plain
 * handler must not buffer unbounded pre-auth input.
 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * The declared fields per route, mirroring the OpenAPI request schemas
 * (`additionalProperties: false`). The wire contract is snake_case only;
 * camelCase aliases and undeclared selectors are rejected, not ignored,
 * so clients cannot come to depend on off-contract behavior.
 */
const ROUTE_BODY_FIELDS: Record<string, readonly string[]> = {
  "checkout.prepare": ["order_id"],
  "checkout.create": ["order_id", "memo", "metadata"],
  "payment.check": ["order_id", "payment_hash"],
  "swap.quote": ["order_id", "pay_in_asset"],
  "swap.create": ["order_id", "pay_in_asset", "memo", "metadata"],
  "swap.read": ["order_id", "payment_hash"],
  "swap.refund": ["order_id", "payment_hash", "refund_address"],
};

function assertDeclaredFields(routeKind: string, body: Record<string, unknown>): void {
  const allowed = ROUTE_BODY_FIELDS[routeKind];
  if (allowed === undefined) return;
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new OpenReceiveHttpError(
        400,
        "INVALID_REQUEST",
        `Unexpected request field for this route: ${key}.`,
      );
    }
  }
}

/**
 * Payer-facing subset of a settlement's wallet details. The raw NwcTransaction
 * carries the preimage, full invoice, and wallet metadata — none of which belong
 * in a browser-polled response.
 */
function publicPaymentDetails(details: PaymentDetails): Record<string, unknown> {
  const transaction = details.transaction as Record<string, unknown> | undefined;
  const pick = (keys: readonly string[]): Record<string, unknown> =>
    Object.fromEntries(
      keys.flatMap((key) =>
        transaction?.[key] === undefined ? [] : [[key, transaction[key]] as const],
      ),
    );
  return {
    ...(transaction === undefined
      ? {}
      : {
          transaction: pick([
            "payment_hash",
            "state",
            "transaction_state",
            "amount_msats",
            "fees_paid_msats",
            "created_at",
            "settled_at",
            "expires_at",
          ]),
        }),
    observed_at: details.observed_at,
    ...(details.paid_at_source === undefined ? {} : { paid_at_source: details.paid_at_source }),
  };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new OpenReceiveHttpError(413, "INVALID_REQUEST", "Request body is too large.");
  }
  const text = await readCappedBodyText(request);
  try {
    const value = text.trim() === "" ? {} : JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new OpenReceiveHttpError(400, "INVALID_REQUEST", "Request body must be a JSON object.");
  }
}

/**
 * Drain the request through its stream reader with a running byte cap and
 * cancel the moment it is exceeded. A chunked body declares no content-length,
 * so buffering the whole thing first (`request.text()`) would let an
 * unauthenticated payer stream unbounded input into memory before any check.
 */
async function readCappedBodyText(request: Request): Promise<string> {
  const stream = request.body;
  if (stream === null) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await reader.read();
    } catch {
      throw new OpenReceiveHttpError(400, "INVALID_REQUEST", "Request body must be a JSON object.");
    }
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new OpenReceiveHttpError(413, "INVALID_REQUEST", "Request body is too large.");
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

/**
 * `?currencies=` is payer input on an unauthenticated route: an empty list or a
 * non ISO-4217-shaped entry is a 400, not the retryable "rates temporarily
 * unavailable" the service raises for feed outages. An absent parameter means
 * "the configured set".
 */
function ratesCurrencies(raw: string | null): readonly string[] | undefined {
  if (raw === null) return undefined;
  const currencies = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (currencies.length === 0 || currencies.some((value) => !/^[A-Za-z]{3}$/.test(value))) {
    throw new OpenReceiveHttpError(
      400,
      "INVALID_REQUEST",
      "currencies must be a comma-separated list of three-letter currency codes.",
    );
  }
  return currencies;
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

function requiredString(value: unknown, field: string, maxLength?: number): string {
  const result = optionalString(value);
  if (result === undefined)
    throw new OpenReceiveHttpError(400, "INVALID_REQUEST", `${field} is required.`);
  if (maxLength !== undefined && result.length > maxLength) {
    throw new OpenReceiveHttpError(
      400,
      "INVALID_REQUEST",
      `${field} must be ${maxLength} characters or fewer.`,
    );
  }
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
  if (typeof value === "bigint") return bigintToJsonNumber(value);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      toSnakeCase(item),
    ]),
  );
}
