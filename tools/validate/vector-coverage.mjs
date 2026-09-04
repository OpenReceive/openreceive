// Vector coverage: every family under spec/test-vectors must be consumed by a
// test in every engine, or be excluded for that engine with a written reason in
// spec/test-vectors/coverage.json. Called from validate-spec.mjs (npm run check).
//
// A family is one spec/test-vectors/<family>.json file, or the http-golden/
// directory as the single family "http-golden". A consumer is a test source
// under one of the engine's roots that names the family as `<family>.json` or
// `vector("<family>")` (the crosslang harnesses' helper form).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { root } from "../shared/root.mjs";
import { walkFiles } from "../shared/walk-files.mjs";

const COVERAGE_PATH = "spec/test-vectors/coverage.json";
const VECTORS_DIR = "spec/test-vectors";
const NON_FAMILY_FILES = new Set(["coverage.json"]);

export function listVectorFamilies() {
  const families = [];
  for (const entry of readdirSync(path.join(root, VECTORS_DIR), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      families.push(entry.name);
    } else if (entry.name.endsWith(".json") && !NON_FAMILY_FILES.has(entry.name)) {
      families.push(entry.name.slice(0, -".json".length));
    }
  }
  return families.sort();
}

function consumerPatterns(family) {
  return [`${family}.json`, `vector("${family}")`, `vector('${family}')`, `${family}/`];
}

function engineSources(engine) {
  const files = [];
  for (const relativeRoot of engine.roots) {
    const absolute = path.join(root, relativeRoot);
    if (!existsSync(absolute)) continue;
    files.push(
      ...walkFiles(absolute, {
        filter: (entry) => engine.extensions.some((extension) => entry.endsWith(extension)),
      }),
    );
  }
  return files;
}

/**
 * Returns { failures: string[], report: string[] }. `failures` is empty when every
 * family is consumed or excluded in every present engine.
 */
export function checkVectorCoverage() {
  const coverage = JSON.parse(readFileSync(path.join(root, COVERAGE_PATH), "utf8"));
  const families = listVectorFamilies();
  const failures = [];
  const report = [];
  for (const [name, engine] of Object.entries(coverage.engines)) {
    const exclusions = engine.exclusions ?? {};
    for (const excluded of Object.keys(exclusions)) {
      if (!families.includes(excluded)) {
        failures.push(`${COVERAGE_PATH}: ${name} excludes unknown vector family ${excluded}`);
      }
    }
    const present = engine.roots.some((relativeRoot) => existsSync(path.join(root, relativeRoot)));
    if (!present) {
      report.push(`${name}: absent (no test root exists yet) — coverage not enforced`);
      continue;
    }
    const sources = engineSources(engine).map((file) => readFileSync(file, "utf8"));
    const missing = [];
    for (const family of families) {
      if (family in exclusions) continue;
      const patterns = consumerPatterns(family);
      const consumed = sources.some((text) => patterns.some((pattern) => text.includes(pattern)));
      if (!consumed) missing.push(family);
    }
    if (missing.length > 0) {
      failures.push(
        `${name} engine has no test consuming: ${missing.join(", ")}. ` +
          `Add a consumer under ${engine.roots.join(" | ")} or an exclusion with a reason in ${COVERAGE_PATH}.`,
      );
    }
    report.push(
      `${name}: ${families.length - Object.keys(exclusions).length} families consumed, ${Object.keys(exclusions).length} excluded`,
    );
  }
  return { failures, report };
}
