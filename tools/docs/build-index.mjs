#!/usr/bin/env node

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const manifestPath = path.join(root, "docs/manifest.json");
const outDir = path.join(root, "dist/docs");

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${path.relative(root, filePath)}: ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeJson(relativePath, value) {
  writeFileSync(path.join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

function validateDocEntry(entry, index, seenSlugs) {
  const label = `docs[${index}]`;
  assert(typeof entry.slug === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.slug), `${label}: invalid slug`);
  assert(!seenSlugs.has(entry.slug), `${label}: duplicate slug ${entry.slug}`);
  seenSlugs.add(entry.slug);

  assert(typeof entry.title === "string" && entry.title.trim() !== "", `${label}: missing title`);
  assert(typeof entry.category === "string" && entry.category.trim() !== "", `${label}: missing category`);
  assert(typeof entry.public === "boolean", `${label}: public must be boolean`);
  assert(typeof entry.source_path === "string", `${label}: missing source_path`);

  const normalized = path.normalize(entry.source_path);
  assert(normalized === entry.source_path, `${label}: source_path must be normalized`);
  assert(normalized.startsWith("docs/"), `${label}: source_path must stay under docs/`);
  assert(normalized.endsWith(".md"), `${label}: source_path must reference markdown`);

  const absolute = path.join(root, normalized);
  assert(path.relative(path.join(root, "docs"), absolute).startsWith("..") === false, `${label}: source_path escapes docs/`);

  return absolute;
}

function firstHeading(markdown) {
  const heading = markdown.split("\n").find((line) => line.startsWith("# "));
  return heading ? heading.replace(/^#\s+/, "").trim() : "";
}

function searchText(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[[^\]]+\]\([^)]+\)/g, " ")
    .replace(/[#>*_\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const manifest = readJson(manifestPath);
assert(typeof manifest.version === "string" && manifest.version !== "", "manifest version is required");
assert(typeof manifest.generated_at === "string" && manifest.generated_at !== "", "manifest generated_at is required");
assert(Array.isArray(manifest.docs), "manifest docs must be an array");

const seenSlugs = new Set();
const indexDocs = manifest.docs.map((entry, index) => {
  const absolute = validateDocEntry(entry, index, seenSlugs);
  const markdown = readFileSync(absolute, "utf8");
  const heading = firstHeading(markdown);
  const text = searchText(markdown);

  assert(heading !== "", `${entry.source_path}: missing top-level heading`);

  return {
    slug: entry.slug,
    title: entry.title,
    category: entry.category,
    source_path: entry.source_path,
    public: entry.public,
    heading,
    text,
    word_count: text === "" ? 0 : text.split(" ").length
  };
});

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeJson("dist/docs/manifest.json", manifest);
writeJson("dist/docs/search-index.json", {
  version: manifest.version,
  generated_at: manifest.generated_at,
  docs: indexDocs
});

console.log(`Built docs index for ${indexDocs.length} documents.`);
