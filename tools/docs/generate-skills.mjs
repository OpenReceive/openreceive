#!/usr/bin/env node

// Assembles the agent-skills tree and every copy of it that ships.
//
// skills/ is the canonical, hand-authored home (one directory per skill, the
// open SKILL.md format). Three things are generated from it rather than
// maintained by hand:
//
//   1. skills/integrate-openreceive/references/{node,rails,btcpay}.md are byte copies
//      of the agent-directions payloads (docs/agents/*.md) — already
//      version-stamped, size-budgeted, and link-checked by
//      generate-agent-directions.mjs, so the skill's per-stack detail cannot
//      drift from what openreceive.org hands out.
//   2. .agents/skills/ mirrors the whole tree for tools that discover repo
//      skills at that conventional path (GitHub Copilot, Codex); the Claude
//      Code plugin marketplace reads skills/ itself.
//   3. Each publishable npm package and gem carries its own skills/ copy,
//      because `npm pack` and `gem build` cannot reach outside the package
//      directory — an agent working in a project that installed OpenReceive
//      finds the skills without the network.
//
// Every openreceive.org URL in a skill must be a page the site serves, checked
// against the same servability rule as the agent directions. `--check` fails
// the gate when any generated reference or mirror is stale.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isServablePath, MARKDOWN_SUFFIX } from "./site-paths.mjs";

const root = process.cwd();
const check = process.argv.includes("--check");
const CANONICAL = "skills";

const GENERATED_REFERENCES = [
  { source: "docs/agents/node.md", target: "skills/integrate-openreceive/references/node.md" },
  { source: "docs/agents/rails.md", target: "skills/integrate-openreceive/references/rails.md" },
  { source: "docs/agents/btcpay.md", target: "skills/integrate-openreceive/references/btcpay.md" },
];

function mirrorRoots() {
  const mirrors = [".agents/skills"];
  for (const dir of readdirSync(path.join(root, "packages/js")).sort()) {
    if (existsSync(path.join(root, "packages/js", dir, "package.json"))) {
      mirrors.push(`packages/js/${dir}/skills`);
    }
  }
  for (const dir of readdirSync(path.join(root, "packages/ruby")).sort()) {
    if (existsSync(path.join(root, "packages/ruby", dir, `${dir}.gemspec`))) {
      mirrors.push(`packages/ruby/${dir}/skills`);
    }
  }
  return mirrors;
}

/** All file paths under `dir`, relative to it, sorted. */
function walk(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walk(path.join(dir, entry.name), relative));
    else files.push(relative);
  }
  return files;
}

const problems = [];
const stale = [];

function syncFile(target, content) {
  const absolute = path.join(root, target);
  const current = (() => {
    try {
      return readFileSync(absolute);
    } catch {
      return null;
    }
  })();
  if (current?.equals(content)) return;
  if (check) {
    stale.push(target);
    return;
  }
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

// 1. Generated references: the agent-directions payloads, byte for byte.
for (const { source, target } of GENERATED_REFERENCES) {
  syncFile(target, readFileSync(path.join(root, source)));
}

// 2. Validate the canonical tree: frontmatter that keeps the install name
// stable, and no link the site will not serve.
const manifest = JSON.parse(readFileSync(path.join(root, "docs/manifest.json"), "utf8"));
const publicSlugs = new Set(manifest.docs.filter((doc) => doc.public).map((doc) => doc.slug));
const canonicalDir = path.join(root, CANONICAL);
const skillDirs = readdirSync(canonicalDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

for (const skill of skillDirs) {
  const skillFile = path.join(canonicalDir, skill, "SKILL.md");
  if (!existsSync(skillFile)) {
    problems.push(`${CANONICAL}/${skill}/ has no SKILL.md.`);
    continue;
  }
  const frontmatter = readFileSync(skillFile, "utf8").match(/^---\n([\s\S]*?)\n---\n/);
  const name = frontmatter?.[1].match(/^name:\s*(\S+)\s*$/m)?.[1];
  if (name !== skill) {
    problems.push(
      `${CANONICAL}/${skill}/SKILL.md frontmatter name is ${JSON.stringify(name ?? null)}; it must equal the directory name so the installed skill keeps a stable invocation name.`,
    );
  }
  if (!frontmatter?.[1].match(/^description:/m)) {
    problems.push(`${CANONICAL}/${skill}/SKILL.md frontmatter has no description.`);
  }
}

const canonicalFiles = walk(canonicalDir);
for (const file of canonicalFiles) {
  if (!file.endsWith(".md")) continue;
  const content = readFileSync(path.join(canonicalDir, file), "utf8");
  const bad = new Set();
  for (const match of content.matchAll(/https:\/\/openreceive\.org(\/[^\s)\]<>"'`]*)?/g)) {
    const raw = (match[1] ?? "/").replace(/[,)]+$/, "");
    const url = raw.endsWith(MARKDOWN_SUFFIX) ? raw : raw.replace(/\.+$/, "");
    const [pathname] = url.split("#");
    if (!isServablePath(pathname, publicSlugs)) bad.add(pathname);
  }
  if (bad.size > 0) {
    problems.push(
      `${CANONICAL}/${file} links to openreceive.org ${[...bad].join(", ")}, which the site does not serve.`,
    );
  }
}

// 3. Mirrors: exact copies of the canonical tree, extra files removed.
const mirrors = mirrorRoots();
for (const mirror of mirrors) {
  const mirrorDir = path.join(root, mirror);
  for (const file of walk(mirrorDir)) {
    if (!canonicalFiles.includes(file)) {
      if (check) stale.push(`${mirror}/${file} (no longer in ${CANONICAL}/)`);
      else rmSync(path.join(mirrorDir, file));
    }
  }
  for (const file of canonicalFiles) {
    syncFile(`${mirror}/${file}`, readFileSync(path.join(canonicalDir, file)));
  }
}

if (stale.length > 0) {
  problems.push(
    `${stale.length} generated skill file(s) are stale (${stale.slice(0, 4).join(", ")}${stale.length > 4 ? ", …" : ""}). Run \`npm run generate:skills\`.`,
  );
}
if (problems.length > 0) {
  for (const problem of problems) console.error(`error: ${problem}`);
  process.exit(1);
}

console.log(
  `${check ? "Checked" : "Wrote"} ${CANONICAL}/: ${skillDirs.length} skills, ${canonicalFiles.length} files, mirrored to ${mirrors.length} locations`,
);
