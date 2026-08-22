import assert from "node:assert/strict";
import test from "node:test";
import {
  compact,
  isRecord,
  nonEmptyString,
  recordOrEmpty,
  unixSeconds,
} from "../packages/js/core/src/index.ts";

test("unixSeconds floors, never rounds, the millisecond clock", () => {
  const realNow = Date.now;
  try {
    // 1_700_000_000.999s: rounding would report the NEXT second, which would
    // let http's isReusablePaymentAttempt reuse an invoice that just expired.
    Date.now = () => 1_700_000_000_999;
    assert.equal(unixSeconds(), 1_700_000_000);
    Date.now = () => 1_700_000_000_000;
    assert.equal(unixSeconds(), 1_700_000_000);
    Date.now = () => 1_700_000_000_500;
    assert.equal(unixSeconds(), 1_700_000_000);
  } finally {
    Date.now = realNow;
  }

  assert.ok(Number.isSafeInteger(unixSeconds()));
});

test("isRecord accepts plain objects and rejects null, arrays and primitives", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord(Object.create(null)), true);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord(undefined), false);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord([{ a: 1 }]), false);
  assert.equal(isRecord("{}"), false);
  assert.equal(isRecord(0), false);
});

test("recordOrEmpty is array-EXCLUDING: an array reads as {}", () => {
  // The array rule is the whole reason this helper does not serve the two
  // array-permitting wire readers (NWC normalize, browser checkout parse).
  assert.deepEqual(recordOrEmpty([]), {});
  assert.deepEqual(recordOrEmpty([{ a: 1 }]), {});
  assert.deepEqual(recordOrEmpty(null), {});
  assert.deepEqual(recordOrEmpty(undefined), {});
  assert.deepEqual(recordOrEmpty("nope"), {});

  const record = { a: 1 };
  assert.equal(recordOrEmpty(record), record, "a record is passed through, not copied");
});

test("nonEmptyString keeps non-empty strings verbatim and does not trim", () => {
  assert.equal(nonEmptyString("abc"), "abc");
  assert.equal(nonEmptyString("  "), "  ", "trimming is a wire-boundary rule, not this one");
  assert.equal(nonEmptyString(""), undefined);
  assert.equal(nonEmptyString(undefined), undefined);
  assert.equal(nonEmptyString(null), undefined);
  assert.equal(nonEmptyString(7), undefined);
  assert.equal(nonEmptyString(new String("abc")), undefined);
});

test("compact drops undefined fields recursively, through arrays, sparing class instances", () => {
  const error = new Error("kept whole");
  const compacted = compact({
    kept: 1,
    dropped: undefined,
    nested: { kept: "yes", dropped: undefined, deeper: { dropped: undefined, kept: true } },
    list: [{ kept: 1, dropped: undefined }, "plain", 3],
    error,
    nullish: null,
    falsy: 0,
  });

  assert.deepEqual(compacted, {
    kept: 1,
    nested: { kept: "yes", deeper: { kept: true } },
    list: [{ kept: 1 }, "plain", 3],
    error,
    nullish: null,
    falsy: 0,
  });
  assert.equal("dropped" in compacted, false);
  assert.equal("dropped" in compacted.nested, false);
  assert.equal(compacted.error, error, "class instances are not rebuilt");
  assert.deepEqual(compact({}), {});
});
