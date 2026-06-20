#!/usr/bin/env node

// Convenience launcher for the dockerized Hello Fruit demos.
//
//   npm run demo node      -> Express + React        (http://localhost:3000)
//   npm run demo static    -> Static HTML + small API (http://localhost:3001)
//   npm run demo nextjs    -> Next.js fullstack       (http://localhost:3002)
//   npm run demo rails     -> Rails + Hotwire         (http://localhost:3003)
//
// It ensures the repo-root .env exists, warns when no wallet is configured,
// and runs the compose stack with the local port-publishing override.

import { spawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

const DEMOS = [
  {
    keys: ["node", "node-express-react", "express"],
    dir: "examples/hello-fruit/server/node-express-react",
    port: 3000,
    label: "Express + React",
    requiresUnauthenticatedDemoAck: true
  },
  {
    keys: ["static", "static-html-small-api", "html"],
    dir: "examples/hello-fruit/server/static-html-small-api",
    port: 3001,
    label: "Static HTML + small API",
    requiresUnauthenticatedDemoAck: true
  },
  {
    keys: ["nextjs", "next", "nextjs-fullstack"],
    dir: "examples/hello-fruit/server/nextjs-fullstack",
    port: 3002,
    label: "Next.js fullstack",
    requiresUnauthenticatedDemoAck: true
  },
  {
    keys: ["rails", "rails-hotwire", "hotwire"],
    dir: "examples/hello-fruit/server/rails-hotwire",
    port: 3003,
    label: "Rails + Hotwire",
    requiresUnauthenticatedDemoAck: false
  }
];

function usage() {
  const targets = DEMOS.map(
    (demo) => `  ${demo.keys[0].padEnd(8)} ${demo.label.padEnd(24)} http://localhost:${demo.port}`
  ).join("\n");
  console.log(
    `Usage: npm run demo <target> [-- extra docker compose args]\n\n` +
      `Targets:\n${targets}\n\n` +
      `Extra args after -- are forwarded to "docker compose up", e.g. detached:\n` +
      `  npm run demo node -- -d\n`
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

// Compose reads the repo-root .env as an optional env_file. Create it from the
// committed example so OPENRECEIVE_NWC has a home before the user fills it in.
const envPath = path.join(root, ".env");
if (!existsSync(envPath)) {
  copyFileSync(path.join(root, ".env.example"), envPath);
  console.log("Created .env from .env.example.");
}

let envText = readFileSync(envPath, "utf8");

// The JS demo images run with NODE_ENV=production and an unauthenticated
// single-user checkout, so their Express guard refuses to start without an
// explicit opt-in. Ensure it is present for those local runs, but never override
// a deliberate OPENRECEIVE_ALLOW_UNAUTHENTICATED_DEMO=false.
const ackKey = "OPENRECEIVE_ALLOW_UNAUTHENTICATED_DEMO";
if (demo.requiresUnauthenticatedDemoAck && !new RegExp(`^\\s*${ackKey}\\s*=`, "m").test(envText)) {
  const ackBlock =
    `\n# Added by \`npm run demo\`: the demo image runs NODE_ENV=production with an\n` +
    `# unauthenticated single-user checkout, which the server otherwise refuses.\n` +
    `${ackKey}=true\n`;
  appendFileSync(envPath, ackBlock);
  envText += ackBlock;
  console.log(`Added ${ackKey}=true to .env (required by the production-mode demo image).`);
}

// The demo serves the checkout UI even with no wallet, but every invoice call
// returns 503 WALLET_UNAVAILABLE until a receive-only NWC string is set.
const nwcMatch = envText.match(/^\s*OPENRECEIVE_NWC\s*=\s*(.*)$/m);
const nwcConfigured = nwcMatch !== null && nwcMatch[1].trim().length > 0;
if (!nwcConfigured) {
  console.warn(
    "\nWARNING: OPENRECEIVE_NWC is not set in .env.\n" +
      "  The checkout UI will load, but creating an invoice (buying fruit) returns\n" +
      "  503 WALLET_UNAVAILABLE. Set a receive-only NWC string from a wallet you\n" +
      "  control (e.g. Rizful or Alby Hub) in .env, then re-run.\n"
  );
}

const composeArgs = [
  "compose",
  "-f",
  "compose.yml",
  "-f",
  "compose.override.yml.example",
  "up",
  "--build",
  ...extra
];

console.log(`Starting ${demo.label} demo -> http://localhost:${demo.port}\n`);

const child = spawn("docker", composeArgs, {
  cwd: path.join(root, demo.dir),
  stdio: "inherit"
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
  process.exit(signal ? 1 : code ?? 0);
});
