import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const manifestPath = "packages/js/browser/src/assets/provider-icons/manifest.json";
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

await mkdir(path.dirname(manifestPath), { recursive: true });

for (const [id, entry] of Object.entries(manifest)) {
  const response = await fetch(entry.favicon_url);
  if (!response.ok) {
    throw new Error(`Failed to download ${id}: ${response.status} ${response.statusText}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(`packages/js/browser/src/${entry.icon_path}`, bytes);
}
