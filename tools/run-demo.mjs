#!/usr/bin/env node

// Convenience launcher for the dockerized demos.
//
//   npm run demo node      -> Buy a Button, Express + React/Vue/Svelte/Angular (:3000)
//   npm run demo static    -> Buy a Button, static HTML + small API            (:3001)
//   npm run demo nextjs    -> Buy a Button, Next.js fullstack                  (:3002)
//   npm run demo buttons   -> Buy a Button, Rails + Postgres                  (:3003)
//   npm run demo fastify   -> Buy a Button, Fastify + React                   (:3004)
//   npm run demo btcpayserver -> BTCPay plugin + .env wallet/providers       (:14180)
//
// It ensures the repo-root .env exists, validates NWC_URI,
// and runs the compose stack with the local port-publishing override.

import { spawn } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OPENRECEIVE_DEMOS } from "./shared/demo-catalog.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

const DEMOS = OPENRECEIVE_DEMOS;

function usage() {
  const targets = DEMOS.map(
    (demo) => `  ${demo.keys[0].padEnd(12)} ${demo.label.padEnd(24)} http://localhost:${demo.port}`,
  ).join("\n");
  console.log(
    `Usage: npm run demo <target> [-- extra docker compose args]\n\n` +
      `Targets:\n${targets}\n\n` +
      `Shop demo args after -- are forwarded to "docker compose up", e.g. detached:\n` +
      `  npm run demo node -- -d\n\n` +
      `BTCPay starts in the background with your mainnet NWC_URI and LSC_URI_* from .env.\n` +
      `  npm run demo btcpayserver -- --no-build   Reuse the previous build\n` +
      `  npm run demo btcpayserver -- --stop       Stop and preserve demo data\n` +
      `  npm run demo btcpayserver -- --testkit    Use funded regtest wallets instead of .env\n`,
  );
}

const [selector, ...extra] = process.argv.slice(2);

if (selector === undefined || selector === "--help" || selector === "-h") {
  usage();
  process.exit(selector === undefined ? 1 : 0);
}

const demo = DEMOS.find((entry) => entry.keys.includes(selector));
if (demo === undefined) {
  console.error(`Unknown demo target: ${selector}\n`);
  usage();
  process.exit(1);
}

// BTCPay builds in Docker and configures its store through the server-side API.
// It does not need compiled JS payment packages.
if (demo.kind === "btcpay") {
  const args = extra.filter((arg) => arg !== "--");
  if (
    args.some((arg) => !["--testkit", "--no-build", "--stop"].includes(arg)) ||
    (args.includes("--stop") && args.includes("--no-build"))
  ) {
    console.error("BTCPay options: [--testkit] [--no-build | --stop]");
    process.exit(1);
  }
  const run = (command, commandArgs) =>
    new Promise((resolve) => {
      const child = spawn(command, commandArgs, { cwd: root, stdio: "inherit", env: process.env });
      child.on("error", (error) => {
        console.error(`Could not run ${command}: ${error.message}`);
        resolve(1);
      });
      child.on("exit", (code, signal) => resolve(signal ? 1 : (code ?? 0)));
    });
  const testkit = args.includes("--testkit");
  if (args.includes("--stop")) {
    process.exit(
      await run("bash", [
        path.join(demo.dir, testkit ? "down.sh" : "live.sh"),
        ...(testkit ? [] : ["--stop"]),
      ]),
    );
  }
  if (!testkit) {
    const envPath = path.join(root, ".env");
    if (existsSync(envPath)) process.loadEnvFile(envPath);
    if (!process.env.NWC_URI?.trim()) {
      console.error(
        "Set NWC_URI in the root .env (see .env.example), or use --testkit for local regtest wallets.",
      );
      process.exit(1);
    }
  }
  const submodule = "packages/dotnet/submodules/btcpayserver";
  if (!existsSync(path.join(root, submodule, "BTCPayServer/BTCPayServer.csproj"))) {
    const code = await run("git", ["submodule", "update", "--init", "--depth", "1", submodule]);
    if (code !== 0) process.exit(code);
  }
  const code = await run("bash", [
    path.join(demo.dir, testkit ? "up.sh" : "live.sh"),
    ...args.filter((arg) => arg !== "--testkit"),
  ]);
  if (code === 0) {
    if (!testkit) {
      try {
        const { configureLiveDemo } = await import("./dotnet/demo-live.mjs");
        const configured = await configureLiveDemo({ root });
        console.log(
          `Mainnet wallet configured; swaps ${configured.swapsEnabled ? "enabled" : "disabled (no LSC_URI_PRIMARY)"}.`,
        );
        console.log(`Login: ${configured.email} / ${configured.password}`);
      } catch (error) {
        console.error(error.message);
        process.exit(1);
      }
    }
    console.log(`\nBTCPay is ready: http://127.0.0.1:${demo.port}`);
    if (testkit)
      console.log("On the first visit, register an administrator account to configure your store.");
    console.log(
      `The stack keeps running in Docker. Stop it with: npm run demo btcpayserver -- ${testkit ? "--testkit " : ""}--stop`,
    );
  }
  process.exit(code);
}

// Compose reads the repo-root .env. Create it from the safe committed template
// so the credential variables have a home before the user fills them in.
const envPath = path.join(root, ".env");
if (!existsSync(envPath)) {
  copyFileSync(path.join(root, ".env.example"), envPath);
  console.log("Created .env from .env.example.");
}
process.loadEnvFile(envPath);

try {
  const { readRequiredShopNwcConnectionString } = await import(
    "../examples/buttons/shared/server-node/nwc.ts"
  );
  readRequiredShopNwcConnectionString();
} catch (error) {
  console.error(
    ["", "Cannot start the demo.", error instanceof Error ? error.message : String(error), ""].join(
      "\n",
    ),
  );
  process.exit(1);
}

const composeArgs = [
  "compose",
  "-f",
  "compose.yml",
  "-f",
  "compose.override.yml.example",
  "up",
  "--build",
  ...extra,
];

console.log(`Starting ${demo.label} demo -> http://localhost:${demo.port}\n`);

const child = spawn("docker", composeArgs, {
  cwd: path.join(root, demo.dir),
  stdio: "inherit",
  env: process.env,
});

child.on("error", (error) => {
  if (error.code === "ENOENT") {
    console.error("Could not run `docker`. Install Docker and ensure it is on PATH.");
  } else {
    console.error(`Failed to start docker compose: ${error.message}`);
  }
  process.exit(1);
});

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
