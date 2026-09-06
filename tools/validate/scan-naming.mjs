#!/usr/bin/env node

// The product name is one word: OpenReceive. Never the two-word spelling — not in
// prose, not in a title, not in a package description, not in a screenshot
// caption. The site renders these docs verbatim and the plugin directory
// shows the manifest name, so a two-word spelling anywhere upstream leaks
// straight onto a page. Wired into `npm run check` so test:ci:core catches it.
//
// There is no allowlist. A hit is a rename, not a special case. The one file
// that has to spell the phrase is this one, to name what it forbids.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { root } from "../shared/root.mjs";

const FORBIDDEN = new RegExp(["Open", "Receive"].join(" "));
const SELF = "tools/validate/scan-naming.mjs";

// Everything git tracks, so generated output and dependencies are not scanned
// and an untracked scratch file cannot fail the gate — the same source of
// truth as scan-secrets.mjs.
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const findings = [];
for (const relative of tracked) {
  if (relative === SELF) continue;
  const file = path.join(root, relative);
  if (!existsSync(file)) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  // Binary assets (images, video) are unreadable here; the words a grep
  // cannot see are checked by eye when an asset is added.
  if (text.includes("\u0000")) continue;
  for (const [index, line] of text.split("\n").entries()) {
    if (FORBIDDEN.test(line)) {
      findings.push(`${relative}:${index + 1}: ${line.trim().slice(0, 100)}`);
    }
  }
}

if (findings.length > 0) {
  console.error('Naming check failed: the product is spelled "OpenReceive", one word, everywhere.');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Naming check passed: no two-word product name in ${tracked.length} tracked files.`);
