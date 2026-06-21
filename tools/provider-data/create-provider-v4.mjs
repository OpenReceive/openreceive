import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const registryPath = "packages/js/provider-data/src/data/openreceive-providers.v4.json";
const iconDir = "packages/js/browser/src/assets/provider-icons";

const registry = JSON.parse(await readFile(registryPath, "utf8"));

await mkdir(iconDir, { recursive: true });

const text = `${JSON.stringify(registry, null, 2)}\n`;
await writeFile(registryPath, text);

const iconManifest = Object.fromEntries(
  Object.values(registry.providers).map((provider) => [
    provider.id,
    {
      url: provider.url,
      icon_path: provider.icon_path,
      favicon_url: `https://www.google.com/s2/favicons?domain=${new URL(provider.url).hostname}&sz=128`
    }
  ])
);
await writeFile(
  path.join(iconDir, "manifest.json"),
  `${JSON.stringify(iconManifest, null, 2)}\n`
);

const iconIds = Object.keys(registry.providers).sort();
const iconSource = [
  ...iconIds.map((id) => {
    const variableName = `${id.replace(/-([a-z0-9])/g, (_, letter) => letter.toUpperCase())}Icon`;
    return `const ${variableName} = new URL("./assets/provider-icons/${id}.png", import.meta.url).href;`;
  }),
  "",
  "export const openReceiveProviderIconUrls: Readonly<Record<string, string>> = {",
  ...iconIds.map((id, index) => {
    const variableName = `${id.replace(/-([a-z0-9])/g, (_, letter) => letter.toUpperCase())}Icon`;
    const comma = index === iconIds.length - 1 ? "" : ",";
    return `  "assets/provider-icons/${id}.png": ${variableName}${comma}`;
  }),
  "};",
  ""
].join("\n");
await writeFile("packages/js/browser/src/provider-icons.ts", iconSource);
