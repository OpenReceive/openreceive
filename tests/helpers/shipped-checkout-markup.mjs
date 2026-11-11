// The <openreceive-checkout> tags this repository ships: the ones the store
// plugins print, and the ones the guides and agent directions tell a developer
// or an agent to paste. Read from the files themselves, so a new integration or
// a new guide snippet is tested the day it is written, with no list to update.
//
// A tag's SHAPE is its attribute names in the order they are written. Order is
// part of the shape: a browser that upgrades the element calls
// attributeChangedCallback once per attribute, in this order (issue 137).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { walkFiles } from "../../tools/shared/walk-files.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Where shipped markup lives. Copies (skills folders) and tests are left out. */
const SOURCES = [
  // Store plugins and framework packages: markup a merchant's site prints.
  { dir: "packages/php", kind: "plugin" },
  { dir: "packages/python", kind: "plugin" },
  { dir: "packages/ruby", kind: "plugin" },
  // What developers copy.
  { dir: "docs/guides", kind: "guide" },
  { dir: "docs/recipes", kind: "guide" },
  // What coding agents are told to write. Today the directions name the tag in
  // prose and send the agent to a guide for the markup; a tag added here is read.
  { dir: "docs/agents/src", kind: "directions" },
  // Starters people deploy as they are.
  { dir: "examples", kind: "starter" },
];

const IGNORED_DIRS = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  ".venv",
  "skills",
  "tests",
  "test",
  "__pycache__",
  ".next",
  "tmp",
  "log",
  "storage",
]);

const TEXT_FILE =
  /\.(?:php|twig|html?|erb|py|xml|md|tpl|vue|svelte|[cm]?[jt]sx?|hbs|ejs|njk|j2|jinja2?)$/;

const OPEN = /<openreceive-checkout(?=\s)/g;

/**
 * The text of one open tag, from just after the tag name to its closing `>`.
 * A `>` inside a quoted value does not close it (PHP's `$order->id`, ERB's
 * `%>`), and a tag that runs past 900 characters is prose, not markup.
 */
function openTagText(text, from) {
  let quoted = false;
  for (let index = from; index < Math.min(text.length, from + 900); index += 1) {
    const char = text[index];
    if (char === '"') quoted = !quoted;
    else if (char === ">" && !quoted && !"-=%?".includes(text[index - 1])) {
      return text.slice(from, index);
    }
  }
  return undefined;
}

/**
 * Attribute names of one open tag, in written order. Quoted values are
 * emptied first, so nothing inside a value reads as a name; what PHP runs
 * between two `echo` strings is dropped; QWeb's `t-att-reference` is the
 * attribute `reference`, and its tag may close itself (`/>`); Astro and JSX
 * write `reference={order.id}`.
 */
function attributeNames(openTag) {
  const names = [];
  const bare = openTag
    .replace(/';[\s\S]*?echo\s+'/g, " ")
    .replace(/"[^"]*"/g, '""')
    .replace(/=\{[^{}]*\}/g, '=""')
    .replace(/['/]\s*$/, "");
  for (const token of bare.split(/\s+/)) {
    const match = /^(?:t-attf?-)?([a-z][a-z0-9-]*)(?:="")?$/.exec(token);
    if (match !== null) names.push(match[1]);
    else if (token !== "") return undefined;
  }
  return names;
}

/**
 * Every shipped tag: `{ file, line, kind, names }`, `names` being its
 * attribute names in written order. Tags without a `reference` are
 * snapshot-mode examples and are left out: only a create-mode tag talks to the
 * server on its own. `unreadable` lists tags this reader could not parse, so a
 * test can refuse to let one go untested.
 */
export function shippedCheckoutTags() {
  const tags = [];
  const unreadable = [];
  for (const { dir, kind } of SOURCES) {
    const files = walkFiles(path.join(repoRoot, dir), {
      ignoreDirs: IGNORED_DIRS,
      filter: (name) => TEXT_FILE.test(name),
    });
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("<openreceive-checkout")) continue;
      for (const match of text.matchAll(OPEN)) {
        const where = `${path.relative(repoRoot, file)}:${text.slice(0, match.index).split("\n").length}`;
        const openTag = openTagText(text, match.index + match[0].length);
        const names = openTag === undefined ? undefined : attributeNames(openTag);
        if (names === undefined) {
          unreadable.push(where);
          continue;
        }
        if (!names.includes("reference")) continue;
        tags.push({ where, kind, names });
      }
    }
  }
  return { tags, unreadable };
}

/** The distinct shapes among {@link shippedCheckoutTags}, each with every place that writes it. */
export function shippedCheckoutShapes() {
  const shapes = new Map();
  for (const tag of shippedCheckoutTags().tags) {
    const key = tag.names.join(" ");
    if (!shapes.has(key)) shapes.set(key, { names: tag.names, writtenBy: [] });
    shapes.get(key).writtenBy.push(tag.where);
  }
  return [...shapes.values()];
}
