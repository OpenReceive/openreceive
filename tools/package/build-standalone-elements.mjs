#!/usr/bin/env node

// Standalone browser checkout build (plan A5). Hosts without a JS bundler —
// the WordPress plugin, Django templates, plain PHP pages — cannot resolve
// `import "@openreceive/elements"` at runtime, so this emits the packaged
// checkout as static files under packages/js/elements/dist/standalone/:
//
//   openreceive-checkout.js      ONE self-registering ESM file: the elements
//                                entry with every @openreceive/* dependency,
//                                the tsup chunk and qrcode inlined, no bare
//                                specifiers left. It calls defineElements() on
//                                load and re-exports the @openreceive/elements
//                                surface. Identifiers are NOT mangled
//                                (WordPress.org guideline 4 forbids obfuscated
//                                code); only whitespace is minified, so the
//                                file is reproducible from this repo with
//                                `npm run build:packages`.
//   openreceive-checkout.js.map  its source map
//   openreceive-checkout.css     = the elements package's scoped styles.css
//   assets/                      = @openreceive/provider-data/dist/assets (the
//                                wallet logos and pay tutorials the element's
//                                `asset-base-url` attribute points at)
//   MANIFEST.json                workspace version + bytes + sha256 per file,
//                                so a copied tree can be checked for staleness
//
// and dist/standalone-checkout-<version>.tar.gz at the repo root (gitignored)
// for the GitHub release upload. Runs LAST in root `build:packages`, so every
// package dist it reads already exists. tools/validate/check-standalone-
// elements.mjs re-verifies the output and imports the constants below.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { root } from "../shared/root.mjs";
import { walkFiles } from "../shared/walk-files.mjs";

export const STANDALONE_PACKAGE_NAME = "@openreceive/elements";
export const STANDALONE_ELEMENT_TAG_NAME = "openreceive-checkout";
export const STANDALONE_JS_FILE = "openreceive-checkout.js";
export const STANDALONE_CSS_FILE = "openreceive-checkout.css";
export const STANDALONE_ASSETS_DIR = "assets";
export const STANDALONE_MANIFEST_FILE = "MANIFEST.json";
export const STANDALONE_SOURCE_URL = "https://github.com/openreceive/openreceive";
export const STANDALONE_BUILD_COMMAND = "npm run build:packages";

export function standalonePaths(repoRoot = root) {
  const elementsDist = path.join(repoRoot, "packages/js/elements/dist");
  return {
    elementsDist,
    outDir: path.join(elementsDist, "standalone"),
    providerAssets: path.join(repoRoot, "packages/js/provider-data/dist/assets"),
    releaseDir: path.join(repoRoot, "dist"),
  };
}

export function readWorkspaceVersion(repoRoot = root) {
  return JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
}

export function tarballName(version) {
  return `standalone-checkout-${version}.tar.gz`;
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Every `import`/`export … from` specifier left in an emitted module. A
 * self-contained bundle has none at all — not even relative ones (a leftover
 * `./chunk-*.js` means the tsup chunk was not inlined). Kept as a regex over
 * the file on disk, not esbuild's metafile, so the check script can re-verify
 * a copied tree with nothing but the file.
 */
export function findModuleImportSpecifiers(code) {
  const specifiers = [];
  const patterns = [
    // import "x"; import a from "x"; import {a as b, c} from "x"; import * as ns from "x"
    /(?:^|[;}\s])import\s*(?:(?:\{[^}]*\}|\*\s*as\s+[\w$]+|[\w$]+)(?:\s*,\s*(?:\{[^}]*\}|\*\s*as\s+[\w$]+))?\s*from\s*)?["']([^"'\n]+)["']/g,
    // export {a} from "x"; export * from "x"; export * as ns from "x"
    /(?:^|[;}\s])export\s*(?:\{[^}]*\}|\*(?:\s*as\s+[\w$]+)?)\s*from\s*["']([^"'\n]+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

function manifestEntries(outDir) {
  const files = {};
  for (const file of walkFiles(outDir)) {
    const relative = path.relative(outDir, file).split(path.sep).join("/");
    if (relative === STANDALONE_MANIFEST_FILE) continue;
    const bytes = readFileSync(file);
    files[relative] = { bytes: bytes.length, sha256: sha256(bytes) };
  }
  return files;
}

function assertExists(filePath, what) {
  if (!existsSync(filePath)) {
    throw new Error(
      `build-standalone-elements: ${what} is missing (${path.relative(root, filePath)}). ` +
        "Build the workspace packages first: npm run build:packages.",
    );
  }
}

export async function buildStandaloneElements(input = {}) {
  const repoRoot = input.root ?? root;
  const log = input.log ?? console.error;
  const version = readWorkspaceVersion(repoRoot);
  const { elementsDist, outDir, providerAssets, releaseDir } = standalonePaths(repoRoot);

  const entryIndex = path.join(elementsDist, "index.js");
  const stylesCss = path.join(elementsDist, "styles.css");
  assertExists(entryIndex, "the @openreceive/elements dist entry");
  assertExists(stylesCss, "the @openreceive/elements dist stylesheet");
  assertExists(providerAssets, "the @openreceive/provider-data assets tree");

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // Bundle from the published dist, not src: the standalone file is then the
  // same code npm ships, just resolved and concatenated. `export *` keeps the
  // named surface; the trailing call is what makes the plain <script
  // type="module"> tag register <openreceive-checkout> (defineElements skips
  // tags already in the registry, so loading the file twice is harmless).
  const entrySource = [
    `export * from "./index.js";`,
    `import { defineElements } from "./index.js";`,
    "defineElements();",
    "",
  ].join("\n");
  const banner =
    `/* ${STANDALONE_PACKAGE_NAME} ${version} — standalone <${STANDALONE_ELEMENT_TAG_NAME}> build. ` +
    `Not obfuscated: whitespace-only minification, identifiers intact. Reproducible from ` +
    `${STANDALONE_SOURCE_URL} with \`${STANDALONE_BUILD_COMMAND}\` ` +
    "(tools/package/build-standalone-elements.mjs). MIT License. */";

  const result = await build({
    stdin: {
      contents: entrySource,
      resolveDir: elementsDist,
      sourcefile: "standalone-entry.js",
      loader: "js",
    },
    outfile: path.join(outDir, STANDALONE_JS_FILE),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minifyWhitespace: true,
    minifyIdentifiers: false,
    minifySyntax: false,
    sourcemap: true,
    metafile: true,
    legalComments: "inline",
    banner: { js: banner },
    logLevel: "silent",
  });
  if (result.errors.length > 0) {
    throw new Error(
      `build-standalone-elements: esbuild failed:\n${result.errors.map((e) => e.text).join("\n")}`,
    );
  }

  // Anything esbuild left external would be a bare specifier at runtime.
  const jsOutput = Object.entries(result.metafile.outputs).find(([file]) => file.endsWith(".js"));
  const externals = (jsOutput?.[1].imports ?? []).filter((item) => item.external);
  if (externals.length > 0) {
    throw new Error(
      `build-standalone-elements: bundle still imports ${externals.map((i) => i.path).join(", ")}`,
    );
  }
  const emittedJs = readFileSync(path.join(outDir, STANDALONE_JS_FILE), "utf8");
  const leftover = findModuleImportSpecifiers(emittedJs);
  if (leftover.length > 0) {
    throw new Error(
      `build-standalone-elements: emitted module still has import specifiers: ${leftover.join(", ")}`,
    );
  }

  copyFileSync(stylesCss, path.join(outDir, STANDALONE_CSS_FILE));
  cpSync(providerAssets, path.join(outDir, STANDALONE_ASSETS_DIR), { recursive: true });

  const manifest = {
    package: STANDALONE_PACKAGE_NAME,
    version,
    files: manifestEntries(outDir),
    source: STANDALONE_SOURCE_URL,
    build: STANDALONE_BUILD_COMMAND,
  };
  writeFileSync(
    path.join(outDir, STANDALONE_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  // Release tarball: one top-level directory named like the archive, so an
  // extract on a plain PHP host lands in standalone-checkout-<version>/.
  mkdirSync(releaseDir, { recursive: true });
  for (const entry of readdirSync(releaseDir)) {
    if (/^standalone-checkout-.*\.tar\.gz$/.test(entry)) rmSync(path.join(releaseDir, entry));
  }
  const stageName = `standalone-checkout-${version}`;
  const stageDir = path.join(releaseDir, stageName);
  rmSync(stageDir, { recursive: true, force: true });
  cpSync(outDir, stageDir, { recursive: true });
  const tarball = path.join(releaseDir, tarballName(version));
  execFileSync("tar", ["-czf", tarball, "-C", releaseDir, stageName], { stdio: "inherit" });
  rmSync(stageDir, { recursive: true, force: true });

  const fileCount = Object.keys(manifest.files).length;
  log(
    `built standalone checkout ${version}: ${fileCount} files in ` +
      `${path.relative(repoRoot, outDir)} (${STANDALONE_JS_FILE} ${manifest.files[STANDALONE_JS_FILE].bytes} bytes), ` +
      `${path.relative(repoRoot, tarball)}`,
  );
  return { outDir, tarball, manifest };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildStandaloneElements().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
