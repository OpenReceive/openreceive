import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const sourcePath = "packages/js/provider-data/src/data/openreceive-providers.v2.json";
const targetPath = "packages/js/provider-data/src/data/openreceive-providers.v4.json";
const iconDir = "packages/js/browser/src/assets/provider-icons";

const registry = JSON.parse(await readFile(sourcePath, "utf8"));
const generated = new Date().toISOString().slice(0, 10);

await mkdir(iconDir, { recursive: true });

registry.schema_version = "4.0.0";
registry.generated = generated;
registry.description =
  "Static database of providers and routes the OpenReceive payment wizard can suggest for paying a BOLT11 Lightning invoice.";
registry.filter =
  "Providers that can send to an arbitrary third-party BOLT11 Lightning invoice, including withdrawal and swap payout flows.";
registry._meta = {
  provider_fields: {
    id: "stable slug key",
    name: "display name",
    url: "homepage",
    us: "true=US-available, false=US-excluded, null=unknown",
    lightning_docs_url: "official how-to-pay/send Lightning invoice page, or null",
    icon_path: "repo-local icon path used by browser UI",
    tutorials: "optional ordered app-specific payment tutorial screenshots"
  },
  route_ref_fields: {
    provider: "provider id",
    flagship: "recommended option for this route",
    rank: "1-based route-specific display ordering; required when a route has explicit ranked suggestions"
  },
  country_fields: {
    code: "ISO 3166-1 alpha-2",
    name: "display",
    currency: "ISO 4217",
    coverage: "deep | thin | sparse"
  }
};

for (const provider of Object.values(registry.providers)) {
  delete provider.pays_arbitrary_invoice;
  delete provider.blurb;
  delete provider.caveat;
  delete provider.mechanism;
  provider.icon_path = `assets/provider-icons/${provider.id}.png`;
}

for (const route of registry.crypto_routes) {
  delete route.summary;
  for (const ref of route.providers) {
    delete ref.blurb_override;
  }
}

const text = `${JSON.stringify(registry, null, 2)}\n`;
await writeFile(targetPath, text);

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
