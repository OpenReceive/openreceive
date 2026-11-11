// Bugs that have a test and no fix yet.
//
// A test that would fail on a known open bug runs its assertions through
// `whileOpen()`. While the bug is there the test passes and prints what it saw.
// The day the bug stops reproducing, the test FAILS and says which entry to
// delete, so the list cannot outlive the bugs and a fix cannot land untested.
// From then on the same assertions hold the fix in place.
//
//   OPENRECEIVE_KNOWN_ISSUES=fail npm test
//
// runs every such test as an ordinary test, so each open bug shows as a
// failure with its full assertion message. Use it when fixing one.
//
// An entry needs a reason a maintainer can act on: where it is tracked (an
// issue number, or "found by the browser lab on <date>, not filed") and one
// sentence on what the payer or the shop sees. Do not add an entry to quiet a
// test you have not understood; a test that fails for a reason not listed
// here is a new bug or a broken test, and both need a person.

// Empty: #137, #132 and the reference-then-prefix order were fixed on
// 2026-11-11, and the checks that tracked them now hold the fixes.
export const KNOWN_OPEN = {};

const FAIL_KNOWN = process.env.OPENRECEIVE_KNOWN_ISSUES === "fail";

/**
 * Run `body` (the test's assertions). `id` names the KNOWN_OPEN entry these
 * assertions are expected to trip, or undefined when they must simply hold.
 *
 * `sometimes: true` is for a check the bug trips only when requests land in a
 * certain order (a race): it may fail while the bug is open, and passing
 * proves nothing either way. Keep at least one check per entry that is not
 * `sometimes`, or nothing will say when the entry can go.
 */
export async function whileOpen(t, id, body, { sometimes = false } = {}) {
  if (id === undefined || FAIL_KNOWN) {
    await body();
    return;
  }
  const known = KNOWN_OPEN[id];
  if (known === undefined) throw new Error(`whileOpen: ${id} is not in KNOWN_OPEN`);
  let failure;
  try {
    await body();
  } catch (error) {
    failure = error;
  }
  if (failure === undefined) {
    if (sometimes) return;
    throw new Error(
      `${id} no longer reproduces in this test. If it is fixed, delete "${id}" from ` +
        `tests/helpers/known-issues.mjs so this test guards the fix. (${known.tracked})`,
    );
  }
  if (failure?.code !== "ERR_ASSERTION") throw failure;
  t.diagnostic(`known open ${id}: ${String(failure.message).split("\n")[0]}`);
}
