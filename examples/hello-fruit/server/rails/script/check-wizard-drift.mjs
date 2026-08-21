#!/usr/bin/env node

// The Rails demo hand-ports the @openreceive/react payment wizard onto MobX
// Keystone state (app/javascript/src/app/components/checkout/**). Nothing else
// notices when the packaged wizard grows a helper the port never mirrors, so
// this check compares the two surfaces:
//
//   1. every wizard-shaped export of @openreceive/browser/headless is
//      referenced by the port, and
//   2. every runtime name the port imports from @openreceive/* still exists.
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
  "app/components/checkout/MethodWizard.tsx",
  "app/components/checkout/SwapPanel.tsx",
  "app/helpers/icons.ts",
  "app/stores/CheckoutFlow.ts",
];

/**
 * Wizard vocabulary: method grid, asset/network selection, swap routing, and
 * the provider/tutorial displays. Anything matching here is part of the surface
 * the port claims to mirror 1:1.
 */
const WIZARD_EXPORT_PATTERN =
  /(Wizard|MethodGrid|Network|Asset|Swap|PaymentAccent|PaymentMethods|RouteDisplays|ProviderCopy|LightningInvoice)/;

/** Exports that are deliberately NOT mirrored. Add a reason when you add a name. */
const NOT_MIRRORED = new Map([
  // Element/React-only helpers have no place in a headless port.
]);

const findings = [];

const portSources = new Map(
  PORT_FILES.map((relative) => [relative, readFileSync(path.join(clientRoot, relative), "utf8")]),
);
const portText = [...portSources.values()].join("\n");

const headless = await import("@openreceive/browser/headless");
const browser = await import("@openreceive/browser");
const react = await import("@openreceive/react");
const moduleExports = new Map([
  ["@openreceive/browser/headless", headless],
  ["@openreceive/browser", browser],
  ["@openreceive/react", react],
]);

// 1. Packaged wizard surface -> port.
for (const name of Object.keys(headless).sort()) {
  if (!WIZARD_EXPORT_PATTERN.test(name)) continue;
  if (NOT_MIRRORED.has(name)) continue;
  if (new RegExp(`\\b${name}\\b`).test(portText)) continue;
  findings.push(
    `@openreceive/browser/headless exports "${name}", which the wizard port never references.\n` +
      `  The packaged wizard gained (or renamed) a capability. Mirror it in\n` +
      `  ${PORT_FILES[1]}, or add it to NOT_MIRRORED in this script with a reason.`,
  );
}

// 2. Port imports -> packaged exports (catches renames and removals).
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

if (findings.length > 0) {
  console.error("Rails demo wizard port has drifted from the packaged wizard:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(
  `Wizard drift check passed: the Rails demo port mirrors the packaged wizard surface across ${PORT_FILES.length} files.`,
);
