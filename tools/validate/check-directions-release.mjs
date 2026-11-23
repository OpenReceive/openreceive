#!/usr/bin/env node
// Do the agent directions only name what the RELEASED packages ship?
//
// A merchant's agent follows the directions on openreceive.org and installs
// whatever npm serves, which is the latest release. The directions are
// written in this tree and reach the site with a docs sync, sometimes before
// the release that ships what they describe (`doctor --scan-build` and
// `test-invoice --amount=` once had to wait for one). check:public-api holds
// the tree's packages to the tree; nothing held the directions to the release.
//
// This installs the released @openreceive packages into a scratch project and
//   - type-checks every `import ... from "@openreceive/..."` the directions
//     show (a missing package, subpath or export fails), and
//   - checks every `npx openreceive <command>` and each of its `--flags`
//     against that release's own --help.
//
//   node tools/validate/check-directions-release.mjs            # docs/agents vs latest release
//   node tools/validate/check-directions-release.mjs --live     # what openreceive.org serves now
//   node tools/validate/check-directions-release.mjs --release 0.5.0
//
// It needs the npm registry (and the site, with --live). Exit 1 on a mismatch.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const agentsDir = path.join(repoRoot, "docs/agents");
const SITE = "https://openreceive.org/agent-directions";

const args = process.argv.slice(2);
const live = args.includes("--live");
const keep = args.includes("--keep");
const releaseIndex = args.indexOf("--release");
const release =
  releaseIndex === -1
    ? execFileSync("npm", ["view", "@openreceive/node", "version"], { encoding: "utf8" }).trim()
    : args[releaseIndex + 1];

/** slug -> directions text */
async function loadDirections() {
  const slugs = readdirSync(agentsDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3));
  const out = new Map();
  for (const slug of slugs) {
    if (!live) {
      out.set(slug, readFileSync(path.join(agentsDir, `${slug}.md`), "utf8"));
      continue;
    }
    const response = await fetch(`${SITE}/${slug}/full.md`);
    if (!response.ok) throw new Error(`${SITE}/${slug}/full.md answered ${response.status}`);
    out.set(slug, await response.text());
  }
  return out;
}

const IMPORT =
  /import\s+(type\s+)?(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+[\w$]+)?\s*from\s*["'](@openreceive\/[^"']+)["']|import\s*["'](@openreceive\/[^"']+)["']/g;

/** Every @openreceive import in the text: spec -> { names, sideEffect, where } */
function importsIn(text, slug, found) {
  for (const match of text.matchAll(IMPORT)) {
    const spec = match[4] ?? match[5];
    const entry = found.get(spec) ?? { names: new Map(), sideEffect: false, where: new Set() };
    entry.where.add(slug);
    if (match[5] !== undefined) entry.sideEffect = true;
    if (match[2] !== undefined) entry.names.set("default", slug);
    for (const part of (match[3] ?? "").split(",")) {
      const name = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        .trim();
      if (/^[\w$]+$/.test(name)) entry.names.set(name, slug);
    }
    found.set(spec, entry);
  }
}

const COMMAND =
  /npx openreceive ((?:scaffold payments|skills install|debug-report|doctor))((?: --?[a-z][a-z-]*(?:[ =](?!-)[^\s`'"]+)?)*)/g;

/** `npx openreceive <command>` uses: command -> Map(flag -> slug) */
function commandsIn(text, slug, found) {
  for (const match of text.matchAll(COMMAND)) {
    const flags = found.get(match[1]) ?? new Map();
    // A flag starts a token; `<file-or-url>` is a value, not `-or-url`.
    for (const token of match[2].split(/\s+/)) {
      const flag = /^(--?[a-z][a-z-]*)(?:=|$)/.exec(token);
      if (flag !== null) flags.set(flag[1], slug);
    }
    found.set(match[1], flags);
  }
}

function run(command, commandArgs, cwd) {
  return execFileSync(command, commandArgs, { cwd, encoding: "utf8", stdio: "pipe" });
}

const directions = await loadDirections();
const imports = new Map();
const commands = new Map();
for (const [slug, text] of directions) {
  importsIn(text, slug, imports);
  commandsIn(text, slug, commands);
}

const packages = new Set(["@openreceive/node"]);
for (const spec of imports.keys()) packages.add(spec.split("/").slice(0, 2).join("/"));

const scratch = mkdtempSync(path.join(tmpdir(), "openreceive-directions-release-"));
const problems = [];
try {
  writeFileSync(
    path.join(scratch, "package.json"),
    JSON.stringify({ name: "directions-release-check", private: true, type: "module" }),
  );
  // A package the release never published is a problem to report, not a crash.
  for (const name of [...packages]) {
    try {
      run("npm", ["view", `${name}@${release}`, "version"], scratch);
    } catch {
      const where = [...imports]
        .filter(([spec]) => spec === name || spec.startsWith(`${name}/`))
        .flatMap(([, entry]) => [...entry.where]);
      problems.push(`${[...new Set(where)].join(", ")}: ${name}@${release} was never published`);
      packages.delete(name);
      for (const spec of [...imports.keys()]) {
        if (spec === name || spec.startsWith(`${name}/`)) imports.delete(spec);
      }
    }
  }
  run(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      "--loglevel=error",
      ...[...packages].map((name) => `${name}@${release}`),
      "typescript@5",
      "@types/react@19",
      "@types/node@22",
    ],
    scratch,
  );

  // One import per line, so each diagnostic names the spec and the export.
  const lines = [];
  const lineSpec = [];
  for (const [spec, entry] of imports) {
    if (entry.sideEffect || entry.names.size === 0) {
      lines.push(`import "${spec}";`);
      lineSpec.push({ spec, name: undefined, where: [...entry.where] });
    }
    for (const [name, slug] of entry.names) {
      lines.push(
        name === "default"
          ? `import _${lines.length} from "${spec}";`
          : `import { ${name} as _${lines.length} } from "${spec}";`,
      );
      lineSpec.push({ spec, name, where: [slug] });
    }
  }
  mkdirSync(path.join(scratch, "src"));
  writeFileSync(path.join(scratch, "src/directions.ts"), `${lines.join("\n")}\nexport {};\n`);
  writeFileSync(path.join(scratch, "src/assets.d.ts"), 'declare module "*.css";\n');
  writeFileSync(
    path.join(scratch, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "es2022",
        module: "esnext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        strict: false,
        noEmit: true,
        skipLibCheck: true,
        noUnusedLocals: false,
        types: ["node"],
      },
      include: ["src"],
    }),
  );
  let output = "";
  try {
    run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "."], scratch);
  } catch (error) {
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  for (const diagnostic of output.matchAll(
    /src\/directions\.ts\((\d+),\d+\): error (TS\d+): (.*)/g,
  )) {
    const at = lineSpec[Number(diagnostic[1]) - 1];
    problems.push(
      `${at.where.join(", ")}: ${at.name === undefined ? `"${at.spec}"` : `{ ${at.name} } from "${at.spec}"`} — ${diagnostic[3]}`,
    );
  }
  // A side-effect import (a stylesheet) is only held to the exports map.
  for (const { spec, name, where } of lineSpec) {
    if (name !== undefined || !/\.css$/.test(spec)) continue;
    try {
      run(
        process.execPath,
        ["--input-type=module", "-e", `import.meta.resolve(${JSON.stringify(spec)})`],
        scratch,
      );
    } catch {
      problems.push(`${where.join(", ")}: "${spec}" is not in the released package's exports`);
    }
  }

  const bin = path.join(scratch, "node_modules/.bin/openreceive");
  for (const [command, flags] of commands) {
    let help;
    try {
      help = run(bin, [...command.split(" "), "--help"], scratch);
    } catch (error) {
      help = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    const top = run(bin, ["--help"], scratch);
    if (!top.includes(command.split(" ")[0])) {
      problems.push(`npx openreceive ${command}: no such command in ${release}`);
      continue;
    }
    for (const [flag, slug] of flags) {
      if (!help.includes(flag) && !top.includes(flag)) {
        problems.push(
          `${slug}: npx openreceive ${command} ${flag} — ${release}'s --help has no ${flag}`,
        );
      }
    }
  }
} finally {
  if (!keep) rmSync(scratch, { recursive: true, force: true });
  else console.log(`kept ${scratch}`);
}

const source = live ? SITE : "docs/agents";
const importCount = [...imports.values()].reduce(
  (sum, entry) => sum + entry.names.size + (entry.sideEffect ? 1 : 0),
  0,
);
const flagCount = [...commands.values()].reduce((sum, flags) => sum + flags.size, 0);
if (problems.length > 0) {
  console.error(`The directions in ${source} name what @openreceive ${release} does not ship:`);
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log(
  `${source}: ${directions.size} directions, ${importCount} imports from ${imports.size} entry points and ${commands.size} commands with ${flagCount} flags, all in @openreceive ${release}.`,
);
