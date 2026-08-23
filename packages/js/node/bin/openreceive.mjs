#!/usr/bin/env node

import { runCli } from "../dist/cli.js";

// loadEnvFile exists from Node 20.12; missing .env is fine either way.
if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const exitCode = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
});

process.exitCode = exitCode;
