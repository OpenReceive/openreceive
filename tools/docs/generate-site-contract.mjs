#!/usr/bin/env node

// Writes docs/site-contract.json: the single file the openreceive.org repo
// reads to know everything it must publish for a given OpenReceive release.
//
// The site and the library ship from different repositories, so the coupling
// between them is a list of URLs. The agent directions hard-code that list —
// they tell an integrator's coding agent to fetch
// https://openreceive.org/guides/storage — and a paste that names a page the
// site does not serve is worse than no link at all, because the agent has no
// way to tell a 404 from a network failure and will invent the API instead.
//
// So the contract is generated from docs/manifest.json rather than maintained
// by hand on either side: every public doc becomes a route, the agent-direction
// payloads are listed with the bytes the copy button will serve, the pages the
// site owns are named, and the contributor docs are listed as never-publish.
// `tools/docs/generate-agent-directions.mjs` enforces the other half — no
// direction may link outside this contract.
//
// `--check` fails the gate when the committed contract is stale.

import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { markdownTwin, SITE_OWNED_PATHS, SITE_REDIRECTS } from "./site-paths.mjs";

const root = process.cwd();
const check = process.argv.includes("--check");
const TARGET = "docs/site-contract.json";

// Paths the site serves from a source in this repo under a name that is not
// /guides/<slug>. The site has published /api_docs since before the manifest
// existed, and the directions link to it.
const ALIASES = [{ path: "/api_docs", slug: "api-reference", kind: "api-docs" }];

const AGENT_PAYLOADS = [
  { path: "/agent-directions/node.md", source: "docs/agents/node.md", stack: "node" },
  { path: "/agent-directions/rails.md", source: "docs/agents/rails.md", stack: "rails" },
  { path: "/agent-directions/btcpay.md", source: "docs/agents/btcpay.md", stack: "btcpay" },
];

// Pages served under agent-discovery paths: site-owned names whose content is
// nonetheless a markdown source here. Rendered and twinned like a guide, but
// sourced outside docs/guides so they join neither the guides index nor the
// payload reading-list gate.
const AGENT_PAGES = [
  {
    path: "/agents",
    source: "docs/site/agents.md",
    kind: "agents-page",
    slug: "agents",
    title: "Using OpenReceive with coding agents",
    category: "agents",
  },
];

// The BTCPay Server home (contract v4): the plugin README, rendered as a page
// and twinned like a guide. A BTCPay merchant lands here, so it is sourced
// from the README the plugin ships with rather than a second copy under docs/;
// the screenshots it embeds become the contract's `assets[]`.
const PLUGIN_PAGES = [
  {
    path: "/btcpay",
    source: "packages/dotnet/BTCPayServer.Plugins.OpenReceive/README.md",
    kind: "plugin-readme",
    slug: "btcpay",
    title: "OpenReceive for BTCPay Server",
    category: "btcpay",
  },
];

// Images a published source embeds. Served verbatim at /assets/<path under
// docs/assets/>, so the renderer maps an <img src> (relative to the source
// file) to that URL. Collected from the source rather than listed by hand, so
// a screenshot added to the README cannot ship without its file — and a file
// outside docs/assets/ fails the build, because the site serves only that tree.
const ASSETS_ROOT = "docs/assets/";
const ASSET_TYPES = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};
function embeddedAssets(page) {
  const markdown = readFileSync(path.join(root, page.source), "utf8");
  const refs = [
    ...[...markdown.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]),
    ...[...markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1]),
  ];
  const assets = new Map();
  for (const ref of refs) {
    if (/^(https?:)?\/\//.test(ref)) continue;
    const file = path.normalize(path.join(path.dirname(page.source), ref));
    if (!file.startsWith(ASSETS_ROOT)) {
      throw new Error(
        `${TARGET}: ${page.source} embeds ${ref}, which resolves outside ${ASSETS_ROOT}; the site serves only that tree.`,
      );
    }
    const content_type = ASSET_TYPES[path.extname(file).toLowerCase()];
    if (!content_type) throw new Error(`${TARGET}: ${page.source} embeds ${ref}, an unknown asset type.`);
    const urlPath = `/assets/${file.slice(ASSETS_ROOT.length)}`;
    if (!assets.has(urlPath)) {
      assets.set(urlPath, {
        path: urlPath,
        source: file,
        content_type,
        bytes: statSync(path.join(root, file)).size,
        referenced_by: [page.path],
      });
    }
  }
  return [...assets.values()];
}

// Verbatim artifacts for machine discovery: serve `source`'s bytes at `path`
// with `content_type`, unrendered. /llms.txt is generated from the manifest by
// tools/docs/generate-llms-txt.mjs; /openapi.yaml is the normative HTTP
// contract, published as the exact repo file so the two can never drift.
const AGENT_ARTIFACTS = [
  {
    path: "/llms.txt",
    source: "docs/site/llms.txt",
    content_type: "text/markdown; charset=utf-8",
    kind: "llms-index",
  },
  {
    path: "/openapi.yaml",
    source: "spec/openapi/openreceive-http.v1.yaml",
    content_type: "application/yaml; charset=utf-8",
    kind: "openapi",
  },
];

const manifest = JSON.parse(readFileSync(path.join(root, "docs/manifest.json"), "utf8"));
const release = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const bySlug = new Map(manifest.docs.map((doc) => [doc.slug, doc]));

const publish = [];
for (const doc of manifest.docs) {
  if (!doc.public) continue;
  const urlPath = doc.slug === "guides" ? "/guides" : `/guides/${doc.slug}`;
  publish.push({
    path: urlPath,
    // The same document as raw markdown. The site renders `path` in the
    // browser, so `path` alone is unreadable to anything without a JS engine;
    // the directions link this one.
    markdown_path: markdownTwin(urlPath),
    source: doc.source_path,
    kind: doc.source_path.startsWith("docs/agents/") ? "agent-directions" : "guide",
    slug: doc.slug,
    title: doc.title,
    category: doc.category,
    bytes: statSync(path.join(root, doc.source_path)).size,
  });
}

for (const alias of ALIASES) {
  const doc = bySlug.get(alias.slug);
  if (!doc) throw new Error(`${TARGET}: alias ${alias.path} names unknown slug ${alias.slug}`);
  publish.push({
    path: alias.path,
    markdown_path: markdownTwin(alias.path),
    source: doc.source_path,
    kind: alias.kind,
    slug: doc.slug,
    title: doc.title,
    category: doc.category,
    bytes: statSync(path.join(root, doc.source_path)).size,
    alias_of: `/guides/${doc.slug}`,
  });
}

for (const page of AGENT_PAGES) {
  publish.push({
    path: page.path,
    markdown_path: markdownTwin(page.path),
    source: page.source,
    kind: page.kind,
    slug: page.slug,
    title: page.title,
    category: page.category,
    bytes: statSync(path.join(root, page.source)).size,
  });
}

const assets = [];
for (const page of PLUGIN_PAGES) {
  publish.push({
    path: page.path,
    markdown_path: markdownTwin(page.path),
    source: page.source,
    kind: page.kind,
    slug: page.slug,
    title: page.title,
    category: page.category,
    bytes: statSync(path.join(root, page.source)).size,
    // Where the page's relative image references resolve: see `assets[]`.
    assets_base: "/assets/",
  });
  assets.push(...embeddedAssets(page));
}

// The copy-button payloads are served as raw markdown as well as copied, so an
// agent that CAN fetch has one URL to fetch and everyone else pastes the same
// bytes.
const copyButton = AGENT_PAYLOADS.map(({ path: urlPath, source, stack }) => ({
  path: urlPath,
  source,
  kind: "agent-directions-payload",
  stack,
  content_type: "text/markdown; charset=utf-8",
  bytes: statSync(path.join(root, source)).size,
  copy_button: true,
  self_contained: true,
}));

const contract = {
  // v2 added `markdown_path` to every entry rendered from a source here: the
  // site must serve the raw markdown at that URL, because the agent directions
  // link it instead of the page. v3 adds `agent_discovery` — /llms.txt and
  // /openapi.yaml served verbatim from sources here, the /agents page, and the
  // head links. A version bump rather than an additive field both times,
  // because the skills and directions generated alongside the contract link
  // these URLs: a site that ignored the section would 404 links already
  // running in other people's editors. v4 adds the /btcpay page (the plugin
  // README rendered as the BTCPay Server home) and `assets[]`, the images a
  // published source embeds, served verbatim under /assets/. A bump again:
  // the README links nothing the site does not already serve, but a site that
  // ignored `assets[]` would render the BTCPay home with eight broken images.
  contract_version: 4,
  // The library release this documentation set belongs to. The site publishes
  // one release at a time; `docs_manifest_version` moves only when the shape of
  // the manifest itself changes.
  release_version: release,
  docs_manifest_version: manifest.version,
  generated_by: "tools/docs/generate-site-contract.mjs",
  how_to_update: "docs/internal/site-build.md",
  publish: [...publish, ...copyButton],
  // Images embedded by a publish[] entry (contract v4). Serve `source`'s bytes
  // at `path` with `content_type`; the renderer maps the source's relative
  // <img src> to `path`, in the page and in the markdown twin alike.
  assets,
  // Pages openreceive.org authors and owns. The agent directions link to these,
  // so removing or renaming one breaks a payload that is already pasted into
  // other people's editors and cannot be recalled.
  site_owned: SITE_OWNED_PATHS.map((urlPath) => ({ path: urlPath, must_exist: true })),
  // Permanent redirects the site must keep serving (an additive field:
  // contract v2 consumers that predate it ignore it safely).
  site_redirects: SITE_REDIRECTS.map((redirect) => ({ ...redirect, must_exist: true })),
  // Machine-discovery surface for coding agents (contract v3). `artifacts` are
  // served verbatim — the named source's exact bytes at `path`, with
  // `content_type`, no rendering and no chrome. `head_links` are obligations on
  // rendered pages: every page carries <link rel="describedby" href="/llms.txt">,
  // and every publish[] entry with a `markdown_path` links it as
  // <link rel="alternate" type="text/markdown" href="...">. `skills` points at
  // the installable agent skills this repo ships; the /agents page in
  // publish[] explains them to people.
  agent_discovery: {
    artifacts: AGENT_ARTIFACTS.map((artifact) => ({
      ...artifact,
      bytes: statSync(path.join(root, artifact.source)).size,
    })),
    head_links: {
      describedby: "/llms.txt",
      markdown_alternates: true,
    },
    skills: {
      repository: "https://github.com/OpenReceive/openreceive",
      names: ["integrate-openreceive", "debug-openreceive-payment"],
      claude_code: "/plugin marketplace add OpenReceive/openreceive",
      skills_cli: "npx skills add OpenReceive/openreceive",
    },
  },
  // Contributor documentation. Never publish these: they describe unreleased
  // internals, release keys and forbidden changes.
  never_publish: manifest.docs
    .filter((doc) => !doc.public)
    .map((doc) => ({ source: doc.source_path, slug: doc.slug })),
};

const serialized = `${JSON.stringify(contract, null, 2)}\n`;
const absolute = path.join(root, TARGET);
const current = (() => {
  try {
    return readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
})();

if (check && current !== serialized) {
  console.error(`error: ${TARGET} is stale. Run \`npm run generate:site-contract\`.`);
  process.exit(1);
}
if (!check && current !== serialized) writeFileSync(absolute, serialized);

console.log(
  `${check ? "Checked" : "Wrote"} ${TARGET}: ${publish.length} routes, ` +
    `${copyButton.length} copy payloads, ${assets.length} assets, ${contract.never_publish.length} never-publish.`,
);
