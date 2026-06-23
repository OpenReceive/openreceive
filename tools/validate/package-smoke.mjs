#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import {
  buildOpenReceivePackageTarballs,
  localPackageDependency,
  runNpm
} from "../package/build-artifacts.mjs";

const root = process.cwd();
const npmTimeoutMs = Number(process.env.OPENRECEIVE_PACKAGE_SMOKE_NPM_TIMEOUT_MS ?? 120_000);
const localSmokeDependencies = new Set([
  "commander",
  "d3-array",
  "d3-geo",
  "react",
  "topojson-client",
  "world-atlas"
]);

const importChecks = {
  "@openreceive/angular": "typeof mod.createOpenReceiveAngularCheckoutBinding === 'function' && typeof mod.createOpenReceiveAngularCheckoutShellBinding === 'function' && typeof mod.createOpenReceiveAngularCheckoutComponentModel === 'function' && typeof mod.createOpenReceiveAngularCheckoutController === 'function' && typeof mod.createOpenReceiveAngularThemeBinding === 'function' && typeof mod.createOpenReceiveAngularStoredThemeBinding === 'function' && typeof mod.createOpenReceiveAngularThemeToggleBinding === 'function' && typeof mod.createCheckoutElement === 'function' && typeof mod.createOpenReceiveThemeToggleElement === 'function' && typeof mod.createCheckoutShell === 'function' && typeof mod.toggleOpenReceiveStoredThemeControls === 'function'",
  "@openreceive/browser": "typeof mod.createInvoice === 'function' && typeof mod.status === 'function' && typeof mod.lightningUri === 'function' && typeof mod.qrSvg === 'function' && typeof mod.qrPngDataUrl === 'function' && typeof mod.copyInvoice === 'function' && typeof mod.openWallet === 'function' && typeof mod.createCheckoutController === 'function' && mod.createOpenReceiveInvoice === undefined && mod.createLightningUri === undefined && mod.CheckoutWatcher === undefined && mod.OpenReceiveBrowserCheckoutController === undefined && mod.createCheckoutElement === undefined",
  "@openreceive/core": "typeof mod.createIdempotencyRequestHash === 'function'",
  "@openreceive/elements": "typeof mod.renderCheckoutHtml === 'function' && typeof mod.renderOpenReceiveThemeToggleHtml === 'function' && mod.OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME === 'openreceive-theme-toggle'",
  "@openreceive/next": "Object.keys(mod).length === 0",
  "@openreceive/node": "typeof mod.createOpenReceive === 'function' && typeof mod.createNwcReceiveClient === 'function' && mod.mountExpressRoutes === undefined && mod.createFetchHandler === undefined && mod.createNodeHandler === undefined && mod.createNodeRuntime === undefined && typeof mod.createOpenReceivePostgresInvoiceStore === 'function' && typeof mod.createOpenReceivePostgresInvoiceStoreFromPool === 'function' && typeof mod.createOpenReceiveSqliteInvoiceStore === 'function' && mod.OPENRECEIVE_DATABASE_SCHEMA_VERSION === 'v0.1' && typeof mod.OPENRECEIVE_SQLITE_MIGRATION_SQL === 'string' && mod.runOpenReceiveCli === undefined",
  "@openreceive/provider-data": "typeof mod.getProviderRegistryMetadata === 'function'",
  "@openreceive/react": "typeof mod.createCheckoutViewModel === 'function' && typeof mod.ThemeScope === 'function' && typeof mod.CheckoutProvider === 'function' && typeof mod.useCheckoutContext === 'function'",
  "@openreceive/svelte": "typeof mod.createOpenReceiveSvelteCheckoutBinding === 'function' && typeof mod.createOpenReceiveSvelteCheckoutShellBinding === 'function' && typeof mod.createOpenReceiveSvelteCheckoutComponentModel === 'function' && typeof mod.createOpenReceiveSvelteCheckoutController === 'function' && typeof mod.createOpenReceiveSvelteThemeBinding === 'function' && typeof mod.createOpenReceiveSvelteStoredThemeBinding === 'function' && typeof mod.createOpenReceiveSvelteThemeToggleBinding === 'function' && typeof mod.createCheckoutElement === 'function' && typeof mod.createOpenReceiveThemeToggleElement === 'function' && typeof mod.createCheckoutShell === 'function' && typeof mod.syncOpenReceiveStoredThemeControls === 'function' && typeof mod.applyCheckoutThemeAttributes === 'function'",
  "@openreceive/testkit": "typeof mod.createTestkitReceiveClient === 'function'",
  "@openreceive/vue": "typeof mod.createOpenReceiveVueCheckoutBinding === 'function' && typeof mod.createOpenReceiveVueCheckoutShellBinding === 'function' && typeof mod.createOpenReceiveVueCheckoutComponentModel === 'function' && typeof mod.createOpenReceiveVueCheckoutController === 'function' && typeof mod.createOpenReceiveVueThemeBinding === 'function' && typeof mod.createOpenReceiveVueStoredThemeBinding === 'function' && typeof mod.createOpenReceiveVueThemeToggleBinding === 'function' && typeof mod.createCheckoutElement === 'function' && typeof mod.createOpenReceiveThemeToggleElement === 'function' && typeof mod.createCheckoutShell === 'function' && typeof mod.syncOpenReceiveStoredThemeControls === 'function' && typeof mod.applyOpenReceiveThemeAttributes === 'function'"
};

function writeInstallProject(installDir, tarballs) {
  const dependencies = Object.fromEntries(
    tarballs.map(({ name, tarball }) => [name, `file:${tarball}`])
  );

  for (const dependency of localSmokeDependencies) {
    dependencies[dependency] ??= localPackageDependency(root, dependency);
  }

  writeFileSync(
    path.join(installDir, "package.json"),
    JSON.stringify(
      {
        name: "openreceive-package-smoke",
        private: true,
        type: "module",
        dependencies
      },
      null,
      2
    )
  );
}

function writeImportSmoke(installDir, packages) {
  const checks = packages.map(({ manifest }) => {
    const check = importChecks[manifest.name];
    assert(check !== undefined, `${manifest.name}: missing package smoke import check`);
    return {
      name: manifest.name,
      check
    };
  });

  writeFileSync(
    path.join(installDir, "smoke.mjs"),
    `import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as browserInternal from "@openreceive/browser/internal";
import { openReceiveCountryMapLandPaths } from "@openreceive/browser/country-map";

const checks = ${JSON.stringify(checks, null, 2)};

assert(
  openReceiveCountryMapLandPaths.length > 0,
  "@openreceive/browser/country-map: land paths must be importable"
);
assert(
  typeof browserInternal.CheckoutWatcher === "function" &&
    typeof browserInternal.createCheckoutElement === "function" &&
    typeof browserInternal.createCheckoutShell === "function" &&
    typeof browserInternal.createOpenReceiveLookupInvoiceFetcher === "function" &&
    typeof browserInternal.openReceiveCheckoutElementStyles === "string",
  "@openreceive/browser/internal: framework adapter internals must be importable"
);

for (const item of checks) {
  const mod = await import(item.name);
  assert(
    Function("mod", \`return \${item.check};\`)(mod),
    \`\${item.name}: import check failed\`
  );
}

const browserStylesPath = "node_modules/@openreceive/browser/dist/styles.css";
assert(existsSync(browserStylesPath), "@openreceive/browser: styles.css export must be packaged");
assert(
  readFileSync(browserStylesPath, "utf8").includes("[data-openreceive-checkout]"),
  "@openreceive/browser: styles.css must contain checkout styles"
);
for (const packageName of ["elements", "react", "vue", "svelte", "angular"]) {
  const stylesPath = \`node_modules/@openreceive/\${packageName}/dist/styles.css\`;
  assert(existsSync(stylesPath), \`@openreceive/\${packageName}: styles.css export must be packaged\`);
  assert(
    readFileSync(stylesPath, "utf8").includes("@openreceive/browser/styles.css"),
    \`@openreceive/\${packageName}: styles.css must import the shared browser styles\`
  );
}
assert(
  existsSync("node_modules/@openreceive/browser/dist/assets/icons/btc.svg"),
  "@openreceive/browser: checkout icon assets must be packaged"
);
assert(
  existsSync("node_modules/@openreceive/browser/dist/assets/icons/card.svg"),
  "@openreceive/browser: fiat method icon assets must be packaged"
);
assert(
  existsSync("node_modules/@openreceive/vue/dist/Checkout.vue"),
  "@openreceive/vue: checkout Vue component must be packaged"
);
assert(
  existsSync("node_modules/@openreceive/svelte/dist/Checkout.svelte"),
  "@openreceive/svelte: checkout Svelte component must be packaged"
);
assert(
  existsSync("node_modules/@openreceive/angular/dist/openreceive-checkout.component.mjs"),
  "@openreceive/angular: checkout Angular component must be packaged"
);
const nodeCliPath = "node_modules/@openreceive/node/bin/openreceive.mjs";
const nodeCli = await import("@openreceive/node/cli");
assert(
  typeof nodeCli.runOpenReceiveCli === "function",
  "@openreceive/node/cli: CLI runner must be importable from the CLI subpath"
);
assert(existsSync(nodeCliPath), "@openreceive/node: CLI bin must be packaged");
assert(
  execFileSync(process.execPath, [nodeCliPath, "help"], { encoding: "utf8" }).includes("Usage: openreceive"),
  "@openreceive/node: CLI bin must run help"
);

console.log(\`Imported \${checks.length} OpenReceive package tarballs.\`);
`
  );
}

function runImportSmoke(installDir) {
  return execFileSync(process.execPath, ["smoke.mjs"], {
    cwd: installDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function main() {
  let workspace;

  try {
    const result = buildOpenReceivePackageTarballs({
      root,
      npmTimeoutMs
    });
    workspace = result.workspace;
    const installDir = path.join(workspace.baseDir, "install");
    mkdirSync(installDir, { recursive: true });

    writeInstallProject(installDir, result.tarballs);
    console.error("installing package smoke project");
    runNpm(
      [
        "install",
        "--ignore-scripts",
        "--legacy-peer-deps",
        "--package-lock=false"
      ],
      installDir,
      workspace.cacheDir,
      npmTimeoutMs
    );
    writeImportSmoke(installDir, result.packages);
    console.error("running package import smoke");
    const output = runImportSmoke(installDir);
    process.stdout.write(output);
    console.log(`Package smoke passed for ${result.packages.length} package(s).`);
  } finally {
    if (
      workspace !== undefined &&
      workspace.temporary &&
      process.env.OPENRECEIVE_KEEP_PACKAGE_SMOKE !== "1"
    ) {
      rmSync(workspace.baseDir, { recursive: true, force: true });
    } else if (workspace !== undefined) {
      console.error(`package smoke workspace kept at ${workspace.baseDir}`);
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
