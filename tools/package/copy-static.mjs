#!/usr/bin/env node

import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const [sourceRootArg, distRootArg, ...entries] = process.argv.slice(2);

if (sourceRootArg === undefined || distRootArg === undefined || entries.length === 0) {
  console.error("Usage: copy-static.mjs <source-root> <dist-root> <entry[:target]>...");
  process.exit(1);
}

const sourceRoot = path.resolve(sourceRootArg);
const distRoot = path.resolve(distRootArg);

for (const entry of entries) {
  const separator = entry.indexOf(":");
  const sourceRelative = separator === -1 ? entry : entry.slice(0, separator);
  const targetRelative = separator === -1 ? sourceRelative : entry.slice(separator + 1);
  const source = path.join(sourceRoot, sourceRelative);
  const target = path.join(distRoot, targetRelative);

  if (!existsSync(source)) continue;
  rmSync(target, { recursive: true, force: true });
  mkdirSync(path.dirname(target), { recursive: true });

  if (statSync(source).isDirectory()) {
    cpSync(source, target, { recursive: true });
  } else {
    copyFileSync(source, target);
  }
}
