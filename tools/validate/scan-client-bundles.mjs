#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const examplesRoot = path.join(root, "examples");
const ignoredDirs = new Set([".git", "node_modules"]);

const forbiddenPatterns = [
  {
    name: "OPENRECEIVE_NWC marker",
    pattern: /OPENRECEIVE_NWC/
  },
  {
    name: "NWC connection URI",
    pattern: /nostr\+walletconnect:\/\/[0-9a-fA-F]{64}/
  },
  {
    name: "NWC secret query value",
    pattern: /[?&]secret=[0-9a-fA-F]{16,}/
  }
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

    for (const check of forbiddenPatterns) {
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
  console.log(`Client bundle secret scan passed for ${bundleDirs.length} generated client bundle director${bundleDirs.length === 1 ? "y" : "ies"}.`);
}
