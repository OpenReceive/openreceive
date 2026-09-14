// The BTCPay plugin releases independently of the npm workspace.
// BTCPay reads the assembly's informational version from the csproj <Version>.
// The general release gate checks its format but never changes it.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const DOTNET_PLUGIN_CSPROJ = path.join(
  "packages",
  "dotnet",
  "BTCPayServer.Plugins.OpenReceive",
  "BTCPayServer.Plugins.OpenReceive.csproj",
);

export function readDotnetPluginVersion(root) {
  const csprojPath = path.join(root, DOTNET_PLUGIN_CSPROJ);
  if (!existsSync(csprojPath)) return undefined;
  const match = readFileSync(csprojPath, "utf8").match(/<Version>([^<]+)<\/Version>/);
  return match?.[1];
}
