import {
  isOpenReceiveErrorCode,
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

  constructor(
    status: number,
    code: OpenReceiveErrorCode,
    message: string,
    options: { readonly retryable?: boolean; readonly details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "OpenReceiveHttpError";
    this.status = status;
    this.code = code;
    if (options.retryable !== undefined) this.retryable = options.retryable;
    if (options.details !== undefined) this.details = options.details;
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
 * Host-route control-flow error with the same `{ status, body }` shape as
 * {@link OpenReceiveServiceError}. Use for cart/validation failures on app routes
 * (`/prepare_order`, etc.) so {@link mapHostRouteError} / Express helpers can map them.
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
  return null;
}

/** Generate a per-response request id used in both the body and the `X-Request-Id` header. */
export function createRequestId(): string {
  return `req_${globalThis.crypto.randomUUID()}`;
}

/**
 * Serialize a value as a snake_case JSON response with the shared content-type and request-id header.
 * `extraHeaders` are appended (not set), so a route can attach one or more `Set-Cookie` headers
 * without clobbering an existing one; every other response passes no extra headers and is unchanged.
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
  return new Response(JSON.stringify(body), { status, headers });
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
    );
  }

  if (isServiceErrorShape(error)) {
    return jsonResponse(
      error.status,
      { ...error.body, request_id: error.body.request_id ?? requestId },
      requestId,
    );
  }

  return jsonResponse(
    500,
    { code: "INTERNAL", message: "Internal server error.", request_id: requestId },
    requestId,
  );
}
