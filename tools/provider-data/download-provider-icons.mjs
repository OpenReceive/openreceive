import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Written by create-provider-v4.mjs from the registry.
const manifestPath = "tools/provider-data/provider-icons.manifest.json";
const iconRoot = "packages/js/provider-data/src";
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

for (const [id, entry] of Object.entries(manifest)) {
  await mkdir(path.dirname(path.join(iconRoot, entry.icon_path)), { recursive: true });
  const response = await fetch(entry.favicon_url);
  if (!response.ok) {
    throw new Error(`Failed to download ${id}: ${response.status} ${response.statusText}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(path.join(iconRoot, entry.icon_path), bytes);
}
