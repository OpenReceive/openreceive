import { readdir, readFile, writeFile } from "node:fs/promises";

// Regenerates everything derived from the provider registry:
//   - the registry JSON itself (normalized formatting)
//   - tools/provider-data/provider-icons.manifest.json, the input
//     download-provider-icons.mjs reads
// and checks that the wallet-logo directory matches the registry's icon_path
// references exactly. The logos themselves ship inside the JavaScript:
// tools/package/generate-provider-images.mjs (npm run generate:provider-images)
// turns the .webp files into the committed data-URI module. manifest.json is a
// tool input, not something publishes should carry.
const registryPath = "packages/js/provider-data/src/data/openreceive-providers.v4.json";
const manifestPath = "tools/provider-data/provider-icons.manifest.json";
const iconDir = "packages/js/provider-data/src/assets/provider-icons";

const registry = JSON.parse(await readFile(registryPath, "utf8"));

await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

const iconManifest = Object.fromEntries(
  Object.values(registry.providers).map((provider) => [
    provider.id,
    {
      url: provider.url,
      icon_path: provider.icon_path,
      favicon_url: `https://www.google.com/s2/favicons?domain=${new URL(provider.url).hostname}&sz=128`,
    },
  ]),
);
await writeFile(manifestPath, `${JSON.stringify(iconManifest, null, 2)}\n`);

// The directory holds exactly what the registry references: icons for removed
// providers must be deleted, not carried along as dead bundle weight (a test
// pins the generated image table, the registry, and the directory to each
// other).
const iconFiles = [
  ...new Set(
    Object.values(registry.providers).map((provider) => provider.icon_path.split("/").pop()),
  ),
].sort();
const onDisk = new Set((await readdir(iconDir)).filter((file) => file.endsWith(".webp")));
for (const file of iconFiles) {
  if (!onDisk.has(file)) {
    throw new Error(`registry references missing provider icon: ${iconDir}/${file}`);
  }
}
for (const file of onDisk) {
  if (!iconFiles.includes(file)) {
    throw new Error(`orphaned provider icon not referenced by the registry: ${iconDir}/${file}`);
  }
}
