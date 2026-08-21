#!/usr/bin/env node

// The Rails demo keeps ONE deliberate copy of packaged UI: the payment method
// grid and the focused swap panel, rebuilt on MobX Keystone state to prove
// @openreceive/browser/headless drives a checkout from a non-React store
// (app/javascript/src/app/components/checkout/**). Nothing else notices when the
// packaged wizard grows a helper the copy never mirrors, so this check compares
// the two surfaces:
//
//   1. every wizard-shaped export of @openreceive/browser/headless is either
//      referenced by the port or listed in NOT_MIRRORED with a reason,
//   2. every NOT_MIRRORED entry is still honest — the export still exists, the
//      port still does not use it, and the reason is still written down,
//   3. every runtime name the port imports from @openreceive/* still exists, and
//   4. the port READS the packaged derivations instead of re-deriving them.
//
// Rule 2 is what keeps rule 1 from rotting: the port covers a deliberately small
// slice of the packaged wizard, so the list of what it drops is the larger half
// of the contract and has to be as policed as the list of what it copies.
//
// Rules 1-3 police the port's SURFACE. Rule 4 polices its BEHAVIOUR: mirroring
// the packaged markup is the point of the port, re-implementing packaged rules
// is not, and rule 4 exists because that distinction was lost once and cost a
// payer the whole checkout panel (see the rule for the story).
//
// It reads the built dist, so run it after `npm run build:packages`.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const demoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientRoot = path.join(demoRoot, "app/javascript/src");

/** Files that together are the port of the packaged wizard. */
const PORT_FILES = [
  "app/components/CheckoutPanel.tsx",
  "app/components/checkout/MethodGrid.tsx",
  "app/components/checkout/SwapPanel.tsx",
  "app/helpers/icons.ts",
  "app/stores/CheckoutFlow.ts",
];

/**
 * Wizard vocabulary: method grid, asset/network selection, swap routing, and
 * the provider/tutorial displays. Anything matching here is part of the surface
 * the port either mirrors 1:1 or drops on purpose.
 */
const WIZARD_EXPORT_PATTERN =
  /(Wizard|MethodGrid|Network|Asset|Swap|PaymentAccent|PaymentMethods|RouteDisplays|ProviderCopy|LightningInvoice)/;

/**
 * Exports that are deliberately NOT mirrored. Add a reason when you add a name;
 * the check below refuses an empty one, a name the package no longer exports,
 * and a name the port has quietly started using again.
 */
const ROUTE_STEP_REASON =
  "route/provider/tutorial step: presentation with no store involvement, so it proves nothing " +
  "about headless-on-Keystone. The node-express and nextjs demos mount the packaged <Checkout>, " +
  "which is where that flow is demonstrated.";
const NOT_MIRRORED = new Map([
  ["createOpenReceivePaymentWizardModel", ROUTE_STEP_REASON],
  ["createOpenReceivePaymentWizardSelection", ROUTE_STEP_REASON],
  ["updateOpenReceivePaymentWizardSelection", ROUTE_STEP_REASON],
  ["createOpenReceiveWizardRouteDisplays", ROUTE_STEP_REASON],
  ["getOpenReceiveRouteNetworkLabel", ROUTE_STEP_REASON],
  ["OpenReceivePaymentWizardModel", ROUTE_STEP_REASON],
  ["OpenReceivePaymentWizardSelection", ROUTE_STEP_REASON],
  ["OpenReceiveWizardProviderDisplay", ROUTE_STEP_REASON],
  [
    "createCheckoutProviderCopyEvent",
    "emitted by the provider tutorial modal, which is part of the route step above.",
  ],
  [
    "openReceiveSwapAssetMatchesRoute",
    "matches a pay-in coin to a wizard route; the grid starts a swap from the coin directly, " +
      "so there is no route to match against.",
  ],
  [
    "createOpenReceiveSwapDisplayModel",
    "the deposit panel's view model. The port renders @openreceive/react's renderSwapDepositPanel, " +
      "which calls this itself — mirroring it would mean re-implementing the panel.",
  ],
  [
    "OpenReceiveSwapDisplayModel",
    "type of the above; the port never handles the deposit panel's view model itself.",
  ],
]);

const findings = [];

const portSources = new Map(
  PORT_FILES.map((relative) => [relative, readFileSync(path.join(clientRoot, relative), "utf8")]),
);
const portText = [...portSources.values()].join("\n");
const referencedByPort = (name) => new RegExp(`\\b${name}\\b`).test(portText);

const headless = await import("@openreceive/browser/headless");
const browser = await import("@openreceive/browser");
const react = await import("@openreceive/react");
const moduleExports = new Map([
  ["@openreceive/browser/headless", headless],
  ["@openreceive/browser", browser],
  ["@openreceive/react", react],
]);
// Types are erased from the built dist, so a type-only export can only be
// checked against the .d.ts text. The package's exports map points ./headless at
// dist/headless.js with dist/headless.d.ts beside it; if that ever stops being
// true this read throws, which is the right kind of loud.
const headlessTypes = readFileSync(
  fileURLToPath(import.meta.resolve("@openreceive/browser/headless")).replace(/\.js$/, ".d.ts"),
  "utf8",
);
const headlessExports = (name) =>
  name in headless || new RegExp(`\\b${name}\\b`).test(headlessTypes);

// 1. Packaged wizard surface -> port.
for (const name of Object.keys(headless).sort()) {
  if (!WIZARD_EXPORT_PATTERN.test(name)) continue;
  if (NOT_MIRRORED.has(name)) continue;
  if (referencedByPort(name)) continue;
  findings.push(
    `@openreceive/browser/headless exports "${name}", which the port never references.\n` +
      `  The packaged wizard gained (or renamed) a capability. Mirror it in\n` +
      `  ${PORT_FILES[1]}, or add it to NOT_MIRRORED in this script with a reason.`,
  );
}

// 2. NOT_MIRRORED -> still honest.
for (const [name, reason] of NOT_MIRRORED) {
  if (typeof reason !== "string" || reason.trim() === "") {
    findings.push(`NOT_MIRRORED entry "${name}" has no reason. Say why the port drops it.`);
  }
  if (!headlessExports(name)) {
    findings.push(
      `NOT_MIRRORED lists "${name}", which @openreceive/browser/headless no longer exports.\n` +
        `  The exemption is stale: drop the entry (or rename it) so this list keeps meaning something.`,
    );
  }
  if (referencedByPort(name)) {
    findings.push(
      `NOT_MIRRORED says the port drops "${name}", but the port references it.\n` +
        `  The port grew back. Either remove the entry, or take the code back out.`,
    );
  }
}

// 3. Port imports -> packaged exports (catches renames and removals).
const IMPORT_BLOCK = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"(@openreceive\/[^"]+)"/g;
for (const [relative, source] of portSources) {
  for (const match of source.matchAll(IMPORT_BLOCK)) {
    const [statement, specifiers, moduleId] = match;
    const packageExports = moduleExports.get(moduleId);
    if (packageExports === undefined) continue;
    // Type-only imports are erased at build time and are checked by tsc instead.
    if (statement.startsWith("import type")) continue;
    for (const specifier of specifiers.split(",")) {
      const trimmed = specifier.trim();
      if (trimmed === "" || trimmed.startsWith("type ")) continue;
      const imported = (trimmed.split(/\s+as\s+/)[0] ?? "").trim();
      if (imported === "" || imported in packageExports) continue;
      findings.push(
        `${relative} imports "${imported}" from ${moduleId}, which no longer exports it.\n` +
          `  Update the port to the current name.`,
      );
    }
  }
}

// 4. Packaged derivations -> the port reads them, never re-derives them.
//
// `createCheckoutState` runs the packaged label rule and ships the answers ON
// the state, so a store getter that formats a raw field itself is a second copy
// of a packaged rule living in a demo. That is not just duplication. The port's
// `amountLabel` used to call `formatOpenReceiveMsats(state.amount_msats)`, and
// that formatter THROWS on an amount that is not a non-negative safe integer —
// deliberately, because the wire builders and the amount validators share it.
// Read from a @computed inside an `observer`, the throw escaped render: one
// nonsense `amount_msats` from the server blanked the ENTIRE checkout panel
// instead of the one label. `createCheckoutState` puts the same value through
// the packaged display boundary and yields `undefined`, which is what the port
// wanted all along.
//
// So: any getter here named after a packaged label must be a read of that label
// off `this.state`, and the throwing formatter must not appear in the port at
// all. A display site that needs an msat label without a `CheckoutState` in hand
// wants the packaged display boundary, never the formatter.
const STORE_FILE = "app/stores/CheckoutFlow.ts";
const PACKAGED_STATE_LABELS = ["amountLabel", "fiatLabel", "paymentHashLabel"];
const THROWING_FORMATTERS = ["formatOpenReceiveMsats"];

/**
 * Port source with comments removed. Rules 1-3 match against the raw text on
 * purpose (a name explained in a comment counts as known to the port); rule 4
 * is about what the port CALLS, so it must not be satisfied — or tripped — by
 * prose. This very check is named in a comment in the store it polices.
 */
const withoutComments = (source) =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "");

const storeCode = withoutComments(portSources.get(STORE_FILE) ?? "");
const portCode = [...portSources.values()].map(withoutComments).join("\n");

/**
 * The body of `get <name>()`, brace-matched rather than line-shape-matched so
 * reformatting the store cannot quietly stop this rule from applying. Comments
 * are already gone, so the only braces here are code.
 */
function getterBody(source, name) {
  const declaration = source.search(new RegExp(`\\bget ${name}\\(`));
  if (declaration < 0) return null;
  const open = source.indexOf("{", declaration);
  let depth = 0;
  for (let index = open; index >= 0 && index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) return source.slice(open + 1, index);
  }
  return "";
}

for (const name of PACKAGED_STATE_LABELS) {
  // No getter of that name is fine — the port exposes the labels its panel
  // needs and no more. An unreadable one is NOT fine: skipping it silently is
  // how the rule stops holding without anyone noticing.
  const body = getterBody(storeCode, name);
  if (body === null) continue;
  if (new RegExp(`this\\.state\\?\\.${name}\\b`).test(body)) continue;
  findings.push(
    `${STORE_FILE} exposes "${name}" but does not read it off the packaged state.\n` +
      `  createCheckoutState already derived it; return \`this.state?.${name}\` instead of\n` +
      `  formatting the raw field again. Re-deriving is how a formatter that throws gets\n` +
      `  back into a @computed and takes the whole panel down with it.`,
  );
}

for (const name of THROWING_FORMATTERS) {
  if (!new RegExp(`\\b${name}\\b`).test(portCode)) continue;
  findings.push(
    `The port calls "${name}", which THROWS on a malformed amount. Every render path\n` +
      `  here runs inside an \`observer\`, so that throw costs the whole checkout panel.\n` +
      `  Read the label off the CheckoutState, or use the packaged display boundary.`,
  );
}

if (findings.length > 0) {
  console.error("Rails demo wizard port has drifted from the packaged wizard:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(
  `Wizard drift check passed: ${PORT_FILES.length} port files mirror the packaged method grid and ` +
    `swap panel, drop ${NOT_MIRRORED.size} named exports on purpose, and read every packaged ` +
    `label off the CheckoutState instead of re-deriving it.`,
);
