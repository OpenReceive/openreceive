/**
 * Value primitives shared across the packages.
 *
 * Everything here was written three or more times, byte-identically, before it
 * moved in. Each helper keeps EXACTLY the semantics its original call sites
 * relied on — where two variants disagreed, the doc comment says which one this
 * is and which callers deliberately keep their own.
 */

/**
 * Whole seconds since the Unix epoch — the one clock every package shares.
 *
 * FLOOR, never round. `@openreceive/http`'s `isReusablePaymentAttempt` compares
 * this against an invoice's `expires_at` to decide whether to hand a payer back
 * an existing invoice; rounding up would let it reuse an invoice that has
 * already expired. All eleven definitions this replaced were floor-based.
 */
export function unixSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

/**
 * Narrowing predicate for a JSON object: not null, not an array.
 *
 * Callers that must REJECT a non-record build a three-line wrapper on top of
 * this and throw their own error type (OpenReceivePriceFeedError, the node
 * service error, OpenReceiveHttpError). That error identity is the whole point
 * of those wrappers, so it is not shared here.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A JSON object, or `{}` when the value is not one — for readers that walk an
 * optional nested shape without branching at every level.
 *
 * ARRAY-EXCLUDING: an array yields `{}`. That is the semantics of the three
 * sites this serves (the FixedFloat response reader, the browser swap-HTTP
 * reader, and react's record reader).
 *
 * It deliberately does NOT serve the two ARRAY-PERMITTING readers — NWC relay
 * response normalization and the browser checkout response parser — which pass
 * an array through as a record. Those are untrusted-wire parse boundaries;
 * routing them here would silently narrow what they accept, so they keep their
 * own local helpers. Do not "finish the job" by converting them.
 */
export function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * A non-empty string, or `undefined` for anything else.
 *
 * No trimming: `@openreceive/http`'s handler trims before this check because
 * trimming is a rule of ITS wire boundary, not of every reader, so it keeps a
 * thin wrapper on top. FixedFloat's reader additionally coerces finite numbers
 * to strings — a FixedFloat quirk that also stays local.
 *
 * The `required` counterparts stay where they are too: each throws a different
 * domain error, which is the only reason they exist.
 */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Drop `undefined`-valued own properties.
 *
 * RECURSIVE and array-aware: nested plain records — including plain records
 * inside arrays — are compacted too. That depth is why this is for LOG FIELD
 * objects and internal option forwarding only. Do NOT run it over a wire
 * response, a DOM attribute map, or anything a test asserts key presence on
 * with `deepStrictEqual`: it rewrites nested shapes, not just the top level,
 * and the conditional spread is load-bearing there.
 *
 * "Plain record" means a non-array object whose prototype is `Object.prototype`
 * or null, so class instances (Error, Date, URL) pass through untouched.
 */
export function compact<T extends Record<string, unknown>>(fields: T): T {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      kept[key] = value.map((entry) => (isPlainRecord(entry) ? compact(entry) : entry));
      continue;
    }
    kept[key] = isPlainRecord(value) ? compact(value) : value;
  }
  return kept as T;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
