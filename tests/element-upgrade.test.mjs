// Issue #137: an element already on the page when its script defines it is
// upgraded. That is every server-rendered page (the script is a module, so it
// runs after the markup is parsed) and every wrapper that defines the element
// when it mounts. A browser then calls attributeChangedCallback once per
// attribute already present, while connected, before connectedCallback.
// happy-dom does not, so this file installs the browser's order first
// (helpers/browser-upgrade.mjs). The same mounts run in a real browser in
// tests/e2e/element-mounts.spec.ts, with innerHTML-after-define as well.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

process.env.LOG_LEVEL ??= "error";
GlobalRegistrator.register({ url: "http://upgrade.local/" });

const assert = (await import("node:assert/strict")).default;
const test = (await import("node:test")).default;
const { installBrowserUpgradeOrder } = await import("./helpers/browser-upgrade.mjs");
const { until } = await import("./helpers/lifecycle-harness.mjs");

/**
 * Every POST …/checkouts/prepare: its path, its order, and whether it was
 * aborted while in flight (as a browser reports it; an abort after the answer
 * arrived is not a failed request).
 */
const prepares = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), "http://upgrade.local");
  if (!url.pathname.endsWith("/checkouts/prepare")) return Response.json({ status: "pending" });
  const { reference } = JSON.parse(init.body);
  const entry = { path: url.pathname, reference, aborted: false };
  prepares.push(entry);
  let answered = false;
  init.signal?.addEventListener("abort", () => {
    if (!answered) entry.aborted = true;
  });
  // Slow enough that a second prepare would overlap the first, as a server's does.
  await new Promise((resolve) => setTimeout(resolve, 30));
  answered = true;
  return Response.json({ reference, amount_msats: 21_000, fiat_quote: null, payment_methods: [] });
};

// The markup a server renders, on the page before the element is defined.
document.body.innerHTML = [
  '<openreceive-checkout id="both" reference="order-both" prefix="/openreceive"></openreceive-checkout>',
  '<openreceive-checkout id="reversed" prefix="/openreceive" reference="order-reversed"></openreceive-checkout>',
  '<openreceive-checkout id="woocommerce" resumable="true" reference="order-woocommerce" prefix="/openreceive" csrf-header="X-WP-Nonce"></openreceive-checkout>',
  '<openreceive-checkout id="bare" reference="order-bare"></openreceive-checkout>',
].join("");

installBrowserUpgradeOrder();
const { defineElements } = await import("../packages/js/elements/src/index.ts");
defineElements({ logger: false });

const aborted = () => prepares.filter((entry) => entry.aborted);
const preparesFor = (reference) => prepares.filter((entry) => entry.reference === reference);
/** Time for a second prepare to show up before counting. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

test("an upgraded element prepares its order once, whatever attributes it carries", async () => {
  await until(() => prepares.length >= 4, { label: "four prepares" });
  await settle();
  assert.deepEqual(aborted(), []);
  assert.deepEqual(prepares.map((entry) => entry.reference).sort(), [
    "order-bare",
    "order-both",
    "order-reversed",
    "order-woocommerce",
  ]);
});

test("an upgraded element pointed at another order prepares that order", async () => {
  document.getElementById("both").setAttribute("reference", "order-next");
  await until(() => preparesFor("order-next").length > 0, { label: "prepare for order-next" });
  await settle();
  assert.equal(preparesFor("order-next").length, 1);
  assert.deepEqual(aborted(), []);
});

test("an upgraded element moved to another prefix prepares again there", async () => {
  document.getElementById("reversed").setAttribute("prefix", "/shop/openreceive");
  await until(() => preparesFor("order-reversed").length > 1, { label: "second prepare" });
  assert.equal(preparesFor("order-reversed").at(-1).path, "/shop/openreceive/checkouts/prepare");
  assert.deepEqual(aborted(), []);
});
