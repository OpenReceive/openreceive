import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import type { ScaffoldFile, ScaffoldResult } from "./types.ts";

export async function writeScaffoldFiles(input: {
  readonly cwd: string;
  readonly outDir: string;
  readonly force: boolean;
  readonly files: readonly ScaffoldFile[];
}): Promise<ScaffoldResult> {
  const root = path.resolve(input.cwd, input.outDir);
  const planned = input.files.map((file) => ({
    file,
    absolute: path.join(root, file.path),
    relative: path.relative(input.cwd, path.join(root, file.path)),
  }));

  const existing: string[] = [];
  for (const entry of planned) {
    if (await exists(entry.absolute)) existing.push(entry.relative);
  }
  if (existing.length > 0 && !input.force) {
    throw new Error(
      `Refusing to overwrite existing files without --force:\n${existing
        .map((entry) => `  - ${entry}`)
        .join("\n")}`,
    );
  }

  const written: string[] = [];
  for (const entry of planned) {
    await mkdir(path.dirname(entry.absolute), { recursive: true });
    await writeFile(entry.absolute, entry.file.contents, "utf8");
    written.push(entry.relative);
  }

  return { files: input.files, written, skipped: [] };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
