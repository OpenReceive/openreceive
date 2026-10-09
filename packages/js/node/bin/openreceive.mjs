#!/usr/bin/env node

import { runCli } from "../dist/cli.js";

// No process.loadEnvFile() here: doctor reads .env.local, then .env itself and
// names the files it used. Loading .env first hid it from that report and let
// it win over .env.local.
const exitCode = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
});

process.exitCode = exitCode;
