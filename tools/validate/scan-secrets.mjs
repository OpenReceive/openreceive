#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const ignoredDirs = new Set([
  ".git",
  "node_modules",
  "private",
  "building",
  "dist",
  "coverage",
  ".release",
  ".openreceive",
  "logs",
  "tmp",
]);
const ignoredFiles = new Set([".env", ".DS_Store"]);
// Published example secrets quoted verbatim from specs/vectors. The allowlist
// names the exact known strings — never whole files — so a REAL secret pasted
// into a spec or vector file still fails the scan.
const KNOWN_EXAMPLE_SECRETS = new Set([
  // NIP-47's published example connection string (docs/reference/nip-47.txt).
  "71a8c14c1407c113601079c4302dab36460f0ccd0ad506f1f2dc73b5100e4f3c",
  // Shared parse vectors use obviously-patterned placeholder secrets.
  "b".repeat(64),
  "d".repeat(64),
]);

const secretPatterns = [
  {
    name: "NWC URI with 64 hex secret",
    pattern: /nostr\+walletconnect:\/\/[^\s"'`]+[?&]secret=[0-9a-fA-F]{64}/g,
  },
  {
    name: "NWC_URI assignment with 64 hex secret",
    pattern: /NWC_URI\s*=\s*nostr\+walletconnect:\/\/[^\s"'`]+[?&]secret=[0-9a-fA-F]{64}/g,
  },
  {
    name: "LSC_URI assignment with real-looking credential",
    pattern:
      /LSC_URI_(?:PRIMARY|BACKUP)\s*=\s*lightning\+swapconnect:\/\/[^\s"'`]+[?&](?:key|secret)=[A-Za-z0-9_./+=:-]{16,}/g,
  },
  {
    name: "FixedFloat secret assignment",
    pattern: /(?:OPENRECEIVE_SWAP_)?FIXED_FLOAT_SECRET\s*=\s*["']?[A-Za-z0-9_./+=:-]{16,}/g,
  },
  {
    name: "provider_token value",
    pattern: /provider_token["']?\s*[:=]\s*["'][A-Za-z0-9_./+=:-]{16,}["']/g,
  },
  {
    name: "X-API-SIGN value",
    pattern: /X-API-SIGN["']?\s*[:=]\s*["'][0-9a-fA-F]{32,}["']/g,
  },
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

function trackedFiles() {
  try {
    const output = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
    });

    return output
      .split("\0")
      .filter(Boolean)
      .map((file) => path.join(root, file));
  } catch {
    return [];
  }
}

function isEnvFile(relativePath) {
  if (relativePath === ".env.example") return false;
  const fileName = path.basename(relativePath);
  return (
    fileName === ".env" ||
    fileName.startsWith(".env.") ||
    fileName.endsWith(".env") ||
    fileName.includes(".env.")
  );
}

function filesToScan() {
  const files = new Map();

  for (const file of walk(root)) {
    files.set(path.relative(root, file), file);
  }

  for (const file of trackedFiles()) {
    files.set(path.relative(root, file), file);
  }

  return [...files.values()];
}

const findings = [];

for (const file of trackedFiles()) {
  const relativePath = path.relative(root, file);
  if (!existsSync(file)) continue;
  if (isEnvFile(relativePath)) {
    findings.push(`${relativePath}: tracked env file is forbidden`);
  }
}

for (const file of filesToScan()) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  for (const check of secretPatterns) {
    // Check every occurrence: an allowlisted example secret earlier in the
    // file must not shadow a real secret later in the same file.
    for (const match of text.matchAll(check.pattern)) {
      const hexSecret = match[0].match(/(?:secret=|["'])([0-9a-fA-F]{32,64})/);
      if (hexSecret !== null && KNOWN_EXAMPLE_SECRETS.has(hexSecret[1].toLowerCase())) continue;
      findings.push(`${path.relative(root, file)}: ${check.name}`);
      break;
    }
  }
}

if (findings.length > 0) {
  console.error("Potential secrets found:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("Secret scan passed.");
