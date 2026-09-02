// The inlined payment icons: one generated source of truth
// (src/generated/payment-icon-svgs.ts), two representations derived from it,
// and the build gate that makes inlining first-party SVG markup safe.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

process.env.LOG_LEVEL ??= "error";

import {
  createAssetBaseUrlResolver,
  getNetworkIconId,
  getPaymentMethodIconId,
  getSwapOptionIconId,
  paymentIconPaths,
  paymentIconSvgs,
  paymentIconUrls,
} from "@openreceive/browser/headless";
import { assetIconIds, paymentMethodIconIds } from "../packages/js/browser/src/internal/icons.ts";
import { renderPaymentIconHtml } from "../packages/js/elements/src/payment-icon.ts";
import { inlineSvgViolations, minifySvg } from "../tools/package/generate-payment-icons.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserRoot = path.join(repoRoot, "packages/js/browser");
const DATA_URI_PREFIX = "data:image/svg+xml,";

test("every icon id maps to inline markup, a data URI and a packaged path", () => {
  const ids = Object.keys(paymentIconSvgs);
  assert.ok(ids.length >= 11);
  for (const id of ids) {
    assert.match(paymentIconSvgs[id], /^<svg\b[\s\S]*<\/svg>$/, id);
    assert.equal(paymentIconPaths[id], `assets/icons/${id}.svg`);
    assert.ok(paymentIconUrls[id].startsWith(DATA_URI_PREFIX), id);
  }
  // Every id a getter can answer exists in the table.
  for (const id of [...Object.values(paymentMethodIconIds), ...Object.values(assetIconIds)]) {
    assert.ok(id in paymentIconSvgs, id);
  }
  assert.ok("crypto" in paymentIconSvgs, "the fallback icon");
  assert.equal(getPaymentMethodIconId("bitcoin"), "btc");
  assert.equal(getNetworkIconId("Tron"), "trx");
  assert.equal(getNetworkIconId("Solana"), "sol");
  assert.equal(getNetworkIconId("Ethereum"), "eth");
  assert.equal(getNetworkIconId("Somewhere else"), "crypto");
  assert.equal(getSwapOptionIconId({ label: "USDT" }), "usdt");
  assert.equal(getSwapOptionIconId({ label: "nope" }), "crypto");
});

test("each data URI decodes back to the generated markup byte-for-byte", () => {
  for (const [id, svg] of Object.entries(paymentIconSvgs)) {
    const payload = paymentIconUrls[id].slice(DATA_URI_PREFIX.length);
    assert.equal(decodeURIComponent(payload), svg, id);
    // Percent-encoded, not base64, and nothing that breaks a URL or an HTML
    // attribute survives unencoded.
    assert.doesNotMatch(payload, /base64/);
    assert.doesNotMatch(payload, /[#"<>]/, id);
  }
});

test("the source .svg files still ship as files, keyed by paymentIconPaths", () => {
  // Back-compat promise: a host with an existing copy/serve setup keeps
  // working. The packaged dist is asserted by tools/validate/package-smoke.mjs;
  // this pins the source tree the build copies from.
  const files = readdirSync(path.join(browserRoot, "src/assets/icons"))
    .filter((file) => file.endsWith(".svg"))
    .sort();
  assert.deepEqual(
    files,
    Object.keys(paymentIconSvgs)
      .sort()
      .map((id) => `${id}.svg`),
  );
  for (const file of files) {
    assert.ok(existsSync(path.join(browserRoot, "src/assets/icons", file)));
  }
});

test("the inline-SVG gate refuses what must never be injected", () => {
  const safe = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><use href="#a"/></svg>';
  assert.deepEqual(inlineSvgViolations(safe), []);
  for (const [fixture, reason] of [
    ['<svg onload="alert(1)"><circle r="1"/></svg>', /on\*=/],
    ["<svg><script>alert(1)</script></svg>", /<script>/],
    ["<svg><foreignObject><div>x</div></foreignObject></svg>", /foreignObject/],
    ['<svg><use href="https://evil.example/x.svg#a"/></svg>', /external href/],
    ['<svg><use xlink:href="//evil.example/x.svg#a"/></svg>', /external href/],
    ['<svg><image href="https://evil.example/x.png"/></svg>', /<image>/],
    ["<svg><style>:host{display:none}</style></svg>", /<style>/],
    ['<svg><a href="javascript:alert(1)">x</a></svg>', /javascript:/],
  ]) {
    const violations = inlineSvgViolations(fixture);
    assert.ok(violations.length > 0, fixture);
    assert.ok(
      violations.some((v) => reason.test(v)),
      `${fixture}: ${violations}`,
    );
  }
  // And what actually ships passes it.
  for (const [id, svg] of Object.entries(paymentIconSvgs)) {
    assert.deepEqual(inlineSvgViolations(svg), [], id);
  }
});

test("minification is whitespace-only", () => {
  const source =
    '<svg xmlns="http://www.w3.org/2000/svg">\n  <!-- c -->\n  <g>\n    <path d="M1 1"/>\n  </g>\n</svg>\n';
  assert.equal(
    minifySvg(source),
    '<svg xmlns="http://www.w3.org/2000/svg"><g><path d="M1 1"/></g></svg>',
  );
});

test("the element draws the icon inline unless the host resolves files", () => {
  const inline = renderPaymentIconHtml("lightning", { className: "or-x", label: "Lightning" });
  assert.match(inline, /^<svg\b/);
  assert.match(inline, /class="or-x"/);
  assert.match(inline, /role="img" aria-label="Lightning"/);
  // The source's own standalone label is replaced, not doubled.
  assert.equal(inline.match(/aria-label=/g).length, 1);
  assert.equal(inline.match(/role=/g).length, 1);
  assert.doesNotMatch(inline, /<img/);
  // The label is attribute-escaped like every other string in the tree.
  assert.match(
    renderPaymentIconHtml("btc", { className: "c", label: 'a"<b>' }),
    /aria-label="a&quot;&lt;b&gt;"/,
  );

  const served = renderPaymentIconHtml("lightning", {
    className: "or-x",
    label: "Lightning",
    resolveAssetUrl: createAssetBaseUrlResolver("/or-assets"),
  });
  assert.equal(served, '<img class="or-x" alt="" src="/or-assets/assets/icons/lightning.svg">');
});
