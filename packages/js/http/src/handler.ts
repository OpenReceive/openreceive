import { compact, unixSeconds } from "@openreceive/core";
import type {
  Checkout,
  CreateCheckoutAmount,
  OpenReceive,
  SwapCheckout,
  SwapData,
} from "@openreceive/node";
import type { Host } from "./host-payments.ts";
import { maybeReconcilePayments, type OpportunisticReconcileResult } from "./reconcile-gate.ts";
import type { Authorize, AuthorizeAction, AuthorizeResource, RateLimit } from "./authorize.ts";
import {
  createRequestId,
  errorResponse,
  isServiceErrorShape,
  jsonResponse,
  HttpError,
} from "./errors.ts";
import type { AttemptStatus } from "./payment-repository.ts";
import {
  assertDeclaredFields,
  MAX_REFERENCE_LENGTH,
  optionalCheckoutFields,
  ratesCurrencies,
  readJsonBody,
  rejectPayerAmount,
  requiredPaymentHash,
  requiredString,
} from "./http-request.ts";
import {
  httpCheckout,
  httpSwap,
  paymentCheckFromReconcilePass,
  paymentCheckFromStoredAttempt,
  toSnakeCase,
} from "./http-response.ts";
import {
  createIpRateLimit,
  resolveClientIp,
  clientIpBucket,
  type IpRateLimitConfig,
} from "./rate-limit.ts";
import { matchRoute, normalizePrefix } from "./router.ts";

// This file owns the route dispatch and the rules that decide WHAT a request
// gets: authorize, rate limit, resolve the host order, mint or recover the
// attempt. Reading a request body and shaping a response body are the wire
// boundary's own rules and live in http-request.ts / http-response.ts.

export interface CheckoutCreatedInput {
  readonly reference: string;
  readonly paymentHash: string;
  readonly checkout: Checkout;
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
  readonly action: AuthorizeAction;
  readonly request: Request;
  readonly reference: string;
  readonly payInAsset?: string;
  /** Untrusted payer input. Use it only to locate/recompute host-owned data. */
  readonly input: Readonly<Record<string, unknown>>;
}

export interface ResolvedHostCheckout {
  /**
   * Host-owned price. Payer input is never an amount authority. Required for
   * prepare/create/quote actions; status and refund actions on a committed
   * attempt never need (or wait for) host pricing.
   */
  readonly amount?: CreateCheckoutAmount;
  /** Return the selected host payment attempt's hash to reuse or inspect its checkout. */
  readonly paymentHash?: string;
  /** Host-persisted safe checkout snapshot used for retry without a wallet read. */
  readonly checkout?: Checkout;
  /** Server-only structured provider state loaded from the host database. */
  readonly swapData?: SwapData;
  /**
   * The selected attempt's stored status and settlement time, when the
   * resolver read them. `payments/check` serves this on the row path
   * (`gate_busy`, a hash outside the pending set, reconcile disabled) instead
   * of re-reading the rows the resolver listed moments earlier in the same
   * request — that route is the highest-frequency one there is. A custom
   * `resolveCheckout` may omit it; the row is then re-read.
   */
  readonly attemptStatus?: {
    readonly status: AttemptStatus;
    readonly paidAt: number | null;
  };
}

export type ResolveCheckoutHook = (
  context: ResolveCheckoutContext,
) => ResolvedHostCheckout | Promise<ResolvedHostCheckout>;

export interface CreateHttpHandlerOptions {
  readonly service: OpenReceive;
  /** Host authentication and authorization policy. OpenReceive never inspects host sessions. */
  readonly authorize: Authorize;
  /** Host authentication-independent payment integration returned by createHost. */
  readonly host: Host;
  readonly rateLimitHook?: RateLimit;
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
   * `rateLimitHook`.
   */
  readonly rateLimiting?: boolean | IpRateLimitConfig;
  /**
   * Opportunistic settlement discovery, ON by default: every mounted payment
   * route first runs one durably gated reconcile pass when payment attempts
   * are pending, so abandoned checkouts settle on any later OpenReceive call
   * with no long-running process. Unauthenticated `GET /rates` never triggers
   * it — crawlers and health checks must not consume the wallet-scan budget.
   * The durable `openreceive_meta` gate (min 2s, stretched by invoice age) is
   * shared by every worker on the host database, so rapid calls collapse to
   * one real wallet scan per interval; `payments/check` serves the requested
   * hash from that same pass — one gate claim per request, never a second
   * per-invoice wallet walk. Requires `payments.claimReconcileGate` (the
   * built-in SQL repository has it); construction throws otherwise rather
   * than degrading silently. A dedicated notifications worker claims the same
   * gate, so running both never double-scans. Pass `false` to disable or
   * `{ minIntervalSeconds }` to tune.
   */
  readonly opportunisticReconcile?: boolean | { readonly minIntervalSeconds?: number };
  /**
   * Clock override (unix seconds) for every time-dependent decision the
   * handler makes: the opportunistic reconcile gate AND the `payments/check`
   * payment-methods cache TTL. A test that overrides it to control the gate
   * also controls that cache — which is the point (one clock, one handler),
   * but worth knowing before a frozen clock keeps a warmed catalog forever.
   */
  readonly clock?: () => number;
  readonly prefix?: string;
}

export interface HttpHandler {
  (request: Request, extras?: { native?: unknown }): Promise<Response>;
  readonly prefix: string;
  handle(request: Request, extras?: { native?: unknown }): Promise<Response>;
}

interface Runtime extends CreateHttpHandlerOptions {
  readonly prefix: string;
  /** The resolved limiter: the custom `rateLimitHook` or the built-in per-IP one. */
  readonly rateLimit?: RateLimit;
  /** Single client-IP resolution used for BOTH row stamping and limit counting. */
  readonly extractClientIp: (context: {
    readonly action: AuthorizeAction;
    readonly request: Request;
    readonly resource: AuthorizeResource;
    readonly native?: unknown;
  }) => string | undefined;
  /** Resolved opportunistic-reconcile tuning; undefined means disabled. */
  readonly reconcile: { readonly minIntervalSeconds?: number } | undefined;
  /**
   * Handler-local warm cache for `payments/check` payment_methods: the swap
   * catalog is served from here while fresh, so ~3s status polls do not walk
   * the provider catalog on every request.
   */
  readonly paymentMethods: Map<number, { readonly at: number; readonly methods: unknown }>;
}

export function createHttpHandler(options: CreateHttpHandlerOptions): HttpHandler {
  if (options?.service === undefined) throw new TypeError("HTTP handler requires service.");
  if (options.authorize === undefined) {
    throw new TypeError("HTTP handler requires authorize; authentication belongs to the host.");
  }
  if (options.host === undefined) throw new TypeError("HTTP handler requires host.");
  // rateLimiting: false means disabled, so it composes with a custom rateLimitHook.
  if (
    options.rateLimiting !== undefined &&
    options.rateLimiting !== false &&
    options.rateLimitHook !== undefined
  ) {
    throw new TypeError("Pass either rateLimiting or a custom rateLimitHook, not both.");
  }
  const rateLimit = options.rateLimitHook ?? resolveRateLimiting(options);
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
    resolveClientIp;
  const extractClientIp: Runtime["extractClientIp"] = (context) => {
    const ip = rawExtractClientIp(context);
    return ip === undefined || ip.length === 0 ? undefined : clientIpBucket(ip);
  };
  const runtime: Runtime = {
    ...options,
    ...(rateLimit === undefined ? {} : { rateLimit }),
    extractClientIp,
    reconcile,
    paymentMethods: new Map(),
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
  const handler = handle as HttpHandler;
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
    throw new HttpError(404, "NOT_FOUND", "No OpenReceive route matched this method and path.");

  // Unauthenticated GET /rates never triggers the opportunistic pass:
  // crawlers and health checks must not consume the wallet-scan budget.
  if (route.kind === "rates") {
    const currencies = ratesCurrencies(url.searchParams.get("currencies"));
    return jsonResponse(
      200,
      await runtime.service.listRates(currencies === undefined ? undefined : { currencies }),
      requestId,
    );
  }

  // AFTER readJsonBody's cheap refusals (cross-site, content type, body cap)
  // and the body's own field checks — the same
  // crawlers-must-not-consume-the-scan-budget argument that exempts GET
  // /rates. An anonymous garbage POST is refused without a DB read, without
  // claiming the gate, and without triggering a wallet scan.
  const body = await readJsonBody(request);
  // Before the generic field whitelist, so a payer pricing attempt is refused
  // by name instead of as an unexpected field.
  rejectPayerAmount(body);
  assertDeclaredFields(route.kind, body);
  const reference = requiredString(body.reference, "reference", MAX_REFERENCE_LENGTH);

  // Any payment call is a settlement trigger: before the route's own work, run
  // one durably gated reconcile pass (never throws; a failed scan must not
  // fail this request). `payments/check` consumes this pass result below —
  // exactly one gate claim per request.
  const reconcilePass: OpportunisticReconcileResult | undefined =
    runtime.reconcile === undefined
      ? undefined
      : await maybeReconcilePayments({
          service: runtime.service,
          host: runtime.host,
          // `service`/`host` stay outside compact: it is recursive, and they
          // are handles whose identity the reconcile pass relies on.
          ...compact({
            minIntervalSeconds: runtime.reconcile.minIntervalSeconds,
            clock: runtime.clock,
          }),
        });

  if (route.kind === "checkout.prepare") {
    await authorizeAndRateLimit(runtime, "checkout.prepare", request, { reference }, native);
    const resolved = await resolveHostCheckout(
      runtime,
      "checkout.prepare",
      request,
      reference,
      body,
    );
    const prepared = await runtime.service.prepareCheckout({
      amount: requireResolvedAmount(resolved),
    });
    const swapOptions = await runtime.service.listSwapOptions({
      amountMsats: prepared.amountMsats,
    });
    return jsonResponse(
      200,
      {
        reference: reference,
        amount_msats: prepared.amountMsats,
        fiat_quote: prepared.fiatQuote === null ? null : toSnakeCase(prepared.fiatQuote),
        payment_methods: toSnakeCase(swapOptions.options),
      },
      requestId,
    );
  }

  if (route.kind === "checkout.create") {
    await enforceAuthorize(runtime, "checkout.create", request, { reference }, native);
    const resolved = await resolveHostCheckout(
      runtime,
      "checkout.create",
      request,
      reference,
      body,
    );
    const checkout = await commitNewAttempt(
      runtime,
      "checkout.create",
      request,
      reference,
      resolved,
      native,
      {
        mint: () =>
          runtime.service.createCheckout({
            reference,
            amount: requireResolvedAmount(resolved),
            ...optionalCheckoutFields(body),
          }),
        recover: () => committedCheckout(reference, resolved),
        attempt: (minted) => ({ paymentHash: minted.paymentHash, checkout: minted }),
      },
    );
    return jsonResponse(201, { checkout: httpCheckout(checkout) }, requestId);
  }

  if (route.kind === "payment.check") {
    const requestedPaymentHash = requiredPaymentHash(
      requiredString(body.payment_hash, "payment_hash"),
    );
    await authorizeAndRateLimit(
      runtime,
      "payment.check",
      request,
      { reference, paymentHash: requestedPaymentHash },
      native,
    );
    const resolved = await resolveHostCheckout(runtime, "payment.check", request, reference, body);
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
        ? paymentCheckFromReconcilePass(fromPass)
        : await paymentCheckFromStoredAttempt(
            runtime.host.payments,
            reference,
            paymentHash,
            resolved.attemptStatus,
          );
    // Catalog warms on the first check; clients keep "Loading currencies…" until
    // payment_methods is present (even as an empty Lightning-only list). Polls
    // inside the warm window reuse the cached catalog — a ~3s status poll must
    // not walk the provider catalog every time.
    const checkout = requireResolvedCheckout(resolved);
    return jsonResponse(
      200,
      {
        ...checkedBody,
        payment_methods: await checkPaymentMethods(runtime, checkout.amountMsats),
      },
      requestId,
    );
  }

  if (route.kind === "swap.quote") {
    const payInAsset = requiredString(body.pay_in_asset, "pay_in_asset");
    await authorizeAndRateLimit(runtime, "swap.quote", request, { reference }, native);
    const resolved = await resolveHostCheckout(
      runtime,
      "swap.quote",
      request,
      reference,
      body,
      payInAsset,
    );
    return jsonResponse(
      200,
      toSnakeCase(
        await runtime.service.quoteSwap({
          amount: requireResolvedAmount(resolved),
          payInAsset,
        }),
      ),
      requestId,
    );
  }

  if (route.kind === "swap.create") {
    const payInAsset = requiredString(body.pay_in_asset, "pay_in_asset");
    await enforceAuthorize(runtime, "swap.create", request, { reference }, native);
    const resolved = await resolveHostCheckout(
      runtime,
      "swap.create",
      request,
      reference,
      body,
      payInAsset,
    );
    const swap = await commitNewAttempt(
      runtime,
      "swap.create",
      request,
      reference,
      resolved,
      native,
      {
        mint: () =>
          runtime.service.createSwap({
            reference,
            amount: requireResolvedAmount(resolved),
            payInAsset,
            ...optionalCheckoutFields(body),
          }),
        recover: () => recoverCommittedSwap(runtime, reference, resolved),
        attempt: (minted) => ({
          paymentHash: minted.paymentHash,
          checkout: minted.checkout,
          swapData: minted.swapData,
        }),
      },
    );
    return jsonResponse(201, { swap: httpSwap(swap) }, requestId);
  }

  const action: AuthorizeAction = route.kind === "swap.read" ? "swap.read" : "swap.refund";
  const requestedPaymentHash = requiredPaymentHash(
    requiredString(body.payment_hash, "payment_hash"),
  );
  await authorizeAndRateLimit(
    runtime,
    action,
    request,
    { reference, paymentHash: requestedPaymentHash },
    native,
  );
  const resolved = await resolveHostCheckout(runtime, action, request, reference, body);
  const swapData = requireResolvedSwapData(resolved.swapData);
  const paymentHash = selectedPaymentHash(resolved, requestedPaymentHash);
  if (route.kind === "swap.read") {
    return jsonResponse(
      200,
      toSnakeCase(
        await runtime.service.getSwap({
          reference,
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
        reference,
        paymentHash,
        swapData,
        refundAddress,
      }),
    ),
    requestId,
  );
}

/**
 * The mint-or-recover half of a create route, holding the "only a minting
 * request pays" rule ONCE for both `checkout.create` and `swap.create`.
 *
 * A request MINTS when the host resolver returned no payment hash for the order;
 * otherwise it re-serves the order's already-committed attempt. Two separate,
 * independently-reviewable controls hang off that one test, and they must never
 * disagree about which request is which:
 *
 * - Billing/abuse: rate limits meter minting only. Re-serving the order's
 *   already-committed attempt costs no wallet call and no row, so a capped payer
 *   can still re-fetch instructions they were already given.
 * - Settlement: the attempt row is written only by the request that minted the
 *   invoice, and only after the mint. Persisting on a recovery path would write
 *   a second row for an invoice that already has one; skipping the write on a
 *   mint would leave an invoice the host never recorded, which settles against
 *   no row (persistCheckoutAttempt turns a failed write into a 503 so the payer
 *   instructions are withheld rather than orphaned).
 *
 * The two recovery arms are asymmetric — checkout re-serves the stored snapshot
 * synchronously, swap must re-read the provider — so both arms stay in the
 * caller's closures and only the rule lives here.
 */
async function commitNewAttempt<T>(
  runtime: Runtime,
  action: "checkout.create" | "swap.create",
  request: Request,
  reference: string,
  resolved: ResolvedHostCheckout,
  native: unknown,
  arms: {
    /** Mint a fresh attempt: one wallet call, one new row. */
    readonly mint: () => Promise<T>;
    /** Re-serve the order's already-committed attempt: no wallet call, no row. */
    readonly recover: () => T | Promise<T>;
    /** The attempt fields to persist, from the freshly minted result. */
    readonly attempt: (minted: T) => Omit<CheckoutCreatedInput, "reference" | "clientIp">;
  },
): Promise<T> {
  if (resolved.paymentHash !== undefined) return arms.recover();
  await enforceRateLimit(runtime, action, request, { reference }, native);
  const minted = await arms.mint();
  const clientIp = runtime.extractClientIp({ action, request, resource: { reference }, native });
  await persistCheckoutAttempt(runtime, {
    reference,
    ...arms.attempt(minted),
    ...(clientIp === undefined ? {} : { clientIp }),
  });
  return minted;
}

async function resolveHostCheckout(
  runtime: Runtime,
  action: AuthorizeAction,
  request: Request,
  reference: string,
  input: Readonly<Record<string, unknown>>,
  payInAsset?: string,
): Promise<ResolvedHostCheckout> {
  return runtime.host.resolveCheckout({
    action,
    request,
    reference,
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
function resolveRateLimiting(options: CreateHttpHandlerOptions): RateLimit | undefined {
  if (options.rateLimiting === undefined || options.rateLimiting === false) return undefined;
  const config = options.rateLimiting === true ? {} : options.rateLimiting;
  const payments = options.host.payments;
  const countAttemptsFromIp =
    config.countAttemptsFromIp ?? payments.countAttemptsFromIp?.bind(payments);
  return createIpRateLimit({
    ...config,
    ...(countAttemptsFromIp === undefined ? {} : { countAttemptsFromIp }),
  });
}

async function authorizeAndRateLimit(
  runtime: Runtime,
  action: AuthorizeAction,
  request: Request,
  resource: AuthorizeResource,
  native?: unknown,
): Promise<void> {
  await enforceRateLimit(runtime, action, request, resource, native);
  await enforceAuthorize(runtime, action, request, resource, native);
}

// Create actions call these separately: authorize first, then the rate limit only
// once the host has resolved whether a new attempt must be minted (reuse is exempt).
async function enforceRateLimit(
  runtime: Runtime,
  action: AuthorizeAction,
  request: Request,
  resource: AuthorizeResource,
  native?: unknown,
): Promise<void> {
  if (runtime.rateLimit === undefined) return;
  if (!(await runtime.rateLimit({ action, request, resource, native }))) {
    throw new HttpError(429, "RATE_LIMITED", "Too many requests.", {
      retryable: true,
      retryAfterSeconds: 60,
    });
  }
}

async function enforceAuthorize(
  runtime: Runtime,
  action: AuthorizeAction,
  request: Request,
  resource: AuthorizeResource,
  native?: unknown,
): Promise<void> {
  if (!(await runtime.authorize({ action, request, resource, native }))) {
    throw new HttpError(403, "FORBIDDEN", "Not authorized for this action.");
  }
}

async function persistCheckoutAttempt(
  runtime: Runtime,
  input: CheckoutCreatedInput,
): Promise<void> {
  try {
    await runtime.host.onCheckoutCreated(input);
  } catch (error) {
    // Meaningful repository refusals ("already paid", "live attempt for the
    // same method") keep their own status and message.
    if (error instanceof HttpError || isServiceErrorShape(error)) throw error;
    // Anything else is infrastructure failing to persist (database down, bug):
    // retryable 503, never a payer-blaming conflict.
    throw new HttpError(
      503,
      "INTERNAL",
      "The host could not persist this payment attempt; payer instructions were withheld. Please retry.",
      { retryable: true },
    );
  }
}

/** Seconds a `payments/check` payment_methods catalog stays warm per amount. */
const PAYMENT_METHODS_CACHE_SECONDS = 60;

/** Amount buckets kept warm before the cache is cleared wholesale: a memory cap, not an LRU. */
const PAYMENT_METHODS_CACHE_MAX_ENTRIES = 256;

/**
 * The `payments/check` payment_methods list, from the handler-local warm cache
 * when fresh for this amount, otherwise from one `listSwapOptions` call. The
 * first check (and any check after the TTL) warms the catalog; every poll in
 * between serves the warmed copy.
 */
async function checkPaymentMethods(runtime: Runtime, amountMsats: number): Promise<unknown> {
  const now = (runtime.clock ?? unixSeconds)();
  const cached = runtime.paymentMethods.get(amountMsats);
  if (cached !== undefined && now - cached.at < PAYMENT_METHODS_CACHE_SECONDS) {
    return cached.methods;
  }
  const swapOptions = await runtime.service.listSwapOptions({ amountMsats });
  const methods = toSnakeCase(swapOptions.options);
  if (runtime.paymentMethods.size >= PAYMENT_METHODS_CACHE_MAX_ENTRIES) {
    runtime.paymentMethods.clear();
  }
  runtime.paymentMethods.set(amountMsats, { at: now, methods });
  return methods;
}

function selectedPaymentHash(resolved: ResolvedHostCheckout, requestedPaymentHash: string): string {
  const selected = hostPaymentHash(resolved.paymentHash);
  if (selected !== requestedPaymentHash) {
    throw new HttpError(
      404,
      "NOT_FOUND",
      "The selected payment attempt does not belong to this order.",
    );
  }
  return selected;
}

/**
 * A payment hash the HOST resolver returned. A missing or malformed value here
 * is a host integration bug, never payer input: it must surface as a 500
 * naming the host, not as a payer-blaming 400.
 */
function hostPaymentHash(value: unknown): string {
  if (typeof value === "string") {
    const hash = value.trim().toLowerCase();
    if (/^[0-9a-f]{64}$/.test(hash)) return hash;
  }
  throw new HttpError(
    500,
    "INTERNAL",
    "The host resolver returned a missing or malformed payment hash for this reference.",
  );
}

function requireResolvedAmount(value: ResolvedHostCheckout): CreateCheckoutAmount {
  if (value.amount === undefined || value.amount === null) {
    throw new HttpError(500, "INTERNAL", "The host resolved this order without an amount.");
  }
  return value.amount;
}

function requireResolvedCheckout(value: ResolvedHostCheckout): Checkout {
  if (value.checkout === undefined) {
    throw new HttpError(409, "CONFLICT", "The host payment attempt has no checkout snapshot.");
  }
  return value.checkout;
}

function requireResolvedSwapData(value: SwapData | undefined): SwapData {
  if (value === undefined) {
    throw new HttpError(404, "NOT_FOUND", "The host order has no swap data.");
  }
  return value;
}

function committedCheckout(reference: string, resolved: ResolvedHostCheckout): Checkout {
  const paymentHash = hostPaymentHash(resolved.paymentHash);
  const checkout = requireResolvedCheckout(resolved);
  if (checkout.reference !== reference || checkout.paymentHash.toLowerCase() !== paymentHash) {
    throw new HttpError(
      409,
      "CONFLICT",
      "The selected payment attempt is not a reusable pending checkout.",
    );
  }
  return structuredClone(checkout);
}

async function recoverCommittedSwap(
  runtime: Runtime,
  reference: string,
  resolved: ResolvedHostCheckout,
): Promise<SwapCheckout> {
  const paymentHash = hostPaymentHash(resolved.paymentHash);
  const swapData = requireResolvedSwapData(resolved.swapData);
  const status = await runtime.service.getSwap({ reference, paymentHash, swapData });
  // committedCheckout is the host-boundary check here: the checkout snapshot is
  // host-supplied and must agree with the resolved hash. getSwap's own
  // reference/paymentHash are verbatim echoes of the arguments just passed in,
  // so comparing them would only compare our service with itself.
  const checkout = committedCheckout(reference, resolved);
  return { ...status, checkout, swapData };
}
