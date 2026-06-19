#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const ignoredDirs = new Set([
  ".git",
  "node_modules",
  "private",
  "building",
  "dist",
  "coverage"
]);
const ignoredFiles = new Set([
  ".env",
  ".DS_Store",
  "spec/test-vectors/nwc-uri-parse.json"
]);

const secretPatterns = [
  {
    name: "NWC URI with 64 hex secret",
    pattern: /nostr\+walletconnect:\/\/[^\s"'`]+[?&]secret=[0-9a-fA-F]{64}/
  },
  {
    name: "OPENRECEIVE_NWC assignment with 64 hex secret",
    pattern: /OPENRECEIVE_NWC\s*=\s*nostr\+walletconnect:\/\/[^\s"'`]+[?&]secret=[0-9a-fA-F]{64}/
  }
];

function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const relPath = path.relative(root, fullPath);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      if (!ignoredDirs.has(entry)) files.push(...walk(fullPath));
      continue;
    }

    if (ignoredFiles.has(relPath)) continue;
    if (relPath.startsWith(".env.")) continue;
    files.push(fullPath);
  }

  return files;
}

const findings = [];

for (const file of walk(root)) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  for (const check of secretPatterns) {
    if (check.pattern.test(text)) {
      findings.push(`${path.relative(root, file)}: ${check.name}`);
    }
  }
}

if (findings.length > 0) {
  console.error("Potential secrets found:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("Secret scan passed.");
