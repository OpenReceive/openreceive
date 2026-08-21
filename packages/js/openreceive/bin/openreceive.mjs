#!/usr/bin/env node

// The umbrella owns this command so `npm install openreceive` provides it under
// package managers that never hoist a transitive dependency's bin (pnpm, Yarn
// PnP). @openreceive/node still implements the CLI; this only forwards.
import { runOpenReceiveCli } from "@openreceive/node/cli";

// loadEnvFile exists from Node 20.12; missing .env is fine either way.
if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const exitCode = await runOpenReceiveCli({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
});

process.exitCode = exitCode;
