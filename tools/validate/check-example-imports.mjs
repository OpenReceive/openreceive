#!/usr/bin/env node

// Examples are our stand-ins for end developers: they must compile against
// exactly the surface we tell end developers to use. Any @openreceive/*/internal
// import in examples/ recreates the Hyrum's-law leak this check exists to stop
// (see docs — integrate via the main entries, @openreceive/browser/headless, or
// @openreceive/elements instead).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const examplesRoot = path.join(root, "examples");
const ignoredDirs = new Set([
  ".git",
  "node_modules",
  "dist",
  ".next",
  "tmp",
  "log",
  "logs",
  // Shakapacker build output (multi-MB minified bundles, not source).
  "packs",
  "packs-test",
]);
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

const forbiddenImport = /@openreceive\/[a-z-]+\/internal/;

function walkSourceFiles(dir) {
  if (!existsSync(dir)) return [];

  const files = [];
  for (const entry of readdirSync(dir)) {
    if (ignoredDirs.has(entry)) continue;

    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...walkSourceFiles(fullPath));
      continue;
    }

    if (stat.isFile() && sourceExtensions.has(path.extname(entry))) {
      files.push(fullPath);
    }
  }

  return files;
}

const findings = [];

for (const file of walkSourceFiles(examplesRoot)) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (forbiddenImport.test(line)) {
      findings.push(`${path.relative(root, file)}:${index + 1}: ${line.trim()}`);
    }
  });
}

if (findings.length > 0) {
  console.error("Examples must not import @openreceive/*/internal subpaths.");
  console.error(
    "Use the package main entry, @openreceive/browser/headless, or @openreceive/elements.",
  );
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("Example import check passed: no @openreceive/*/internal imports under examples/.");
