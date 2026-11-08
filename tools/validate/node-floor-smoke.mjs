#!/usr/bin/env node
// The oldest Node a published package promises (`"engines": { "node": ">=22" }`),
// run for real: every server-side package imports, and `openreceive doctor
// --db` reads an app's SQLite file the way that app would. On Node 22.5–22.12
// node:sqlite sits behind a flag (before 22.5 it does not exist), so an app
// there uses better-sqlite3; 0.4.31's doctor failed a check such an app
// passed (video 12, 2026-11-06). The rest of the suite runs on the newest
// Node, where neither shows.
//
// Run after `npm run build:packages`, on the Node under test:
//   node tools/validate/node-floor-smoke.mjs
// CI runs it on 22.0.0, 22.12.0 and 22.13.0 (.github/workflows/ci.yml, node-floor).

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(repoRoot, "package.json"));

/** The packages a server imports: nothing here needs a browser or a framework peer. */
const SERVER_PACKAGES = [
  "@openreceive/core",
  "@openreceive/provider-data",
  "@openreceive/http",
  "@openreceive/node",
  "@openreceive/express",
  "@openreceive/fastify",
];

const failures = [];
console.log(`node-floor smoke on Node ${process.version}`);

for (const name of SERVER_PACKAGES) {
  try {
    const mod = await import(name);
    if (Object.keys(mod).length === 0) throw new Error("no exports");
    console.log(`import ${name}: ok`);
  } catch (error) {
    failures.push(`import ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** An app on this Node: better-sqlite3 in its own node_modules, and the two OpenReceive tables. */
const app = mkdtempSync(path.join(tmpdir(), "openreceive-node-floor-"));
try {
  mkdirSync(path.join(app, "node_modules"), { recursive: true });
  for (const dependency of ["better-sqlite3", "bindings", "file-uri-to-path"]) {
    const source = path.dirname(require.resolve(`${dependency}/package.json`));
    symlinkSync(source, path.join(app, "node_modules", dependency), "dir");
  }
  writeFileSync(path.join(app, "package.json"), '{ "name": "floor-app", "type": "module" }\n');
  const Database = require("better-sqlite3");
  const database = new Database(path.join(app, "app.sqlite"));
  database.exec(
    "CREATE TABLE openreceive_payments (id TEXT); CREATE TABLE openreceive_meta (name TEXT);",
  );
  database.close();

  const cli = path.join(repoRoot, "packages/js/node/bin/openreceive.mjs");
  const env = { ...process.env };
  delete env.NWC_URI;
  delete env.NODE_OPTIONS;
  let output = "";
  try {
    output = execFileSync(process.execPath, [cli, "doctor", "--offline", "--db", "app.sqlite"], {
      cwd: app,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // Doctor exits 1 here because NWC_URI is unset on purpose; the database line is what counts.
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  const line = output.split("\n").find((text) => text.startsWith("database:")) ?? "";
  if (!/openreceive_payments and openreceive_meta present/.test(line)) {
    failures.push(`doctor --db on a better-sqlite3 app: ${line || output.slice(-400)}`);
  } else {
    console.log(`doctor --db: ${line}`);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`node-floor smoke failed on Node ${process.version}:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("node-floor smoke: ok");
