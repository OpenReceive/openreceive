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

// #137, #132 and the reference-then-prefix order were fixed on 2026-11-11,
// and the checks that tracked them now hold the fixes.
export const KNOWN_OPEN = {
  "reload-mid-create": {
    tracked: "found by the browser lab on 2026-11-23, not filed",
    summary:
      "A payer who reloads while the shop is still waiting on its wallet or swap provider, " +
      "and picks again, is told 'This payment changed while the page was open. Reload the " +
      "page and try again.'; both requests minted, so the wallet holds an extra invoice and " +
      "the swap provider an extra unpaid order.",
  },
  "reload-after-pay": {
    tracked: "found by the browser lab on 2026-11-23, not filed",
    summary:
      "A payer who pays and whose page reloads before its next status poll (a phone " +
      "reloading the tab it sent to the background) lands on 'Choose how you want to pay' " +
      "while the shop's reconcile gate is busy. The method grid never polls, so the receipt " +
      "never comes; picking Bitcoin again answers 'This payment changed while the page was " +
      "open. Reload the page and try again.', and only a second reload shows the receipt.",
  },
  "swap-screen-misses-paid": {
    tracked: "found by the browser lab on 2026-11-23, not filed",
    summary:
      "A swap deposit screen polls only its own attempt: when the order is paid on its " +
      "Lightning invoice meanwhile, the shop records the payment but the screen keeps " +
      "asking for the coin.",
  },
  "no-request-timeout": {
    tracked: "found by the browser lab on 2026-11-23, not filed",
    summary:
      "A checkout request that never answers leaves the payer on a spinner with no way on " +
      "(prepare, mint, swap start), or freezes status polling so a paid order never shows " +
      "as paid: @openreceive/browser sets no time limit on its requests.",
  },
  "slow-after-outage": {
    tracked: "found by the browser lab on 2026-11-23, not filed",
    summary:
      "After a connection outage of about a minute, a payer who paid meanwhile waits 20 s " +
      "or more after the network is back before the paid screen shows: failed status polls " +
      "back off 2, 4, 8, 16, 32, 60 s, and nothing polls when the browser comes back online.",
  },
};

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
