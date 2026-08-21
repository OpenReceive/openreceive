import {
  isOpenReceiveErrorCode,
  isRetryableOpenReceiveErrorCode,
  type OpenReceiveErrorBody,
  type OpenReceiveErrorCode,
} from "@openreceive/core";

// Every response — success or failure — carries a request id. Errors echo it in the JSON body
// (`request_id`) and in the `X-Request-Id` header so a host's logs, the caller's report, and the
// adapter's trace line up on a single value. The wire body is snake_case JSON with a `code` drawn
// from the shared OpenReceiveErrorCode enum, matching the Ruby engine and every other adapter.

/**
 * A control-flow error the handler maps to a JSON error response. Carries the HTTP status, a
 * shared error code, and an optional `retryable` hint / `details` object.
 */
export class OpenReceiveHttpError extends Error {
  readonly status: number;
  readonly code: OpenReceiveErrorCode;
  readonly retryable?: boolean;
  readonly details?: Record<string, unknown>;
  /** Emitted as a `Retry-After` header so clients can back off with a hint. */
  readonly retryAfterSeconds?: number;

  constructor(
    status: number,
    code: OpenReceiveErrorCode,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly details?: Record<string, unknown>;
      readonly retryAfterSeconds?: number;
    } = {},
  ) {
    super(message);
    this.name = "OpenReceiveHttpError";
    this.status = status;
    this.code = code;
    if (options.retryable !== undefined) this.retryable = options.retryable;
    if (options.details !== undefined) this.details = options.details;
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** Shape a service error carries: a numeric status and an OpenReceive error body. */
export interface ServiceErrorShape {
  readonly status: number;
  readonly body: OpenReceiveErrorBody;
}

/**
 * Duck-type an OpenReceiveServiceError (from @openreceive/node) without importing the class, so the
 * handler stays runtime-agnostic and never breaks on cross-module `instanceof` identity mismatches
 * (source vs. built dist, or two copies of @openreceive/node).
 */
export function isServiceErrorShape(error: unknown): error is ServiceErrorShape {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { status?: unknown; body?: unknown };
  if (typeof candidate.status !== "number") return false;
  if (typeof candidate.body !== "object" || candidate.body === null) return false;
  const body = candidate.body as { code?: unknown; message?: unknown };
  return isOpenReceiveErrorCode(body.code) && typeof body.message === "string";
}

/**
 * Duck-type a core OpenReceiveError — the wallet client's normalized failure. It carries a
 * canonical `code` and a `retryable` flag but no HTTP status, so without this it would fall
 * through to a generic 500 and every wallet outage would read as an OpenReceive bug.
 */
export function isWalletErrorShape(error: unknown): error is {
  readonly code: OpenReceiveErrorCode;
  readonly message: string;
} & {
  readonly retryable?: boolean;
} {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown; status?: unknown };
  if (candidate.status !== undefined) return false;
  return isOpenReceiveErrorCode(candidate.code) && typeof candidate.message === "string";
}

/**
 * Status for a wallet failure, matching the Ruby engine: a retryable outage
 * (unreachable relay, timeout) is a 503 the payer can retry, and a wallet that
 * answered with a refusal is a 502 from an upstream we depend on. Never 500 —
 * that would blame the host application for the wallet being down.
 */
function walletErrorStatus(code: OpenReceiveErrorCode, retryable: boolean): number {
  return retryable || isRetryableOpenReceiveErrorCode(code) ? 503 : 502;
}

/**
 * Host-route control-flow error with the same `{ status, body }` shape as
 * {@link OpenReceiveServiceError}. Use for cart/validation failures on app routes
 * (for example the host's `/orders` route) so framework helpers can map them.
 */
export class OpenReceiveHostError extends Error {
  readonly status: number;
  readonly body: OpenReceiveErrorBody;

  constructor(status: number, body: OpenReceiveErrorBody) {
    super(body.message);
    this.name = "OpenReceiveHostError";
    this.status = status;
    this.body = body;
  }
}

/** Convenience factory for a host validation error (default 400 INVALID_REQUEST). */
export function hostError(
  message: string,
  status = 400,
  code: OpenReceiveErrorCode = "INVALID_REQUEST",
): OpenReceiveHostError {
  return new OpenReceiveHostError(status, {
    code,
    message,
    retryable: false,
  });
}

/**
 * Map a thrown host/service error to `{ status, body }` for app routes outside the
 * mounted OpenReceive handler. Returns `null` when the value is not a known shape
 * (caller should rethrow / pass to `next(error)`).
 */
export function mapHostRouteError(
  error: unknown,
): { readonly status: number; readonly body: OpenReceiveErrorBody } | null {
  if (error instanceof OpenReceiveHostError || isServiceErrorShape(error)) {
    return { status: error.status, body: error.body };
  }
  if (isWalletErrorShape(error)) {
    const retryable = error.retryable ?? isRetryableOpenReceiveErrorCode(error.code);
    return {
      status: walletErrorStatus(error.code, retryable),
      body: { code: error.code, message: error.message, retryable },
    };
  }
  return null;
}

/** Guarded bigint -> number: throws instead of silently losing precision. */
export function bigintToJsonNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new OpenReceiveHttpError(
      500,
      "INTERNAL",
      "Numeric value exceeds the JSON safe integer range.",
    );
  }
  return Number(value);
}

/** Generate a per-response request id used in both the body and the `X-Request-Id` header. */
export function createRequestId(): string {
  return `req_${globalThis.crypto.randomUUID()}`;
}

/**
 * Serialize a value as a snake_case JSON response with the shared content-type and request-id header.
 * `extraHeaders` are appended (not set) — used for `Retry-After` on 429s. Note for adapters:
 * multi-value headers other than the ones used here would need per-framework handling
 * (Express folds repeated `Set-Cookie` appends); the handler deliberately emits none.
 */
export function jsonResponse(
  status: number,
  body: unknown,
  requestId: string,
  extraHeaders?: Iterable<readonly [string, string]>,
): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "x-request-id": requestId,
  });
  if (extraHeaders !== undefined) {
    for (const [name, value] of extraHeaders) {
      headers.append(name, value);
    }
  }
  return new Response(
    JSON.stringify(body, (_key, value) =>
      typeof value === "bigint" ? bigintToJsonNumber(value) : value,
    ),
    { status, headers },
  );
}

/**
 * Map any thrown value to a JSON error response with a code from the shared enum. Service errors keep
 * their status/body (with `request_id` ensured); handler errors map to their status; anything else is
 * a generic 500 INTERNAL so internal messages never leak.
 */
export function errorResponse(error: unknown, requestId: string): Response {
  if (error instanceof OpenReceiveHttpError) {
    return jsonResponse(
      error.status,
      {
        code: error.code,
        message: error.message,
        ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
        request_id: requestId,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
      requestId,
      error.retryAfterSeconds === undefined
        ? undefined
        : [["retry-after", String(Math.max(1, Math.ceil(error.retryAfterSeconds)))]],
    );
  }

  if (isServiceErrorShape(error)) {
    return jsonResponse(
      error.status,
      { ...error.body, request_id: error.body.request_id ?? requestId },
      requestId,
    );
  }

  if (isWalletErrorShape(error)) {
    const retryable = error.retryable ?? isRetryableOpenReceiveErrorCode(error.code);
    return jsonResponse(
      walletErrorStatus(error.code, retryable),
      { code: error.code, message: error.message, retryable, request_id: requestId },
      requestId,
    );
  }

  return jsonResponse(
    500,
    { code: "INTERNAL", message: "Internal server error.", request_id: requestId },
    requestId,
  );
}
