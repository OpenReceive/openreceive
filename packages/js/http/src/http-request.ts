import { isRecord, nonEmptyString } from "@openreceive/core";
import { HttpError } from "./errors.ts";

// The request half of the HTTP wire boundary: everything that reads payer- or
// host-supplied input off a `Request` and refuses it BY NAME when it does not
// match the published contract. Nothing here knows about routes, the service,
// or the host — dispatch (handler.ts) calls in, and the response half lives in
// http-response.ts.

/** Spec-declared length caps (openreceive-http.v1.yaml request schemas). */
export const MAX_REFERENCE_LENGTH = 200;
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
  "checkout.prepare": ["reference"],
  "checkout.create": ["reference", "memo", "metadata"],
  "payment.check": ["reference", "payment_hash"],
  "swap.quote": ["reference", "pay_in_asset"],
  "swap.create": ["reference", "pay_in_asset", "memo", "metadata"],
  "swap.read": ["reference", "payment_hash"],
  "swap.refund": ["reference", "payment_hash", "refund_address"],
};

export function assertDeclaredFields(routeKind: string, body: Record<string, unknown>): void {
  const allowed = ROUTE_BODY_FIELDS[routeKind];
  if (allowed === undefined) return;
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new HttpError(
        400,
        "INVALID_REQUEST",
        `Unexpected request field for this route: ${key}.`,
      );
    }
  }
}

export function rejectPayerAmount(body: Record<string, unknown>): void {
  if (body.amount !== undefined || body.amount_msats !== undefined) {
    throw new HttpError(
      400,
      "INVALID_REQUEST",
      "This route does not accept a payer-supplied amount; the host resolves its order price.",
    );
  }
}

/**
 * The body-bearing routes accept `application/json` only, checked before
 * authorize or any host hook. This is the CSRF-equivalent on
 * cookie-authenticated mounts: a cross-site HTML form cannot set a JSON
 * content type (only urlencoded, multipart, or text/plain), and a
 * cross-origin fetch that does is non-simple and CORS-preflighted — which the
 * library never answers — so a forged request carrying the victim's session
 * can never present a JSON body here. Parameters and charset are ignored.
 * Mirrors the Ruby engine's RequestHandler#assert_json_content_type!.
 */
function assertJsonContentType(request: Request): void {
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim();
  if (contentType !== "application/json") {
    throw new HttpError(415, "INVALID_REQUEST", "Request content type must be application/json.");
  }
}

/**
 * Browsers label every request with its initiator's relation to the target
 * (`Sec-Fetch-Site`), and a forged request from another site is always
 * `cross-site` — including a `mode: "no-cors"` fetch, which the content-type
 * gate alone cannot see. The mounted routes serve the host's own pages, so a
 * cross-site POST is refused before the body is read. `same-site` (a sibling
 * subdomain) and an absent header (non-browser clients, old browsers — the
 * content-type gate covers those) pass. Mirrors the Ruby engine's
 * RequestHandler#assert_not_cross_site!.
 */
function assertNotCrossSite(request: Request): void {
  if (request.headers.get("sec-fetch-site")?.trim().toLowerCase() === "cross-site") {
    throw new HttpError(403, "FORBIDDEN", "Cross-site requests are not accepted.");
  }
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  assertNotCrossSite(request);
  assertJsonContentType(request);
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "INVALID_REQUEST", "Request body is too large.");
  }
  const text = await readCappedBodyText(request);
  try {
    const value = text.trim() === "" ? {} : JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "INVALID_REQUEST", "Request body must be a JSON object.");
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
      throw new HttpError(400, "INVALID_REQUEST", "Request body must be a JSON object.");
    }
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, "INVALID_REQUEST", "Request body is too large.");
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
export function ratesCurrencies(raw: string | null): readonly string[] | undefined {
  if (raw === null) return undefined;
  const currencies = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (currencies.length === 0 || currencies.some((value) => !/^[A-Za-z]{3}$/.test(value))) {
    throw new HttpError(
      400,
      "INVALID_REQUEST",
      "currencies must be a comma-separated list of three-letter currency codes.",
    );
  }
  return currencies;
}

// Payer-supplied description_hash is deliberately NOT accepted: it would let any
// client make the merchant's wallet mint an invoice committing to arbitrary
// content. Hosts minting hash-committed invoices do so server-side via the service.
export function optionalCheckoutFields(body: Record<string, unknown>) {
  const memo = trimmedField(body.memo);
  if (memo !== undefined && memo.length > MAX_MEMO_LENGTH) {
    throw new HttpError(
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

export function requiredPaymentHash(value: unknown): string {
  const hash = requiredString(value, "payment_hash").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new HttpError(400, "INVALID_REQUEST", "payment_hash must be 64 hexadecimal characters.");
  }
  return hash;
}

export function requiredString(value: unknown, field: string, maxLength?: number): string {
  const result = trimmedField(value);
  if (result === undefined) throw new HttpError(400, "INVALID_REQUEST", `${field} is required.`);
  if (maxLength !== undefined && result.length > maxLength) {
    throw new HttpError(
      400,
      "INVALID_REQUEST",
      `${field} must be ${maxLength} characters or fewer.`,
    );
  }
  return result;
}

/**
 * Trim first, then read a non-empty string. The trim is a rule of THIS wire
 * boundary — core's `nonEmptyString` deliberately does not trim — so it stays
 * here rather than moving into the shared primitive.
 */
function trimmedField(value: unknown): string | undefined {
  return typeof value === "string" ? nonEmptyString(value.trim()) : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new HttpError(400, "INVALID_REQUEST", "metadata must be an object.");
  }
  return value;
}
