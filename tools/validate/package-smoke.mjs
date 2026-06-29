#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildOpenReceivePackageTarballs,
  localPackageDirectory,
  localPackageDependency,
} from "../package/build-artifacts.mjs";

const root = process.cwd();
const npmTimeoutMs = Number(process.env.OPENRECEIVE_PACKAGE_SMOKE_NPM_TIMEOUT_MS ?? 120_000);
const localSmokeDependencies = new Set([
  "@getalby/sdk",
  "commander",
  "d3-array",
  "d3-geo",
  "qrcode",
  "react",
  "topojson-client",
  "world-atlas",
]);

const importChecks = {
  "@openreceive/angular":
    "typeof mod.createOpenReceiveAngularCheckoutBinding === 'function' && typeof mod.createOpenReceiveAngularCheckoutShellBinding === 'function' && typeof mod.createOpenReceiveAngularCheckoutComponentModel === 'function' && typeof mod.createOpenReceiveAngularCheckoutController === 'function' && typeof mod.createOpenReceiveAngularThemeBinding === 'function' && typeof mod.createOpenReceiveAngularStoredThemeBinding === 'function' && typeof mod.createOpenReceiveAngularThemeToggleBinding === 'function' && typeof mod.createCheckoutElement === 'function' && typeof mod.createOpenReceiveThemeToggleElement === 'function' && typeof mod.createCheckoutShell === 'function' && typeof mod.toggleOpenReceiveStoredThemeControls === 'function'",
  "@openreceive/browser":
    "typeof mod.requestCheckout === 'function' && typeof mod.status === 'function' && typeof mod.lightningUri === 'function' && typeof mod.qrSvg === 'function' && typeof mod.qrPngDataUrl === 'function' && typeof mod.copyInvoice === 'function' && typeof mod.openWallet === 'function' && typeof mod.createCheckoutController === 'function'",
  "@openreceive/core": "typeof mod.createIdempotencyRequestHash === 'function'",
  "@openreceive/elements":
    "typeof mod.renderCheckoutHtml === 'function' && typeof mod.renderOpenReceiveThemeToggleHtml === 'function' && mod.OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME === 'openreceive-theme-toggle'",
  "@openreceive/node":
    "typeof mod.createOpenReceive === 'function' && typeof mod.OpenReceiveServiceError === 'function' && typeof mod.OpenReceiveConfigError === 'function' && typeof mod.createNwcReceiveClient === 'function' && typeof mod.createOpenReceivePostgresInvoiceStore === 'function' && typeof mod.createOpenReceivePostgresInvoiceStoreFromPool === 'function' && typeof mod.createOpenReceiveSqliteInvoiceStore === 'function' && mod.OPENRECEIVE_DATABASE_SCHEMA_VERSION === 'v0.2' && typeof mod.OPENRECEIVE_SQLITE_MIGRATION_SQL === 'string'",
  "@openreceive/provider-data":
    "typeof mod.getProviderRegistryMetadata === 'function' && typeof mod.providerIconUrl === 'function' && typeof mod.providerTutorialUrl === 'function' && mod.providerIconUrl(mod.providerRegistry.providers.strike).includes('assets/provider-icons/strike.png') && mod.providerTutorialUrl(mod.providerRegistry.providers.kraken.tutorials[3]).includes('assets/pay_tutorials/kraken-4.webp')",
  "@openreceive/react":
    "typeof mod.createCheckoutViewModel === 'function' && typeof mod.ThemeScope === 'function' && typeof mod.ThemeToggle === 'function' && typeof mod.PaymentWizard === 'function' && typeof mod.WaitingState === 'function' && typeof mod.useTheme === 'function' && typeof mod.CheckoutProvider === 'function' && typeof mod.useCheckoutContext === 'function' && mod.OpenReceiveThemeToggle === undefined && mod.OpenReceivePaymentWizard === undefined && mod.OpenReceiveWaitingState === undefined && mod.useOpenReceiveTheme === undefined",
  "@openreceive/svelte":
    "typeof mod.createOpenReceiveSvelteCheckoutBinding === 'function' && typeof mod.createOpenReceiveSvelteCheckoutShellBinding === 'function' && typeof mod.createOpenReceiveSvelteCheckoutComponentModel === 'function' && typeof mod.createOpenReceiveSvelteCheckoutController === 'function' && typeof mod.createOpenReceiveSvelteThemeBinding === 'function' && typeof mod.createOpenReceiveSvelteStoredThemeBinding === 'function' && typeof mod.createOpenReceiveSvelteThemeToggleBinding === 'function' && typeof mod.createCheckoutElement === 'function' && typeof mod.createOpenReceiveThemeToggleElement === 'function' && typeof mod.createCheckoutShell === 'function' && typeof mod.syncOpenReceiveStoredThemeControls === 'function' && typeof mod.applyCheckoutThemeAttributes === 'function'",
  "@openreceive/testkit": "typeof mod.createTestkitReceiveClient === 'function'",
  "@openreceive/vue":
    "typeof mod.createOpenReceiveVueCheckoutBinding === 'function' && typeof mod.createOpenReceiveVueCheckoutShellBinding === 'function' && typeof mod.createOpenReceiveVueCheckoutComponentModel === 'function' && typeof mod.createOpenReceiveVueCheckoutController === 'function' && typeof mod.createOpenReceiveVueThemeBinding === 'function' && typeof mod.createOpenReceiveVueStoredThemeBinding === 'function' && typeof mod.createOpenReceiveVueThemeToggleBinding === 'function' && typeof mod.createCheckoutElement === 'function' && typeof mod.createOpenReceiveThemeToggleElement === 'function' && typeof mod.createCheckoutShell === 'function' && typeof mod.syncOpenReceiveStoredThemeControls === 'function' && typeof mod.applyOpenReceiveThemeAttributes === 'function'",
  openreceive: "Object.keys(mod).length === 0",
};

function writeInstallProject(installDir, tarballs) {
  const dependencies = Object.fromEntries(
    tarballs.map(({ name, tarball }) => [name, `file:${tarball}`]),
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
        dependencies,
      },
      null,
      2,
    ),
  );
}

function packageInstallPath(installDir, packageName) {
  return path.join(installDir, "node_modules", ...packageName.split("/"));
}

function extractPackageTarball(tarball, destination) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", destination, "--strip-components=1"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function linkLocalDependency(installDir, packageName) {
  const target = localPackageDirectory(root, packageName);
  const linkPath = packageInstallPath(installDir, packageName);
  rmSync(linkPath, { recursive: true, force: true });
  mkdirSync(path.dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath, "dir");
}

function assembleOfflineInstall(installDir, tarballs) {
  mkdirSync(path.join(installDir, "node_modules"), { recursive: true });
  for (const { name, tarball } of tarballs) {
    extractPackageTarball(tarball, packageInstallPath(installDir, name));
  }
  for (const dependency of localSmokeDependencies) {
    linkLocalDependency(installDir, dependency);
  }
}

function writeImportSmoke(installDir, packages) {
  const checks = packages.map(({ manifest }) => {
    const check = importChecks[manifest.name];
    assert(check !== undefined, `${manifest.name}: missing package smoke import check`);
    return {
      name: manifest.name,
      check,
    };
  });

  writeFileSync(
    path.join(installDir, "smoke.mjs"),
    `import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as browserInternal from "@openreceive/browser/internal";
import { openReceiveCountryMapLandPaths } from "@openreceive/browser/country-map";
import providerRegistryJson from "@openreceive/provider-data/registry.json" with { type: "json" };

const checks = ${JSON.stringify(checks, null, 2)};

assert(
  openReceiveCountryMapLandPaths.length > 0,
  "@openreceive/browser/country-map: land paths must be importable"
);
assert(
  typeof browserInternal.CheckoutWatcher === "function" &&
    typeof browserInternal.createCheckoutElement === "function" &&
    typeof browserInternal.createCheckoutShell === "function" &&
    typeof browserInternal.createCheckoutShellModelFromProps === "function" &&
    typeof browserInternal.createOpenReceiveStatusFetcher === "function" &&
    typeof browserInternal.openReceiveCheckoutElementStyles === "string",
  "@openreceive/browser/internal: framework adapter internals must be importable"
);

const coreRoot = await import("@openreceive/core");
const scopedContracts = await import("@openreceive/core/contracts");
assert.equal(
  coreRoot.OPENRECEIVE_ERROR_CODES,
  undefined,
  "@openreceive/core: generated contracts must only be exported from the contracts subpath"
);
assert(
  Array.isArray(scopedContracts.OPENRECEIVE_ERROR_CODES),
  "@openreceive/core/contracts: generated contracts must be importable"
);

const umbrellaChecks = [
  ["openreceive/node", "createOpenReceive"],
  ["openreceive/browser", "requestCheckout"],
  ["openreceive/react", "Checkout"],
  ["openreceive/vue", "createOpenReceiveVueCheckoutBinding"],
  ["openreceive/svelte", "createOpenReceiveSvelteCheckoutBinding"],
  ["openreceive/angular", "createOpenReceiveAngularCheckoutBinding"],
  ["openreceive/elements", "renderCheckoutHtml"],
  ["openreceive/provider-data", "providerRegistry"],
  ["openreceive/contracts", "OPENRECEIVE_ERROR_CODES"]
];
for (const [specifier, exportName] of umbrellaChecks) {
  const mod = await import(specifier);
  assert(
    mod[exportName] !== undefined,
    \`\${specifier}: umbrella subpath must re-export \${exportName}\`
  );
}

for (const item of checks) {
  const mod = await import(item.name);
  const packagePath = \`node_modules/\${item.name}/package.json\`;
  const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  assert(
    !JSON.stringify(manifest.exports).includes("./src/"),
    \`\${item.name}: packed exports must not point at raw source files\`
  );
  assert(
    JSON.stringify(manifest.exports).includes("./dist/"),
    \`\${item.name}: packed exports must point at dist artifacts\`
  );
  assert(
    typeof manifest.types === "string" && existsSync(\`node_modules/\${item.name}/\${manifest.types}\`),
    \`\${item.name}: root TypeScript declaration must be packaged\`
  );
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
assert.equal(
  providerRegistryJson.schema_version,
  "4.0.0",
  "@openreceive/provider-data/registry.json: raw registry JSON must be importable"
);
assert(
  existsSync("node_modules/@openreceive/provider-data/dist/assets/provider-icons/strike.png"),
  "@openreceive/provider-data: provider icon assets must be packaged"
);
assert(
  existsSync("node_modules/@openreceive/provider-data/dist/assets/pay_tutorials/coinbase-1.webp"),
  "@openreceive/provider-data: provider tutorial assets must be packaged"
);
assert(
  existsSync("node_modules/@openreceive/provider-data/dist/assets/pay_tutorials/kraken-4.webp"),
  "@openreceive/provider-data: provider tutorial assets must be packaged"
);
assert(
  existsSync("node_modules/@openreceive/provider-data/dist/openreceive-providers.v4.json"),
  "@openreceive/provider-data: raw registry JSON must be packaged"
);
const providerDataCjs = await import("node:module").then(({ createRequire }) =>
  createRequire(import.meta.url)("@openreceive/provider-data")
);
assert.equal(
  typeof providerDataCjs.getProvider,
  "function",
  "@openreceive/provider-data: CommonJS require must resolve"
);
assert.equal(
  providerDataCjs.providerIconUrl(providerDataCjs.providerRegistry.providers.strike).includes("assets/provider-icons/strike.png"),
  true,
  "@openreceive/provider-data: CommonJS icon helper must resolve bundled asset URLs"
);
assert.equal(
  providerDataCjs.providerTutorialUrl(providerDataCjs.providerRegistry.providers.kraken.tutorials[3]).includes("assets/pay_tutorials/kraken-4.webp"),
  true,
  "@openreceive/provider-data: CommonJS tutorial helper must resolve bundled asset URLs"
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
const umbrellaCliPath = "node_modules/openreceive/bin/openreceive.mjs";
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
assert(existsSync(umbrellaCliPath), "openreceive: CLI bin must be packaged");
assert(
  execFileSync(process.execPath, [umbrellaCliPath, "help"], { encoding: "utf8" }).includes("doctor"),
  "openreceive: CLI bin must advertise doctor"
);

console.log(\`Imported \${checks.length} OpenReceive package tarballs.\`);
`,
  );
}

function runImportSmoke(installDir) {
  return execFileSync(process.execPath, ["smoke.mjs"], {
    cwd: installDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function main() {
  let workspace;

  try {
    const result = buildOpenReceivePackageTarballs({
      root,
      npmTimeoutMs,
    });
    workspace = result.workspace;
    const installDir = path.join(workspace.baseDir, "install");
    mkdirSync(installDir, { recursive: true });

    writeInstallProject(installDir, result.tarballs);
    console.error("assembling offline package smoke project");
    assembleOfflineInstall(installDir, result.tarballs);
    writeImportSmoke(installDir, result.packages);
    console.error("running package import smoke");
    const output = runImportSmoke(installDir);
    process.stdout.write(output);
    console.log(`Package smoke passed for ${result.packages.length} package(s).`);
  } finally {
    if (workspace?.temporary && process.env.OPENRECEIVE_KEEP_PACKAGE_SMOKE !== "1") {
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
