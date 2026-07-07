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
  "coverage"
]);
const ignoredFiles = new Set([
  ".env",
  ".DS_Store",
  "openreceive.yml",
  "spec/test-vectors/nwc-uri-parse.json"
]);
const allowedSecretFixtures = new Set([
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
  },
  {
    name: "FixedFloat secret assignment",
    pattern: /(?:OPENRECEIVE_SWAP_)?FIXED_FLOAT_SECRET\s*=\s*["']?[A-Za-z0-9_./+=:-]{16,}/
  },
  {
    name: "provider_token value",
    pattern: /provider_token["']?\s*[:=]\s*["'][A-Za-z0-9_./+=:-]{16,}["']/
  },
  {
    name: "X-API-SIGN value",
    pattern: /X-API-SIGN["']?\s*[:=]\s*["'][0-9a-fA-F]{32,}["']/
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

function trackedFiles() {
  try {
    const output = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8"
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
  const fileName = path.basename(relativePath);
  return fileName === ".env" || fileName.startsWith(".env.") || fileName.endsWith(".env") || fileName.includes(".env.");
}

function isPrivateOpenReceiveConfig(relativePath) {
  return relativePath === "openreceive.yml";
}

function filesToScan() {
  const files = new Map();

  for (const file of walk(root)) {
    files.set(path.relative(root, file), file);
  }

  for (const file of trackedFiles()) {
    const relativePath = path.relative(root, file);
    if (!allowedSecretFixtures.has(relativePath) && !isPrivateOpenReceiveConfig(relativePath)) {
      files.set(relativePath, file);
    }
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
  if (isPrivateOpenReceiveConfig(relativePath)) {
    findings.push(`${relativePath}: tracked private OpenReceive config is forbidden`);
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
