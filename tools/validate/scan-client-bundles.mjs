#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const examplesRoot = path.join(root, "examples");
const ignoredDirs = new Set([".git", "node_modules"]);

// Two kinds of check. A "secret" is an actual credential and is forbidden
// anywhere in shipped client output, source maps included. A "marker" is a
// server-only env-var NAME — evidence that server code was bundled — which is
// only meaningful in emitted code: a .map inlines the original source of
// browser libraries that legitimately name these variables (@openreceive/core
// carries NWC_URI_PROTOCOL and the "Set NWC_URI to …" help string), so markers
// are not scanned there.
const forbiddenPatterns = [
  {
    name: "NWC_URI marker",
    kind: "marker",
    pattern: /NWC_URI/,
  },
  {
    name: "LSC_URI marker",
    kind: "marker",
    pattern: /LSC_URI_(?:PRIMARY|BACKUP)/,
  },
  {
    name: "NWC connection URI",
    kind: "secret",
    pattern: /nostr\+walletconnect:\/\/[0-9a-fA-F]{64}/,
  },
  {
    name: "NWC code query value",
    kind: "secret",
    pattern: /[?&]secret=[0-9a-fA-F]{16,}/,
  },
  {
    name: "FixedFloat secret marker",
    kind: "secret",
    pattern: /FIXED_FLOAT_SECRET=|FIXED_FLOAT_SECRET["']?\s*[:=]\s*["'][^"']+/,
  },
  // Testkit demo mode is server-only: the /__testkit control surface and the
  // @openreceive/testkit fakes must never end up in a shipped client bundle.
  {
    name: "testkit control-surface marker",
    kind: "marker",
    pattern: /__testkit/,
  },
  {
    name: "@openreceive/testkit marker",
    kind: "marker",
    pattern: /@openreceive\/testkit/,
  },
];

function collectClientBundleDirs(dir) {
  if (!existsSync(dir)) return [];

  const dirs = [];
  for (const entry of readdirSync(dir)) {
    if (ignoredDirs.has(entry)) continue;

    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);
    if (!stat.isDirectory()) continue;

    if (entry === "dist") {
      dirs.push(fullPath);
      continue;
    }

    if (entry === ".next") {
      const nextStatic = path.join(fullPath, "static");
      if (existsSync(nextStatic) && statSync(nextStatic).isDirectory()) {
        dirs.push(nextStatic);
      }
      continue;
    }

    // Shakapacker output (the Rails demo's real browser bundle).
    if ((entry === "packs" || entry === "packs-test") && path.basename(dir) === "public") {
      dirs.push(fullPath);
      continue;
    }

    dirs.push(...collectClientBundleDirs(fullPath));
  }

  return dirs;
}

function walkFiles(dir) {
  const files = [];

  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...walkFiles(fullPath));
      continue;
    }

    if (stat.isFile()) files.push(fullPath);
  }

  return files;
}

const findings = [];
const bundleDirs = collectClientBundleDirs(examplesRoot);

for (const bundleDir of bundleDirs) {
  for (const file of walkFiles(bundleDir)) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const isSourceMap = file.endsWith(".map");
    for (const check of forbiddenPatterns) {
      if (isSourceMap && check.kind === "marker") continue;
      if (check.pattern.test(text)) {
        findings.push(`${path.relative(root, file)}: ${check.name}`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error("Potential client bundle secret leaks found:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

if (bundleDirs.length === 0) {
  console.log("No client bundles found; skipping client bundle secret scan.");
} else {
  console.log(
    `Client bundle secret scan passed for ${bundleDirs.length} generated client bundle director${bundleDirs.length === 1 ? "y" : "ies"}.`,
  );
}
