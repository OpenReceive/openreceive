#!/usr/bin/env node

// The three Node quickstarts (Express, Fastify, Next.js) share most of their
// prose: the migration step, the credentials block, the reference/onPaid
// paragraphs, the render notes, the verify step and the reading list. Only
// install, wiring and (for Next) render differ. That prose is copied three
// times rather than templated, because each page has to read as one document
// on the site and inline whole into its agent-directions payload.
//
// Copies drift. This gate is what stops it: every section fenced as
//
//   <!-- shared:begin <name> -->
//   …
//   <!-- shared:end <name> -->
//
// must be byte-identical in every quickstart that carries a block of that
// name, and a block that only one file carries is a mistake (drop the fence,
// or add the twin). Run with --check in `npm run check:docs`; without the
// flag it prints the same report.

import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();

export const QUICKSTARTS = [
  "docs/guides/quickstart-node.md",
  "docs/guides/quickstart-fastify.md",
  "docs/guides/quickstart-next.md",
];

const FENCE = /^<!-- shared:(begin|end) ([a-z0-9-]+) -->$/;

/** Named shared blocks of one quickstart, as { name: body }. */
export function sharedBlocks(markdown, file) {
  const blocks = new Map();
  let open = null;
  let body = [];
  for (const [index, line] of markdown.split("\n").entries()) {
    const fence = line.match(FENCE);
    if (!fence) {
      if (open !== null) body.push(line);
      continue;
    }
    const [, kind, name] = fence;
    if (kind === "begin") {
      if (open !== null)
        throw new Error(`${file}:${index + 1}: shared:begin ${name} inside ${open}`);
      if (blocks.has(name))
        throw new Error(`${file}:${index + 1}: shared block ${name} fenced twice`);
      open = name;
      body = [];
    } else {
      if (open !== name)
        throw new Error(`${file}:${index + 1}: shared:end ${name} closes ${open ?? "nothing"}`);
      blocks.set(name, body.join("\n"));
      open = null;
    }
  }
  if (open !== null) throw new Error(`${file}: shared block ${open} never closed`);
  return blocks;
}

const perFile = QUICKSTARTS.map((file) => ({
  file,
  blocks: sharedBlocks(readFileSync(path.join(root, file), "utf8"), file),
}));

const problems = [];
const names = new Set(perFile.flatMap(({ blocks }) => [...blocks.keys()]));
for (const name of [...names].sort()) {
  const carriers = perFile.filter(({ blocks }) => blocks.has(name));
  if (carriers.length < 2) {
    problems.push(
      `shared block "${name}" appears only in ${carriers[0].file}; a block one file carries is not shared — drop the fence or add it to a sibling.`,
    );
    continue;
  }
  const [first, ...rest] = carriers;
  for (const other of rest) {
    if (other.blocks.get(name) !== first.blocks.get(name)) {
      problems.push(
        `shared block "${name}" differs between ${first.file} and ${other.file}. Copy one over the other — the site inlines each quickstart whole, so the copies must not drift.`,
      );
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`error: ${problem}`);
  process.exit(1);
}

console.log(
  `Quickstart parity: ${names.size} shared blocks identical across ${QUICKSTARTS.length} guides (${[...names].sort().join(", ")}).`,
);
