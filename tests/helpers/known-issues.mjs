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

export const KNOWN_OPEN = {
  "issue-137": {
    tracked: "https://github.com/OpenReceive/openreceive/issues/137",
    summary:
      "<openreceive-checkout> upgraded with `reference` and then `prefix` already on it calls " +
      "POST /checkouts/prepare twice and aborts the first. A browser upgrades the element when " +
      "the markup was parsed before the module script ran, set with innerHTML or cloned from a " +
      "<template>: the pages WooCommerce, Easy Digital Downloads, Paymenter, PrestaShop, " +
      "FOSSBilling and Odoo print, and the markup in most guides.",
  },
  "issue-132": {
    tracked: "https://github.com/OpenReceive/openreceive/issues/132",
    summary:
      "@openreceive/vue drops a `prefix` prop on a client render: Vue assigns it to the " +
      "read-only DOM property Element.prefix, so the element asks /openreceive instead.",
  },
  "prefix-after-reference": {
    tracked: "found by tests/real-browser-wrappers.test.mjs on 2026-11-11, not filed",
    summary:
      "A connected <openreceive-checkout> that is given `reference` and then `prefix` (the " +
      "Angular wrapper writes them in that order, one at a time) sends POST " +
      "/openreceive/checkouts/prepare, aborts it, and only then asks the prefix it was given. A " +
      "shop mounted anywhere but /openreceive gets a request for a path it does not serve on " +
      "every Angular checkout. The issue-137 change does not cover it: the two requests name " +
      "different prefixes.",
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
