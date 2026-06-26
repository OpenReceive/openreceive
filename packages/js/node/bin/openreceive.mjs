#!/usr/bin/env node

import { runOpenReceiveCli } from "../dist/cli.js";

const exitCode = await runOpenReceiveCli({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr
});

process.exitCode = exitCode;
