import { unixSeconds } from "@openreceive/core";

/**
 * A unix timestamp in **seconds** — the unit every OpenReceive wire field uses
 * (`expires_at`, `provider_expires_at`, `settled_at`, `paid_at`) and therefore
 * the unit every `now` option compares against.
 *
 * It is a plain `number`; the alias exists so the unit shows up where the
 * option does. `Date.now()` is MILLISECONDS and is the wrong value here —
 * {@link resolveNow} rejects it rather than letting every invoice read as
 * expired. Use `Math.floor(Date.now() / 1000)`.
 */
export type UnixSeconds = number;

// Seconds this large land in the year 33658; milliseconds this large land in
// 2001. Every real `Date.now()` is above it and every real seconds clock is
// below it, so the split is unambiguous rather than a heuristic.
const MILLISECONDS_THRESHOLD = 1e12;

/**
 * The caller's `now`, or the current time — in seconds, checked.
 *
 * Passing milliseconds used to be silent: `now` sits on one side of an
 * `expires_at <= now` comparison, so a `Date.now()` made every invoice read
 * `expired` with no error and no warning. It throws instead, at the call that
 * made the mistake — the same choice `formatMsats` makes for a malformed
 * amount.
 */
export function resolveNow(now: UnixSeconds | undefined): UnixSeconds {
  if (now === undefined) return unixSeconds();
  if (now > MILLISECONDS_THRESHOLD) {
    throw new RangeError(
      `OpenReceive \`now\` is a unix timestamp in SECONDS; received ${now}, which is milliseconds. Pass Math.floor(Date.now() / 1000).`,
    );
  }
  return now;
}
