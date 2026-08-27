// The packaged-asset `file:` warning, and the one thing it must never do: fire
// at someone who did it right.
//
// The three packaged URL tables (`providerIconUrls`, `payTutorialUrls`,
// `paymentIconUrls`) used to resolve every entry eagerly with
// `Object.fromEntries`, which called `assetUrl` — and therefore
// `warnOnFileAssetUrl` — at IMPORT time, before any host resolver could be
// consulted. A host serving the packaged `dist/assets` trees itself and passing
// `resolveAssetUrl` to every display builder (so the tables are never read) got
// a console warning saying its icons "cannot load", about icons that loaded
// fine. That inverts the warning: nobody reading their own console could tell a
// correct integration from a broken one.
//
// Nothing here may import the packaged modules at the top level: the whole
// assertion is about what happens ON import, so the console spy has to be in
// place first. That is also why this lives in its own file — node's test runner
// gives each file its own process.
import assert from "node:assert/strict";
import test from "node:test";

process.env.LOG_LEVEL ??= "error";

/** `warnOnFileAssetUrl` stays quiet outside a document; these tests want it loud. */
function installDocument() {
  globalThis.window ??= /** @type {never} */ ({});
  globalThis.document ??= /** @type {never} */ ({});
}

function captureWarnings() {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => {
    warnings.push(args.join(" "));
  };
  return { warnings, restore: () => (console.warn = original) };
}

test("importing the packaged URL tables warns about nothing", async () => {
  installDocument();
  const spy = captureWarnings();
  try {
    const providerData = await import("@openreceive/provider-data");
    const headless = await import("@openreceive/browser/headless");
    // Every table is present and enumerable — the shape did not change.
    assert.ok(Object.keys(providerData.providerIconUrls).length > 0);
    assert.ok(Object.keys(providerData.payTutorialUrls).length > 0);
    assert.ok(Object.keys(headless.paymentIconUrls).length > 0);
    assert.deepEqual(
      spy.warnings,
      [],
      "importing must not warn: a host with a resolver never reads these",
    );

    // Lazy, concretely: each entry is an accessor, so nothing resolved above.
    for (const [table, key] of [
      [providerData.providerIconUrls, "assets/provider-icons/strike.png"],
      [providerData.payTutorialUrls, "assets/pay_tutorials/strike-1.webp"],
      [headless.paymentIconUrls, "btc"],
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(table, key);
      assert.equal(typeof descriptor?.get, "function", key);
      assert.equal(descriptor.enumerable, true, key);
    }
    // A key nobody packaged still answers undefined rather than throwing.
    assert.equal(providerData.providerIconUrls["assets/provider-icons/nope.png"], undefined);
  } finally {
    spy.restore();
  }
});

test("reading a packaged URL without a resolver is what warns", async () => {
  installDocument();
  const spy = captureWarnings();
  try {
    const { providerIconUrls } = await import("@openreceive/provider-data");
    // From source (and from any bundler that leaves `import.meta.url` alone)
    // this resolves to `file:` — the case the warning exists for.
    const url = providerIconUrls["assets/provider-icons/strike.png"];
    assert.match(url, /^file:/);
    assert.equal(spy.warnings.length, 1, "the read is the trigger, and it fires once");
    assert.match(spy.warnings[0], /Packaged asset/);
    assert.match(spy.warnings[0], /provider-registry\.md/);
    // Once, not once per entry: a broken bundler would otherwise print 68 of
    // these and bury everything else in the console.
    providerIconUrls["assets/provider-icons/kraken.png"];
    assert.equal(spy.warnings.length, 1);
  } finally {
    spy.restore();
  }
});
