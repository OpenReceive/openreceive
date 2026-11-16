// Price first, in a real browser: what the picker puts on the wire, and where
// it puts Continue.
//
// A coin tile only selects. The payer is shown what the order costs in that
// coin, from a quote that opens nothing at the swap provider, and the swap
// starts on Continue. tests/element-lifecycle.test.mjs and
// tests/react-checkout-behavior.test.mjs pin that rule under happy-dom. What
// happy-dom cannot say is here: that the browser really sends no swap start,
// that Continue does not move when the amount arrives a moment after the
// click (happy-dom has no layout), and that the rebuilt shadow tree keeps the
// keyboard on Continue, so the Enter a payer presses next still pays.

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

process.env.LOG_LEVEL ??= "error";
test.after(closeEngines);

const REFERENCE = "order-price-first";
// Eight decimals, as a provider quotes them. The amount line shows four
// significant digits; the longest line here is the one a phone has to fit.
const PAY_AMOUNTS = { SOL_SOL: "0.04213457", USDT_TRON: "12.50000000", USDT_ETH: "1250.12345678" };
const SOL_LINE = "≈ 0.04213 SOL";
const TRON_LINE = "≈ 12.50 USDT · Tron";
const ETHEREUM_LINE = "≈ 1250.12 USDT · Ethereum";

/**
 * Two widths, because the review step is drawn twice and CSS shows one: under
 * its own tile when the tiles are in one column, under the whole grid
 * otherwise. 300px is a 320px phone with a little page margin, the narrowest
 * place the amount line has to stay on one line.
 *
 * The third is the first again in a wide system font. DejaVu Sans is the
 * default sans-serif on many Linux desktops and on the CI runners, and in it
 * the longest line here is a third wider than in Noto Sans or San Francisco.
 * It wrapped, and Continue dropped a line when the payer switched network: a
 * failure that only the CI machine's fonts showed. Naming the font makes every
 * machine that has it run the case; one that lacks it falls back to its own
 * sans-serif, which the first layout already covers.
 */
const LAYOUTS = [
  { name: "one column of tiles", width: 300 },
  { name: "a grid of tiles", width: 620 },
  {
    name: "one column of tiles in a wide system font",
    width: 300,
    font: '"DejaVu Sans", sans-serif',
  },
];

/** A lab whose quote answers only when the test says so. */
async function visit(browser, { width, font }) {
  const lab = await createLab({ swapPayAmounts: PAY_AMOUNTS });
  lab.stack.addOrder(REFERENCE, 21_000);
  const tab = await openTab(browser, lab, { viewport: { width: width + 40, height: 1200 } });
  const quotes = [];
  await tab.page.route(`**${lab.prefix}/swaps/quote`, (route) => {
    quotes.push(route);
  });
  await tab.page.goto(
    lab.page(
      documentHtml({
        body: `${font === undefined ? "" : `<style>openreceive-checkout { font-family: ${font}; }</style>`}<div style="width: ${width}px">${checkoutTag({ reference: REFERENCE })}</div>
<script type="module" src="${STANDALONE_SCRIPT}"></script>`,
      }),
    ),
  );
  const checkout = tab.page.locator("openreceive-checkout");
  return {
    lab,
    tab,
    checkout,
    // `getByRole` skips the copy CSS has hidden.
    next: checkout.getByRole("button", { name: /^(Continue|Preparing payment)/ }),
    estimate: checkout.locator('[part="method-estimate"]').filter({ visible: true }),
    /** Let every held quote through, and wait for nothing: the page says when it landed. */
    async answerQuotes() {
      for (const route of quotes.splice(0)) await route.continue();
    },
    heldQuotes: () => quotes.length,
    /** Which picker control has the keyboard, by its data attribute. */
    focused: () =>
      tab.page.evaluate(() => {
        const active = document.querySelector("openreceive-checkout").shadowRoot.activeElement;
        if (active === null) return null;
        return active.hasAttribute("data-or-picker-continue")
          ? "continue"
          : (active.getAttribute("data-or-picker-select") ?? active.tagName);
      }),
    async close() {
      await tab.close();
      await lab.close();
    },
  };
}

const sameBox = (before, after, what) =>
  assert.deepEqual(
    Object.fromEntries(Object.entries(after).map(([key, value]) => [key, Math.round(value)])),
    Object.fromEntries(Object.entries(before).map(([key, value]) => [key, Math.round(value)])),
    what,
  );

for (const engine of requestedEngines()) {
  for (const layout of LAYOUTS) {
    test(`${engine}, ${layout.name}: a coin tile prices the order, starts nothing, and Continue stays put`, async (t) => {
      const { browser, skip } = await launchEngine(engine);
      if (skip !== undefined) return t.skip(skip);
      const page = await visit(browser, layout);
      const { lab, checkout, next, estimate } = page;
      try {
        await checkout.getByRole("button", { name: /^SOL/ }).click();
        // The quote is out and held. Continue is already usable, and the
        // amount line already has its height, with a spinner in it.
        await next.waitFor({ state: "visible", timeout: 15_000 });
        await assert.doesNotReject(
          estimate.locator('[part="spinner"]').waitFor({ state: "visible", timeout: 5_000 }),
          "the amount line shows the quote is on its way",
        );
        assert.equal(await next.isEnabled(), true, "Continue never waits for the quote");
        assert.equal(page.heldQuotes(), 1, "the tile asked for one quote");
        const before = await next.boundingBox();
        await next.focus();
        assert.equal(await page.focused(), "continue");

        await page.answerQuotes();
        await estimate
          .getByText(SOL_LINE, { exact: true })
          .waitFor({ state: "visible", timeout: 5_000 });
        sameBox(before, await next.boundingBox(), "Continue must not move when the amount arrives");
        assert.equal(await page.focused(), "continue", "and the keyboard is still on it");

        // The payer looked, and nothing was started for them.
        assert.equal(lab.servedTo("/swaps/quote").length, 1);
        assert.equal(lab.servedTo("/swaps").length, 0, "no swap start reached the server");
        assert.equal(lab.stack.swapProvider.createCalls, 0, "no order at the swap provider");
        assert.equal((await page.tab.fetches("/swaps")).length, 0, "the page did not even ask");

        // Continue, from the keyboard: the one thing that starts the swap. Its
        // own quote is held like the first, so let it through.
        await page.tab.page.keyboard.press("Enter");
        await assert.doesNotReject(
          (async () => {
            const deadline = Date.now() + 10_000;
            while (page.heldQuotes() === 0 && Date.now() < deadline) {
              await page.tab.page.waitForTimeout(20);
            }
            await page.answerQuotes();
            await checkout
              .getByText(/SOL on the Solana network/)
              .first()
              .waitFor({ state: "visible", timeout: 10_000 });
          })(),
          "Continue opens the deposit instructions",
        );
        assert.equal(lab.servedTo("/swaps").length, 1, "Continue starts exactly one swap");
        assert.equal(lab.stack.swapProvider.createCalls, 1);
        assert.deepEqual(page.tab.seen.complaints, [], "nothing complained in the console");
      } finally {
        await page.close();
      }
    });

    test(`${engine}, ${layout.name}: choosing a network fills the amount in without moving Continue`, async (t) => {
      const { browser, skip } = await launchEngine(engine);
      if (skip !== undefined) return t.skip(skip);
      const page = await visit(browser, layout);
      const { lab, checkout, next, estimate } = page;
      const network = (name) =>
        checkout
          .getByRole("group", { name: "Choose USDT network" })
          .getByRole("button", { name, exact: true });
      try {
        await checkout.getByRole("button", { name: /^USDT/ }).click();
        await network("Tron").waitFor({ state: "visible", timeout: 15_000 });
        // No network yet: nothing to quote, nothing to continue with, and the
        // amount line is already holding its place.
        assert.equal(await next.isDisabled(), true);
        assert.equal(page.heldQuotes(), 0);
        const before = await next.boundingBox();

        await network("Tron").click();
        await estimate.locator('[part="spinner"]').waitFor({ state: "visible", timeout: 5_000 });
        sameBox(before, await next.boundingBox(), "choosing a network must not move Continue");
        await page.answerQuotes();
        await estimate
          .getByText(TRON_LINE, { exact: true })
          .waitFor({ state: "visible", timeout: 5_000 });
        sameBox(before, await next.boundingBox(), "nor the amount arriving");
        assert.equal(await next.isEnabled(), true);

        await network("Ethereum").click();
        await page.answerQuotes();
        await estimate
          .getByText(ETHEREUM_LINE, { exact: true })
          .waitFor({ state: "visible", timeout: 5_000 });
        sameBox(before, await next.boundingBox(), "nor switching network");

        assert.deepEqual(
          lab.servedTo("/swaps/quote").map((entry) => entry.status),
          [200, 200],
          "one quote per network chosen",
        );
        assert.equal(lab.servedTo("/swaps").length, 0, "no swap start reached the server");
        assert.equal(lab.stack.swapProvider.createCalls, 0, "no order at the swap provider");
        assert.deepEqual(page.tab.seen.complaints, []);
      } finally {
        await page.close();
      }
    });
  }
}
