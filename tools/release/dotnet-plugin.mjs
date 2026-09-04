// The BTCPay plugin (packages/dotnet) versions in lockstep with the npm workspace:
// BTCPay reads the assembly's informational version, which the csproj <Version>
// stamps. A plugin version is a System.Version, so a prerelease suffix is dropped
// (0.5.0-alpha.0 stamps 0.5.0). Shared by release:prepare and check:release.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DOTNET_PLUGIN_CSPROJ = path.join(
  "packages",
  "dotnet",
  "BTCPayServer.Plugins.OpenReceive",
  "BTCPayServer.Plugins.OpenReceive.csproj",
);

export function dotnetPluginVersion(version) {
  return version.split("-")[0];
}

export function readDotnetPluginVersion(root) {
  const csprojPath = path.join(root, DOTNET_PLUGIN_CSPROJ);
  if (!existsSync(csprojPath)) return undefined;
  const match = readFileSync(csprojPath, "utf8").match(/<Version>([^<]+)<\/Version>/);
  return match?.[1];
}

export function updateDotnetPluginVersion(root, targetVersion) {
  const csprojPath = path.join(root, DOTNET_PLUGIN_CSPROJ);
  if (!existsSync(csprojPath)) return [];
  const source = readFileSync(csprojPath, "utf8");
  const updated = source.replace(
    /<Version>[^<]+<\/Version>/,
    `<Version>${dotnetPluginVersion(targetVersion)}</Version>`,
  );
  if (updated === source) return [];
  writeFileSync(csprojPath, updated);
  return [DOTNET_PLUGIN_CSPROJ];
}
