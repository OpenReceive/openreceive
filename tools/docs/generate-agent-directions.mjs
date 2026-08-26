#!/usr/bin/env node

// Builds the agent directions that openreceive.org hands out behind its "Copy
// agent directions" button.
//
// The payload is a PROMPT, not a docs page: someone pastes it into Cursor,
// Claude or Codex, often on a free model, and it has to be absorbed in one
// message alongside their own application code. So it is assembled here rather
// than hand-maintained, and three things are enforced that discipline alone did
// not hold:
//
//   1. It is self-contained. The stack's quickstart is inlined verbatim, so an
//      agent that cannot fetch a URL — no network, a blocked github.com, a
//      sandbox with no tools at all — can still finish the integration.
//   2. It stays small. BUDGET_BYTES fails the build before the paste grows past
//      what a small model can hold. Every rule that only applies to a custom UI
//      lives in the checkout-ux guide instead.
//   3. Every openreceive.org URL it names is a page the site actually has to
//      serve. Links are checked against docs/manifest.json and the site-owned
//      allowlist below, so the payload cannot promise a 404.
//   4. Every link to a document is the `.md` twin, not the page. The site
//      renders guides in the browser, so fetching the page URL returns an empty
//      shell — a reading list of page URLs is a reading list of blank pages to
//      the one reader this file has.
//
// `--check` fails the gate when a committed payload is stale, oversized, or
// links somewhere the site does not publish.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  MARKDOWN_SUFFIX,
  MARKDOWN_TWINNED_SITE_PAGES,
  markdownTwin,
  SITE_OWNED_PATHS,
} from "./site-paths.mjs";

const root = process.cwd();
const check = process.argv.includes("--check");

// ~6k tokens. The ceiling is set by the smallest model someone might paste this
// into, not the largest: an 8k-token context still has to hold the payload, the
// files the agent is editing, and its own reply. Both payloads sat at ~30 KB
// before the UI rules moved into docs/guides/checkout-ux.md, which is the kind
// of growth this number exists to catch.
const BUDGET_BYTES = 24_000;

const STACKS = [
  {
    stack: "node",
    source: "docs/agents/src/node.md",
    quickstart: "docs/guides/quickstart-node.md",
  },
  {
    stack: "rails",
    source: "docs/agents/src/rails.md",
    quickstart: "docs/guides/quickstart-rails.md",
  },
];

const GUIDE_URL = (slug) => `https://openreceive.org/guides/${slug}`;
// What the payload actually links: raw markdown, fetchable without a browser.
const GUIDE_MARKDOWN_URL = (slug) => markdownTwin(GUIDE_URL(slug));

function readManifestSlugs() {
  const manifest = JSON.parse(readFileSync(path.join(root, "docs/manifest.json"), "utf8"));
  const bySourcePath = new Map();
  const publicSlugs = new Set();
  for (const doc of manifest.docs) {
    bySourcePath.set(doc.source_path, doc);
    if (doc.public) publicSlugs.add(doc.slug);
  }
  return { publicSlugs, bySourcePath };
}

/**
 * Inlines a guide under the directions. Headings drop one level so the guide's
 * `#` title becomes a `##` section of one document, and its sibling links
 * (`storage.md`, `api-reference.md#errors`) become the site URLs the payload
 * uses everywhere else — a relative path is meaningless once the file has been
 * pasted into a chat window. They keep their `.md`: the reader of a pasted
 * payload is an agent with a fetch tool, and the page URL would hand it an
 * empty application shell.
 */
export function inlineGuide(markdown, publicSlugs) {
  // A guide's trailing "Next" section is a list of links to its siblings. The
  // payload already carries its own reading list, so the copy costs budget to
  // say the same thing twice.
  const lines = markdown.replace(/\n## Next\n[\s\S]*$/, "\n").split("\n");
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    out.push(inFence || !/^#{1,5} /.test(line) ? line : `#${line}`);
  }
  return (
    out
      .join("\n")
      .replace(/\]\(([a-z0-9-]+)\.md(#[a-z0-9_-]+)?\)/g, (whole, slug, anchor) =>
        publicSlugs.has(slug) ? `](${GUIDE_MARKDOWN_URL(slug)}${anchor ?? ""})` : whole,
      )
      // A path into the repository (the demo app, a contributor doc) is dead
      // once the file has been pasted somewhere else, and cloning is not the
      // shape of this integration. Keep the name, drop the link.
      .replace(/\[([^\]]+)\]\(\.{1,2}\/[^)]+\)/g, "$1")
      .trim()
  );
}

function render(directions, quickstart, quickstartSlug, publicSlugs) {
  return [
    directions.trim(),
    "",
    "---",
    "",
    "## The quickstart, in full",
    "",
    "Inlined verbatim so this file needs no network access — follow it once Step 0",
    `passes. The page it comes from is ${GUIDE_URL(quickstartSlug)}.`,
    "",
    inlineGuide(quickstart, publicSlugs),
    "",
  ].join("\n");
}

/** Every openreceive.org URL in the payload has to be a page the site serves. */
export function unservedUrls(payload, publicSlugs) {
  const bad = [];
  for (const match of payload.matchAll(/https:\/\/openreceive\.org(\/[^\s)<>"'`]*)?/g)) {
    // A trailing `.` ends a sentence; `.md` is part of the path. Strip the
    // suffix first so prose punctuation cannot eat it.
    const raw = (match[1] ?? "/").replace(/[,)]+$/, "");
    const url = raw.endsWith(MARKDOWN_SUFFIX) ? raw : raw.replace(/\.+$/, "");
    const [pathname] = url.split("#");
    if (SITE_OWNED_PATHS.includes(pathname)) continue;
    if (servesMarkdown(pathname, publicSlugs)) continue;
    bad.push(pathname);
  }
  return [...new Set(bad)];
}

/**
 * `/guides/<slug>` and its `.md` twin, plus `/guides.md` and `/api_docs.md` —
 * the twins of the two site-owned pages the site generates from this repo.
 * `/contact.md` and friends are NOT twinned: those pages are hand-authored on
 * the site and there is no markdown behind them.
 */
function servesMarkdown(pathname, publicSlugs) {
  const isTwin = pathname.endsWith(MARKDOWN_SUFFIX);
  const page = isTwin ? pathname.slice(0, -MARKDOWN_SUFFIX.length) : pathname;
  if (isTwin && MARKDOWN_TWINNED_SITE_PAGES.includes(page)) return true;
  const guide = page.match(/^\/guides\/([a-z0-9-]+)$/);
  return Boolean(guide) && publicSlugs.has(guide[1]);
}

const { publicSlugs } = readManifestSlugs();
const problems = [];
const built = [];

for (const { stack, source, quickstart } of STACKS) {
  const target = `docs/agents/${stack}.md`;
  const quickstartSlug = path.basename(quickstart, ".md");
  const payload = render(
    readFileSync(path.join(root, source), "utf8"),
    readFileSync(path.join(root, quickstart), "utf8"),
    quickstartSlug,
    publicSlugs,
  );

  const bytes = Buffer.byteLength(payload, "utf8");
  if (bytes > BUDGET_BYTES) {
    problems.push(
      `${target}: ${bytes} bytes exceeds the ${BUDGET_BYTES}-byte paste budget. ` +
        `Move a rule into a guide (docs/guides/checkout-ux.md is where the UI rules went) ` +
        `or shorten ${quickstart}; do not raise the budget to fit.`,
    );
  }

  // Anything that is not an absolute URL or an in-document anchor cannot
  // survive being pasted into an editor.
  const relative = [...payload.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)].map((m) => m[1]);
  if (relative.length > 0) {
    problems.push(
      `${target}: ${relative.length} link(s) are not absolute — ${[...new Set(relative)].slice(0, 5).join(", ")}. ` +
        `A pasted payload has no repository to resolve them against.`,
    );
  }

  const unserved = unservedUrls(payload, publicSlugs);
  if (unserved.length > 0) {
    problems.push(
      `${target}: links to openreceive.org ${unserved.join(", ")}, which is neither a public ` +
        `doc in docs/manifest.json nor a site-owned path in SITE_OWNED_PATHS.`,
    );
  }

  const absolute = path.join(root, target);
  const current = (() => {
    try {
      return readFileSync(absolute, "utf8");
    } catch {
      return null;
    }
  })();

  if (check) {
    if (current !== payload) {
      problems.push(`${target} is stale. Run \`npm run generate:agent-directions\`.`);
    }
  } else if (current !== payload) {
    writeFileSync(absolute, payload);
  }
  built.push({ target, bytes, source, quickstart });
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`error: ${problem}`);
  process.exit(1);
}

for (const { target, bytes } of built) {
  const percent = Math.round((bytes / BUDGET_BYTES) * 100);
  console.log(
    `${check ? "Checked" : "Wrote"} ${target}: ${bytes} bytes (${percent}% of budget, ~${Math.round(bytes / 4000)}k tokens)`,
  );
}
