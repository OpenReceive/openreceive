// Fixtures that were written out byte-identically in three or more test files.
//
// Each export below replaced three or more real occurrences. Several patterns
// that LOOK shareable are deliberately NOT here; the reasons are recorded so
// the next reader does not spend the afternoon rediscovering them.
//
// NOT SHARED — testHost(). adapters.test.mjs, rate-limit.test.mjs and
// http-boundaries.test.mjs each build a host stub, and the three have genuinely
// different contracts: adapters' returns {committed, host}; rate-limit's
// returns the host and aliases commitAttempt; http-boundaries' is a ~45-line
// stateful repository that also supplies `recordSettlement: async () => true`,
// under a comment stating that this claim is what decides whether
// repository-mode onPaid runs. Building the "rich" variant and letting the
// other two pass fewer overrides would hand adapters and rate-limit a
// recordSettlement they deliberately lack, silently moving them onto a
// different settlement path. Leave all three alone.
//
// NOT SHARED — the padStart hash. There are TWO incompatible hash() signatures
// in the suite. `hash(character)` below is the repeat form: one payment hash
// per letter, no ordering meaning. The other form,
// `(value) => value.toString(16).padStart(64, "0")`, yields a DISTINCT ORDERED
// hash per index, and scan-window ordering assertions depend on that order.
// It lives locally in reconcile-scan-window.test.mjs (renamed there to
// `orderedHash` so the two are not mistaken for each other) and in
// core-boundaries.test.mjs. Do not unify them.
//
// NOT SHARED — fakeExpressRequest / fakeExpressResponse. They exist at exactly
// one site (adapters.test.mjs). Moving them here would be relocation, not
// deduplication.
//
// NOT SHARED — paymentRow / checkoutInput. Verified at HEAD: `payment()` exists
// only in host-payments.test.mjs and `checkoutInput()` only in
// sql-payments.test.mjs. One site each; same reason as above.
//
// NOT SHARED — the redaction and secret-scanning assertions. tests/
// log-redaction.test.mjs repeats itself ON PURPOSE: a shared helper that
// silently stops asserting is exactly the failure those tests exist to catch.
//
// SEE ALSO ./lifecycle-harness.mjs, which exports `until()` and
// `installFastTimers()`. The DOM-lifecycle tests import that `until` and pass
// their own `{ timeoutMs: 4000, stepMs: 5 }`; there are no hand-rolled copies
// left.
import { DatabaseSync } from "node:sqlite";
import { paymentsSchemaSql } from "../../packages/js/http/src/index.ts";

/**
 * A 64-hex-character payment hash made of one repeated character.
 *
 * `hash("a")` and `hash("b")` are distinct hashes with no ordering relationship
 * between them; tests that need ORDERED hashes use the padStart form described
 * in the header instead.
 */
export const hash = (character) => character.repeat(64);

/**
 * A syntactically valid NWC connection URI.
 *
 * Assembled from `repeat` calls rather than written out so that no
 * real-looking NWC URI literal — nothing a secret scanner should flag — exists
 * anywhere in the repository. Keep it that way.
 *
 * Two near-copies stay put. nwc-polling-logging.test.mjs's is a different URI
 * (its relay parameter is not percent-encoded), so it is not this constant.
 * crosslang.test.mjs:29 does inline this exact string, but that file belongs to
 * no track in the current plan, so migrating it is left for whoever claims it.
 */
export const VALID_NWC = `nostr+walletconnect://${"a".repeat(64)}?relay=wss%3A%2F%2Frelay.example.com&secret=${"b".repeat(64)}`;

/**
 * A fresh in-memory SQLite database with the OpenReceive payments schema
 * applied — the two lines that opened every SQL-backed host test.
 *
 * Note for anyone extending this: sql-adapter-modes.test.mjs also opens a
 * `DatabaseSync(":memory:")` but creates a `fruits` table, and
 * scaffold-payments.test.mjs only matches the string "DatabaseSync" in
 * generated code. Neither is a caller of this.
 */
export function memoryPaymentsDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(paymentsSchemaSql("sqlite"));
  return db;
}
