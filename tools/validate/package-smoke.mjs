#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildPackageTarballs,
  localPackageDirectory,
  localPackageDependency,
} from "../package/build-artifacts.mjs";

const root = process.cwd();
const npmTimeoutMs = Number(process.env.OPENRECEIVE_PACKAGE_SMOKE_NPM_TIMEOUT_MS ?? 120_000);
const localSmokeDependencies = new Set(["@getalby/sdk", "commander", "qrcode", "react", "yaml"]);

// The wrapper packages (angular/svelte/vue) all `export *` from
// @openreceive/elements/wrapper-shared, so these three strings ARE the wrapper
// surface contract: the binding factories plus the browser factories the
// wrappers re-export under their own names, and — negatively — no element
// factory and none of the deleted `createWrapper*` pass-throughs.
const importChecks = {
  "@openreceive/angular":
    "typeof mod.createWrapperCheckoutBinding === 'function' && typeof mod.createWrapperCheckoutShellBinding === 'function' && typeof mod.createWrapperThemeToggleBinding === 'function' && typeof mod.createCheckoutController === 'function' && typeof mod.createCheckoutShell === 'function' && typeof mod.createThemeModel === 'function' && typeof mod.createStoredThemeModel === 'function' && typeof mod.defineElements === 'function' && typeof mod.validateCheckoutProps === 'function' && mod.createCheckoutElement === undefined && mod.createThemeToggleElement === undefined && mod.createWrapperCheckoutController === undefined && mod.createWrapperCheckoutShell === undefined && mod.createWrapperThemeBinding === undefined && mod.createWrapperStoredThemeBinding === undefined",
  "@openreceive/browser":
    "typeof mod.requestCheckout === 'function' && typeof mod.deriveStatus === 'function' && typeof mod.lightningUri === 'function' && typeof mod.qrSvg === 'function' && typeof mod.qrPngDataUrl === 'function' && typeof mod.copyInvoice === 'function' && typeof mod.openWallet === 'function' && typeof mod.createCheckoutController === 'function'",
  "@openreceive/core":
    "typeof mod.reconcilePaymentAttempts === 'function' && typeof mod.isTransactionSettled === 'function'",
  "@openreceive/elements":
    "typeof mod.renderCheckoutHtml === 'function' && typeof mod.renderThemeToggleHtml === 'function' && mod.OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME === 'openreceive-theme-toggle'",
  "@openreceive/express":
    "typeof mod.openReceiveExpress === 'function' && typeof mod.createStack === 'function' && typeof mod.HttpError === 'function' && mod.createSqlPayments === undefined && mod.maybeReconcilePayments === undefined",
  "@openreceive/fastify":
    "typeof mod.openReceiveFastify === 'function' && typeof mod.createStack === 'function' && typeof mod.HttpError === 'function' && mod.createSqlPayments === undefined && mod.maybeReconcilePayments === undefined",
  "@openreceive/http":
    "typeof mod.createHttpHandler === 'function' && typeof mod.HttpError === 'function'",
  "@openreceive/next":
    "typeof mod.openReceiveNextHandlers === 'function' && typeof mod.createStack === 'function' && typeof mod.HttpError === 'function' && mod.createSqlPayments === undefined && mod.maybeReconcilePayments === undefined",
  "@openreceive/node":
    "typeof mod.createOpenReceive === 'function' && typeof mod.ServiceError === 'function' && typeof mod.ConfigError === 'function' && typeof mod.createNwcReceiveClient === 'function'",
  "@openreceive/provider-data":
    "typeof mod.getProviderRegistryMetadata === 'function' && typeof mod.providerIconUrl === 'function' && typeof mod.providerTutorialUrl === 'function' && mod.providerIconUrl(mod.providerRegistry.providers.strike).includes('assets/provider-icons/strike.png') && mod.providerTutorialUrl(mod.providerRegistry.providers.kraken.tutorials[3]).includes('assets/pay_tutorials/kraken-4.webp')",
  "@openreceive/react":
    "typeof mod.createCheckoutViewModel === 'function' && typeof mod.ThemeScope === 'function' && typeof mod.ThemeToggle === 'function' && typeof mod.PaymentWizard === 'function' && typeof mod.WaitingState === 'function' && typeof mod.useTheme === 'function' && typeof mod.CheckoutProvider === 'function' && typeof mod.useCheckoutContext === 'function' && mod.OpenReceiveThemeToggle === undefined && mod.OpenReceivePaymentWizard === undefined && mod.OpenReceiveWaitingState === undefined && mod.useOpenReceiveTheme === undefined",
  "@openreceive/svelte":
    "typeof mod.createWrapperCheckoutBinding === 'function' && typeof mod.createWrapperCheckoutShellBinding === 'function' && typeof mod.createWrapperThemeToggleBinding === 'function' && typeof mod.createCheckoutController === 'function' && typeof mod.createCheckoutShell === 'function' && typeof mod.createThemeModel === 'function' && typeof mod.createStoredThemeModel === 'function' && typeof mod.defineElements === 'function' && typeof mod.validateCheckoutProps === 'function' && mod.createCheckoutElement === undefined && mod.createThemeToggleElement === undefined && mod.createWrapperCheckoutController === undefined && mod.createWrapperCheckoutShell === undefined && mod.createWrapperThemeBinding === undefined && mod.createWrapperStoredThemeBinding === undefined",
  "@openreceive/testkit": "typeof mod.createTestkitReceiveClient === 'function'",
  "@openreceive/vue":
    "typeof mod.createWrapperCheckoutBinding === 'function' && typeof mod.createWrapperCheckoutShellBinding === 'function' && typeof mod.createWrapperThemeToggleBinding === 'function' && typeof mod.createCheckoutController === 'function' && typeof mod.createCheckoutShell === 'function' && typeof mod.createThemeModel === 'function' && typeof mod.createStoredThemeModel === 'function' && typeof mod.defineElements === 'function' && typeof mod.validateCheckoutProps === 'function' && mod.createCheckoutElement === undefined && mod.createThemeToggleElement === undefined && mod.createWrapperCheckoutController === undefined && mod.createWrapperCheckoutShell === undefined && mod.createWrapperThemeBinding === undefined && mod.createWrapperStoredThemeBinding === undefined",
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
  // The openreceive CLI package is bin-only; its check is the bin run below.
  const checks = packages
    .filter(({ manifest }) => manifest.exports !== undefined)
    .map(({ manifest }) => {
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
import * as browserHeadless from "@openreceive/browser/headless";
import providerRegistryJson from "@openreceive/provider-data/registry.json" with { type: "json" };

const checks = ${JSON.stringify(checks, null, 2)};

// ./headless is the one floor under the renderers AND the headless surface:
// the renderer plumbing and the curated engine names are both importable...
assert(
  typeof browserHeadless.createCheckoutController === "function" &&
    typeof browserHeadless.createCheckoutElementAttributes === "function" &&
    typeof browserHeadless.createCheckoutShell === "function" &&
    typeof browserHeadless.createStatusFetcher === "function" &&
    typeof browserHeadless.validateCheckoutProps === "function" &&
    typeof browserHeadless.checkoutElementStyles === "string" &&
    typeof browserHeadless.createCheckoutState === "function" &&
    typeof browserHeadless.createPaymentWizardModel === "function" &&
    typeof browserHeadless.deriveStatus === "function" &&
    typeof browserHeadless.checkoutLabels === "object" &&
    typeof browserHeadless.orClasses === "object",
  "@openreceive/browser/headless: renderer plumbing and the headless engine surface must be importable"
);
// ...and package-private engine names are not. CheckoutWatcher and
// refreshCheckoutState are engine internals; readJsonResponse
// belongs to the main entry.
assert(
  browserHeadless.CheckoutWatcher === undefined &&
    browserHeadless.refreshCheckoutState === undefined &&
    browserHeadless.readJsonResponse === undefined,
  "@openreceive/browser/headless: package-private engine names must stay off the subpath"
);
assert(
  browserHeadless.paymentIconUrls.lightning.includes("/dist/assets/icons/lightning.svg") &&
    browserHeadless.paymentIconUrls.btc.includes("/dist/assets/icons/btc.svg") &&
    !browserHeadless.paymentIconUrls.btc.includes("/browser/assets/icons/"),
  "@openreceive/browser/headless: method icon URLs must resolve to packaged dist assets"
);

const coreRoot = await import("@openreceive/core");
const scopedContracts = await import("@openreceive/core/contracts");
const scopedSwapAddress = await import("@openreceive/core/swap-address");
assert.equal(
  coreRoot.OPENRECEIVE_ERROR_CODES,
  undefined,
  "@openreceive/core: generated contracts must only be exported from the contracts subpath"
);
assert(
  Array.isArray(scopedContracts.OPENRECEIVE_ERROR_CODES),
  "@openreceive/core/contracts: generated contracts must be importable"
);
assert.equal(
  typeof scopedSwapAddress.isValidSwapAddressForPayInAsset,
  "function",
  "@openreceive/core/swap-address: address validation must be importable"
);


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
  readFileSync(browserStylesPath, "utf8").includes(".btn") &&
    readFileSync(browserStylesPath, "utf8").includes("--color-base-100"),
  "@openreceive/browser: styles.css must contain daisyUI checkout styles"
);
// elements/react ship self-contained compiled sheets (usable from a plain
// <link>); the SFC wrappers stay bundler-consumed @import forwarders.
for (const packageName of ["elements", "react"]) {
  const stylesPath = \`node_modules/@openreceive/\${packageName}/dist/styles.css\`;
  assert(existsSync(stylesPath), \`@openreceive/\${packageName}: styles.css export must be packaged\`);
  const compiled = readFileSync(stylesPath, "utf8");
  assert(
    compiled.includes("Generated by tools/package/build-browser-css.mjs") &&
      compiled.includes(".btn") &&
      !compiled.includes('@import "@openreceive/browser/styles.css"'),
    \`@openreceive/\${packageName}: styles.css must be the self-contained compiled sheet\`
  );
}
for (const packageName of ["vue", "svelte", "angular"]) {
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
  existsSync("node_modules/@openreceive/browser/dist/assets/icons/lightning.svg"),
  "@openreceive/browser: lightning method icon assets must be packaged"
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
assert(
  existsSync("node_modules/@openreceive/vue/dist/Checkout.vue"),
  "@openreceive/vue: checkout Vue component must be packaged"
);
assert(
  existsSync("node_modules/@openreceive/vue/dist/Checkout.vue.d.ts"),
  "@openreceive/vue: checkout Vue component typings must be packaged"
);
assert(
  existsSync("node_modules/@openreceive/svelte/dist/Checkout.svelte"),
  "@openreceive/svelte: checkout Svelte component must be packaged"
);
assert(
  existsSync("node_modules/@openreceive/svelte/dist/Checkout.svelte.d.ts"),
  "@openreceive/svelte: checkout Svelte component typings must be packaged"
);
const angularComponentFesmPath =
  "node_modules/@openreceive/angular/dist/fesm2022/openreceive-angular-checkout-component.mjs";
assert(
  existsSync(angularComponentFesmPath),
  "@openreceive/angular: compiled checkout Angular component must be packaged"
);
const angularComponentFesm = readFileSync(angularComponentFesmPath, "utf8");
assert(
  angularComponentFesm.includes("ɵɵngDeclareComponent"),
  "@openreceive/angular: checkout component must ship partial-Ivy declarations for AOT linking"
);
assert(
  !angularComponentFesm.includes("@angular/compiler"),
  "@openreceive/angular: checkout component must not require @angular/compiler at runtime"
);
assert(
  existsSync(
    "node_modules/@openreceive/angular/dist/types/openreceive-angular-checkout-component.d.ts",
  ),
  "@openreceive/angular: checkout component typings must be packaged"
);
// One bin owner: only @openreceive/node ships the openreceive bin (the
// umbrella hard-depends on it, so the CLI is always installed either way).
const nodeCliPath = "node_modules/@openreceive/node/bin/openreceive.mjs";
const nodeCli = await import("@openreceive/node/cli");
assert(
  typeof nodeCli.runCli === "function",
  "@openreceive/node/cli: CLI runner must be importable from the CLI subpath"
);
assert(existsSync(nodeCliPath), "@openreceive/node: CLI bin must be packaged");
assert(
  execFileSync(process.execPath, [nodeCliPath, "help"], { encoding: "utf8" }).includes("Usage: openreceive"),
  "@openreceive/node: CLI bin must run help"
);
// The umbrella ships the command so installing it provides the CLI under
// package managers that never hoist a transitive dependency's bin (pnpm, Yarn
// PnP). It must stay a forwarder: a second CLI IMPLEMENTATION would drift.
const umbrellaCliPath = "node_modules/openreceive/bin/openreceive.mjs";
assert(existsSync(umbrellaCliPath), "openreceive: the umbrella must package its CLI bin");
const umbrellaCli = readFileSync(umbrellaCliPath, "utf8");
assert(
  umbrellaCli.includes('"@openreceive/node/cli"') && !umbrellaCli.includes("runCli"),
  "openreceive: the umbrella bin must execute the @openreceive/node CLI, not carry a copy of it"
);
assert(
  execFileSync(process.execPath, [umbrellaCliPath, "help"], { encoding: "utf8" }).includes("Usage: openreceive"),
  "openreceive: the umbrella CLI bin must run help"
);
assert(
  execFileSync(process.execPath, [nodeCliPath, "help"], { encoding: "utf8" }).includes("doctor"),
  "openreceive CLI must advertise doctor"
);
assert(
  execFileSync(process.execPath, [nodeCliPath, "help"], { encoding: "utf8" }).includes(
    "scaffold payments",
  ),
  "openreceive: CLI bin must advertise scaffold payments"
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
    const result = buildPackageTarballs({
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
