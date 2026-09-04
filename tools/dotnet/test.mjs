#!/usr/bin/env node

// `npm run test:dotnet`: the C# engine's unit suite (the BTCPay plugin's vector
// conformance + kernel tests). Prints a clear SKIP — never a silent pass — when
// the machine has no .NET 10 SDK or the BTCPay submodule is not initialized,
// mirroring test:live:nwc's skip convention. Set BTCPAY_SERVER_ROOT to reuse an
// existing BTCPay checkout instead of the submodule.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { root } from "../shared/root.mjs";

const dotnetDir = path.join(root, "packages", "dotnet");
const testProject = path.join(dotnetDir, "BTCPayServer.Plugins.OpenReceive.Tests");
const btcpayRoot =
  process.env.BTCPAY_SERVER_ROOT ?? path.join(dotnetDir, "submodules", "btcpayserver");
const filter = process.argv.includes("--filter")
  ? process.argv[process.argv.indexOf("--filter") + 1]
  : undefined;

function skip(reason) {
  console.log(`test:dotnet SKIPPED — ${reason}`);
  process.exit(0);
}

const version = spawnSync("dotnet", ["--version"], { encoding: "utf8" });
if (version.status !== 0 || version.error) {
  skip("no `dotnet` on PATH (install the .NET 10 SDK; on this machine it may live in ~/.dotnet).");
}
const major = Number.parseInt(version.stdout.trim().split(".")[0] ?? "0", 10);
if (!Number.isInteger(major) || major < 10) {
  skip(
    `dotnet ${version.stdout.trim()} found; the plugin needs the .NET 10 SDK (packages/dotnet/global.json).`,
  );
}
if (!existsSync(path.join(btcpayRoot, "BTCPayServer", "BTCPayServer.csproj"))) {
  skip(
    "BTCPay Server source not found. Run `git submodule update --init --depth 1 packages/dotnet/submodules/btcpayserver` " +
      "or point BTCPAY_SERVER_ROOT at a BTCPay checkout.",
  );
}

const args = ["test", testProject, "-nologo", "-v", "q"];
if (filter) args.push("--filter", filter);
console.log(`test:dotnet: dotnet ${args.join(" ")}`);
const result = spawnSync("dotnet", args, {
  cwd: dotnetDir,
  stdio: "inherit",
  env: {
    ...process.env,
    BTCPAY_SERVER_ROOT: btcpayRoot,
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_NOLOGO: "1",
  },
});
process.exit(result.status ?? 1);
