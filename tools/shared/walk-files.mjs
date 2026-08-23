import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Depth-first walk returning absolute file paths in sorted order.
 *
 * `ignoreDirs` is a Set of directory entry NAMES pruned at every depth;
 * `filter(entryName, fullPath)` decides whether a file is included (all files
 * when omitted). A missing `dir` yields an empty list.
 *
 * Shared by tools/validate/scan-secrets.mjs and
 * validate-spec.mjs so the repo has one walker to keep correct.
 */
export function walkFiles(dir, { ignoreDirs = new Set(), filter } = {}) {
  if (!existsSync(dir)) return [];

  const files = [];
  for (const entry of readdirSync(dir).sort()) {
    const fullPath = path.join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      if (!ignoreDirs.has(entry)) files.push(...walkFiles(fullPath, { ignoreDirs, filter }));
      continue;
    }

    if (!stat.isFile()) continue;
    if (filter === undefined || filter(entry, fullPath)) files.push(fullPath);
  }

  return files;
}
