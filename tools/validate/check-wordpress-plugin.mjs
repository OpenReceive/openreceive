#!/usr/bin/env node
import { execFileSync } from "node:child_process";

// Plugin Check prints one JSON array per file and exits zero even for findings.
const output = execFileSync(
  "docker",
  [
    "exec",
    "-u",
    "www-data",
    "openreceive-wp-test-wordpress-1",
    "wp",
    "plugin",
    "check",
    "openreceive",
    "--format=json",
  ],
  { encoding: "utf8" },
);
process.stdout.write(output);
const findings = output
  .split("\n")
  .filter((line) => line.startsWith("["))
  .flatMap((line) => JSON.parse(line));
const errors = findings.filter((finding) => finding.type === "ERROR");
if (errors.length > 0) throw new Error(`Plugin Check reported ${errors.length} errors.`);
console.log(`Plugin Check: 0 errors, ${findings.length} warnings.`);
