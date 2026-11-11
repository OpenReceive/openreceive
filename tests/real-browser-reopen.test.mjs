// A payer comes back: the order's state on the server, met by a browser that
// remembers nothing.
//
// The suite's lifecycle tests keep one page open from the first click to the
// receipt, against a fake wallet that answers instantly. Users found the bugs
// in what is left: the order was paid and the tab closed (issue 122), the
// second visit is on another device, and two requests overlap because a real
// wallet takes time to answer (issue 137's second half). So every case here
// opens a fresh browser context on an order that already has history, and the
// wallet answers late, as one behind a relay does.

import assert from "node:assert/strict";
import test from "node:test";
import {
  checkoutTag,
  closeEngines,
  createLab,
  documentHtml,
  launchEngine,
  openTab,
  requestedEngines,
  STANDALONE_SCRIPT,
} from "./helpers/real-browser-lab.mjs";
import { KNOWN_OPEN, whileOpen } from "./helpers/known-issues.mjs";

process.env.LOG_LEVEL ??= "error";
test.after(closeEngines);

const REFERENCE = "order-returning";
const TILE = '[data-or-method="bitcoin"]';
const PAID = /Payment (complete|received)/;
/** A wallet behind a relay: slow enough that a second request arrives while the first waits. */
const WALLET_LATENCY_MS = 150;

const open = (id) => (KNOWN_OPEN[id] === undefined ? undefined : id);

/** Count the checkout's `openreceive-settled` events; it does not bubble, so capture. */
function countSettled() {
  window.settledEvents = 0;
  document.addEventListener(
    "openreceive-settled",
    () => {
      window.settledEvents += 1;
    },
    true,
  );
}

/** The two ways a returning payer's page usually gets its tag. */
const PAGES = [
  {
    name: "tag in the HTML, as the store plugins and guides print it",
    upgradesWithPrefix: true,
    html: (attributes) =>
      documentHtml({
        body: `${checkoutTag(attributes)}\n<script type="module" src="${STANDALONE_SCRIPT}"></script>`,
      }),
  },
  {
    name: "tag created by script once the element is defined",
    upgradesWithPrefix: false,
    html: (attributes) =>
      documentHtml({
        body: `<main id="slot"></main><script type="module">
import "${STANDALONE_SCRIPT}";
const checkout = document.createElement("openreceive-checkout");
for (const [name, value] of Object.entries(${JSON.stringify(attributes)})) checkout.setAttribute(name, value);
document.getElementById("slot").appendChild(checkout);
</script>`,
      }),
  },
];

async function visit(browser, lab, html) {
  const tab = await openTab(browser, lab);
  await tab.context.addInitScript(countSettled);
  await tab.page.goto(lab.page(html));
  return tab;
}

async function labWithOrder() {
  const lab = await createLab({ prefix: "/pay", walletLatencyMs: WALLET_LATENCY_MS });
  lab.stack.addOrder(REFERENCE, 2100);
  return lab;
}

const attributes = (lab) => ({ reference: REFERENCE, prefix: lab.prefix, resumable: "true" });

/** No request the page made may have been refused, lost or complained about. */
function assertCleanVisit(tab, label) {
  assert.deepEqual(tab.seen.refused, [], `${label}: no request may be refused`);
  assert.deepEqual(tab.seen.complaints, [], `${label}: nothing may reach the console`);
}

/**
 * Issue 122, and issue 137's symptom: paid on an earlier visit, reopened where
 * nothing is remembered. The payer must land on the receipt.
 */
async function paidOrderReopened(t, browser, page) {
  const lab = await labWithOrder();
  try {
    const { checkout } = await lab.stack.postJson("/checkouts", { reference: REFERENCE });
    lab.stack.wallet.settleInvoice({ payment_hash: checkout.payment_hash });

    const tab = await visit(browser, lab, page.html(attributes(lab)));
    try {
      const element = tab.page.locator("openreceive-checkout");
      // With two prepares the first claims the wallet scan and the second,
      // answered while that scan waits on the wallet, says unpaid. Which answer
      // the page ends on depends on whether the browser sent the request it
      // aborted (Chromium does; WebKit and Firefox do not): a race, so `sometimes`.
      await whileOpen(
        t,
        page.upgradesWithPrefix ? open("issue-137") : undefined,
        async () => {
          await assert.doesNotReject(
            element.getByText(PAID).first().waitFor({ state: "visible", timeout: 5_000 }),
            "the payer already paid: the receipt must show",
          );
          assert.equal(await element.locator(TILE).count(), 0, "a paid order offers no way to pay");
          assert.equal(await element.getByRole("alert").count(), 0, "no error on the page");
          assert.equal(
            await tab.page.evaluate(() => window.settledEvents),
            1,
            "settled fires once",
          );
        },
        { sometimes: true },
      );
      assert.equal(lab.servedTo("/checkouts").length, 0, "the page must not try to mint");
      assert.equal(lab.stack.wallet.listInvoices().length, 1, "nothing new was minted");
      assert.equal(lab.stack.settlements.length, 1, "the shop was told once that it was paid");
      assertCleanVisit(tab, "the return visit");
    } finally {
      await tab.close();
    }
  } finally {
    await lab.close();
  }
}

/**
 * The invoice is open and unpaid; the payer opens the order again elsewhere
 * (phone after desktop). They must get the SAME invoice: a second one would let
 * them pay twice, and the first would stay open in the wallet. Paying it must
 * reach both places, and the shop once.
 */
async function unpaidOrderOpenedTwice(browser, page) {
  const lab = await labWithOrder();
  const tabs = [];
  try {
    for (const place of ["first", "second"]) {
      const tab = await visit(browser, lab, page.html(attributes(lab)));
      tabs.push(tab);
      const element = tab.page.locator("openreceive-checkout");
      await element.locator(TILE).click();
      await element
        .getByRole("button", { name: /Copy invoice/i })
        .first()
        .waitFor({ state: "visible", timeout: 15_000 });
      assert.equal(
        lab.stack.wallet.listInvoices().length,
        1,
        `after the ${place} place opened the order the wallet must hold one invoice`,
      );
    }
    const minted = lab
      .servedTo("/checkouts")
      .filter((entry) => entry.status === 201 || entry.status === 200)
      .map((entry) => entry.body.checkout.payment_hash);
    assert.equal(minted.length, 2, "each place asked for the invoice");
    assert.equal(new Set(minted).size, 1, "both places were handed the same invoice");

    lab.stack.wallet.settleInvoice({ payment_hash: minted[0] });
    await Promise.all(
      tabs.map((tab) =>
        tab.page
          .locator("openreceive-checkout")
          .getByText(PAID)
          .first()
          .waitFor({ state: "visible", timeout: 20_000 }),
      ),
    );
    for (const [index, tab] of tabs.entries()) {
      assert.equal(
        await tab.page.evaluate(() => window.settledEvents),
        1,
        `place ${index + 1}: settled fires once`,
      );
      assertCleanVisit(tab, `place ${index + 1}`);
    }
    assert.equal(lab.stack.settlements.length, 1, "the shop was told once that it was paid");
  } finally {
    for (const tab of tabs) await tab.close();
    await lab.close();
  }
}

for (const engine of requestedEngines()) {
  test(`${engine}: a returning payer meets the order as the server has it`, {
    concurrency: 4,
    timeout: 240_000,
  }, async (t) => {
    const { browser, skip } = await launchEngine(engine);
    if (skip !== undefined) {
      t.skip(skip);
      return;
    }
    const cases = [];
    for (const page of PAGES) {
      cases.push(
        t.test(`a paid order reopened on another device shows its receipt (${page.name})`, (st) =>
          paidOrderReopened(st, browser, page),
        ),
        t.test(
          `an unpaid order opened in a second place gets the same invoice, and both show paid (${page.name})`,
          () => unpaidOrderOpenedTwice(browser, page),
        ),
      );
    }
    await Promise.all(cases);
  });
}
