import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Fetches each provider's favicon as a PNG next to the .webp the registry
// references (same directory, `.png` extension). The registry keys .webp
// files, and only .webp ships — tools/package/generate-provider-images.mjs
// refuses anything else — so after this runs, encode each download and delete
// the PNG:
//
//   cd packages/js/provider-data/src/assets/provider-icons
//   for f in *.png; do cwebp -q 80 -m 6 -af -sharp_yuv -resize 72 0 "$f" -o "${f%.png}.webp"; done
//   rm *.png
//
// Drop `-resize 72 0` for a favicon that is already narrower than 72 px (never
// upscale). Then `npm run generate:provider-images`.
//
// Written by create-provider-v4.mjs from the registry.
const manifestPath = "tools/provider-data/provider-icons.manifest.json";
const iconRoot = "packages/js/provider-data/src";
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

for (const [id, entry] of Object.entries(manifest)) {
  const target = path.join(iconRoot, entry.icon_path.replace(/\.webp$/, ".png"));
  await mkdir(path.dirname(target), { recursive: true });
  const response = await fetch(entry.favicon_url);
  if (!response.ok) {
    throw new Error(`Failed to download ${id}: ${response.status} ${response.statusText}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(target, bytes);
}
