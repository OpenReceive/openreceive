// Biome-formats a generated TypeScript module before it is written, so the
// committed output is byte-stable and `npm run format:check` never disagrees
// with a generator. Shared by the generators under tools/package.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { root } from "../shared/root.mjs";

export function formatWithBiome(source, filePath, generatorName) {
  const formatted = spawnSync(
    path.join(root, "node_modules/.bin/biome"),
    ["format", `--stdin-file-path=${filePath}`],
    { input: source, encoding: "utf8", cwd: root, maxBuffer: 64 * 1024 * 1024 },
  );
  if (formatted.error !== undefined || formatted.status !== 0) {
    process.stderr.write(formatted.stdout ?? "");
    process.stderr.write(formatted.stderr ?? "");
    throw new Error(
      `${generatorName}: biome format failed for ${path.relative(root, filePath)}${
        formatted.error === undefined ? "" : ` (${formatted.error.message})`
      }`,
    );
  }
  return formatted.stdout;
}
