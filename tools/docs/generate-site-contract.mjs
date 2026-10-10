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

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { OPENRECEIVE_DEMOS } from "../shared/demo-catalog.mjs";
import {
  AGENT_PAYLOAD_PATHS,
  agentFullPath,
  markdownTwin,
  PLATFORM_INDEX_PATH,
  PLATFORM_PATHS,
  SITE_OWNED_PATHS,
  SITE_REDIRECTS,
} from "./site-paths.mjs";

const root = process.cwd();
const check = process.argv.includes("--check");
const TARGET = "docs/site-contract.json";

// Paths the site serves from a source in this repo under a name that is not
// /guides/<slug>. The site has published /api_docs since before the manifest
// existed, and the directions link to it.
const ALIASES = [{ path: "/api_docs", slug: "api-reference", kind: "api-docs" }];

const AGENT_PAYLOADS = [
  {
    path: "/agent-directions/woocommerce.md",
    source: "docs/agents/woocommerce.md",
    stack: "woocommerce",
  },
  { path: "/agent-directions/node.md", source: "docs/agents/node.md", stack: "node" },
  { path: "/agent-directions/fastify.md", source: "docs/agents/fastify.md", stack: "fastify" },
  { path: "/agent-directions/next.md", source: "docs/agents/next.md", stack: "next" },
  { path: "/agent-directions/fastapi.md", source: "docs/agents/fastapi.md", stack: "fastapi" },
  { path: "/agent-directions/django.md", source: "docs/agents/django.md", stack: "django" },
  { path: "/agent-directions/rails.md", source: "docs/agents/rails.md", stack: "rails" },
  { path: "/agent-directions/php.md", source: "docs/agents/php.md", stack: "php" },
  { path: "/agent-directions/laravel.md", source: "docs/agents/laravel.md", stack: "laravel" },
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
    path: "/wordpress",
    source: "packages/php/wordpress/README.md",
    kind: "plugin-readme",
    slug: "wordpress",
    title: "OpenReceive for WordPress + WooCommerce",
    category: "woocommerce",
    video: null,
  },
  {
    path: "/btcpay",
    source: "packages/dotnet/BTCPayServer.Plugins.OpenReceive/README.md",
    kind: "plugin-readme",
    slug: "btcpay",
    title: "OpenReceive for BTCPay Server",
    category: "btcpay",
    // The demo video, played inline at the top of the page. GitHub renders a
    // README video only from an upload through github.com, so the README
    // carries that attachment URL and the site plays this copy instead.
    video: {
      source: "docs/assets/btcpayserver/basic-btcpayserver-demo-compressed.mp4",
      poster: "docs/assets/btcpayserver/basic-btcpayserver-demo-poster.webp",
    },
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
  ".mp4": "video/mp4",
};
const assetPath = (file) => `/assets/${file.slice(ASSETS_ROOT.length)}`;
function embeddedAssets(page) {
  const markdown = readFileSync(path.join(root, page.source), "utf8");
  // Embedded media must live under docs/assets/; a link (an <a href> or a
  // markdown link) is an asset only when it points there — GitHub plays a
  // linked .mp4 in place, which is how the README shows its demo video.
  const embedded = [
    ...[...markdown.matchAll(/<(?:img|video|source)\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]),
    ...[...markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1]),
  ];
  const linked = [
    ...[...markdown.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((m) => m[1]),
    ...[...markdown.matchAll(/(?<!!)\[[^\]]*\]\(([^)\s]+)/g)].map((m) => m[1]),
  ];
  const resolve = (ref) => path.normalize(path.join(path.dirname(page.source), ref));
  const isRemote = (ref) => /^(https?:)?\/\//.test(ref) || ref.startsWith("#");
  const refs = [
    ...embedded.filter((ref) => !isRemote(ref)),
    ...linked.filter((ref) => !isRemote(ref) && resolve(ref).startsWith(ASSETS_ROOT)),
  ];
  const assets = new Map();
  for (const ref of refs) {
    const file = resolve(ref);
    if (!file.startsWith(ASSETS_ROOT)) {
      throw new Error(
        `${TARGET}: ${page.source} embeds ${ref}, which resolves outside ${ASSETS_ROOT}; the site serves only that tree.`,
      );
    }
    const content_type = ASSET_TYPES[path.extname(file).toLowerCase()];
    if (!content_type)
      throw new Error(`${TARGET}: ${page.source} embeds ${ref}, an unknown asset type.`);
    const urlPath = assetPath(file);
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

// The framework table (contract v5): one row per landing page the site
// renders at /integrations/<id>. Generated here rather than hand-maintained on
// the site so that a demo, quickstart or payload that goes missing fails THIS
// build, not the site's. Everything derivable is derived — the demo directory
// and port from tools/shared/demo-catalog.mjs, the quickstart title from the
// manifest — and every reference is gated below: the quickstart must be a
// public doc, the agent stack a payload, the example path a directory on
// disk, and the video null, an absolute URL, or an assets[] entry.
const GITHUB_TREE = "https://github.com/OpenReceive/openreceive/tree/master";
const FRAMEWORKS = [
  {
    id: "woocommerce",
    label: "WordPress + WooCommerce",
    family: "php",
    quickstart_slug: "quickstart-woocommerce",
    agent_stack: "woocommerce",
    adapter_package: "openreceive/wordpress",
    install: "Plugins → Add New → Upload Plugin",
    requires: "WordPress ≥ 6.6, WooCommerce ≥ 9, PHP ≥ 8.2, GMP and sodium",
    demo: "wordpress",
    video: null,
    shared_checkout_demo: false,
  },
  {
    id: "express",
    label: "Express",
    family: "node",
    quickstart_slug: "quickstart-node",
    agent_stack: "node",
    adapter_package: "@openreceive/express",
    install: "npm install @openreceive/express @openreceive/react",
    requires: "Node ≥ 22",
    demo: "node-express",
    video: null,
    shared_checkout_demo: true,
  },
  {
    id: "fastify",
    label: "Fastify",
    family: "node",
    quickstart_slug: "quickstart-fastify",
    agent_stack: "fastify",
    adapter_package: "@openreceive/fastify",
    install: "npm install @openreceive/fastify @openreceive/react",
    requires: "Node ≥ 22",
    demo: "fastify",
    video: null,
    shared_checkout_demo: true,
  },
  {
    id: "nextjs",
    label: "Next.js",
    family: "node",
    quickstart_slug: "quickstart-next",
    agent_stack: "next",
    adapter_package: "@openreceive/next",
    install: "npm install @openreceive/next @openreceive/react",
    requires: "Node ≥ 22, Next.js ≥ 15 (App Router)",
    demo: "nextjs",
    video: null,
    shared_checkout_demo: true,
  },
  {
    id: "rails",
    label: "Rails",
    family: "rails",
    quickstart_slug: "quickstart-rails",
    agent_stack: "rails",
    adapter_package: "openreceive-rails",
    install: "bundle add openreceive-rails",
    requires: "Ruby ≥ 3.2, Rails ≥ 8.0",
    demo: "rails",
    video: null,
    shared_checkout_demo: true,
  },
  {
    id: "btcpay-server",
    label: "BTCPay Server",
    family: "btcpay",
    quickstart_slug: "quickstart-btcpay",
    agent_stack: "btcpay",
    adapter_package: "BTCPayServer.Plugins.OpenReceive",
    install:
      'Plugins (the plug icon, top right) → Plugin Directory → search "openreceive" → Install',
    requires: "BTCPay Server ≥ 2.4.4",
    // Not a shop demo: the plugin's home is its README, and the landing page
    // shows the README's video and screenshots instead of the shared checkout.
    demo: null,
    example_path: "packages/dotnet/BTCPayServer.Plugins.OpenReceive",
    video: assetPath("docs/assets/btcpayserver/basic-btcpayserver-demo-compressed.mp4"),
    shared_checkout_demo: false,
  },
  // The `python` family (contract v6): the install line is `pip install`, the
  // adapter is an extra of the one `openreceive` distribution.
  {
    id: "django",
    label: "Django",
    family: "python",
    quickstart_slug: "quickstart-django",
    agent_stack: "django",
    adapter_package: "openreceive[django]",
    install: 'pip install "openreceive[django]"',
    requires: "Python ≥ 3.10, Django ≥ 5.2",
    demo: "django",
    video: null,
    shared_checkout_demo: true,
  },
  {
    id: "fastapi",
    label: "FastAPI",
    family: "python",
    quickstart_slug: "quickstart-fastapi",
    agent_stack: "fastapi",
    adapter_package: "openreceive[fastapi]",
    install: 'pip install "openreceive[fastapi]"',
    requires: "Python ≥ 3.10, FastAPI ≥ 0.115",
    demo: "fastapi",
    video: null,
    shared_checkout_demo: true,
  },
  {
    id: "laravel",
    label: "Laravel",
    family: "php",
    quickstart_slug: "quickstart-laravel",
    agent_stack: "laravel",
    adapter_package: "openreceive/laravel",
    install: "composer require openreceive/laravel",
    requires: "PHP ≥ 8.2 (64-bit), Laravel 11, 12 or 13, ext-gmp",
    demo: "laravel",
    video: null,
    shared_checkout_demo: true,
  },
  {
    id: "php",
    label: "PHP",
    family: "php",
    quickstart_slug: "quickstart-php",
    agent_stack: "php",
    adapter_package: "openreceive/openreceive",
    install: "composer require openreceive/openreceive nyholm/psr7 nyholm/psr7-server",
    requires: "PHP ≥ 8.2 (64-bit), ext-gmp",
    demo: "php-plain",
    video: null,
    shared_checkout_demo: true,
  },
];

const manifest = JSON.parse(readFileSync(path.join(root, "docs/manifest.json"), "utf8"));
const release = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const bySlug = new Map(manifest.docs.map((doc) => [doc.slug, doc]));
const agentsPage = readFileSync(path.join(root, "docs/site/agents.md"), "utf8");
// The page offers the payloads to copy and paste, so it links the full files.
for (const fullPath of AGENT_PAYLOAD_PATHS.map(agentFullPath)) {
  if (!agentsPage.includes(`https://openreceive.org${fullPath}`)) {
    throw new Error(`docs/site/agents.md must link every agent payload: missing ${fullPath}`);
  }
}

const publish = [];
const assets = [];
for (const doc of manifest.docs) {
  if (!doc.public) continue;
  const urlPath = doc.slug === "guides" ? "/guides" : `/guides/${doc.slug}`;
  // A guide may embed screenshots too (the BTCPay quickstart carries the
  // plugin's four install steps), so its images join `assets[]` on the same
  // terms as a plugin README's: collected from the source, resolved relative
  // to it, and refused if they sit outside docs/assets/.
  const docAssets = embeddedAssets({ source: doc.source_path, path: urlPath });
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
    // Only when the page has images to map: see `assets[]`.
    ...(docAssets.length > 0 && { assets_base: "/assets/" }),
  });
  assets.push(...docAssets);
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
    ...(page.video && {
      video: {
        path: assetPath(page.video.source),
        poster: assetPath(page.video.poster),
      },
    }),
  });
  const pageAssets = embeddedAssets(page);
  for (const source of page.video ? [page.video.source, page.video.poster] : []) {
    if (!pageAssets.some((asset) => asset.source === source)) {
      pageAssets.push({
        path: assetPath(source),
        source,
        content_type: ASSET_TYPES[path.extname(source).toLowerCase()],
        bytes: statSync(path.join(root, source)).size,
        referenced_by: [page.path],
      });
    }
  }
  assets.push(...pageAssets);
}

// One entry per served file, whoever embeds it: the BTCPay install
// screenshots are in both the plugin README and the quickstart guide, and the
// site serves those bytes once. `referenced_by` names every page that shows
// them.
const servedAssets = [];
for (const asset of assets) {
  const seen = servedAssets.find((entry) => entry.path === asset.path);
  if (!seen) {
    servedAssets.push(asset);
    continue;
  }
  for (const page of asset.referenced_by) {
    if (!seen.referenced_by.includes(page)) seen.referenced_by.push(page);
  }
}

// The public record of passing agent trials (trials/passed.json): one entry
// per platform, the date and release of its latest passing trials. The site
// shows them as Tested badges, so each must name a trial platform that exists.
// `runs`, `mode` and `directions` (the hash the trial's per-platform summary
// prints) say what was tested. A harness entry needs three trials, the hash,
// and the `agents` that ran them (`agent/model`), which `tested` carries to
// the site; a `builder` entry is one trial on the platform itself.
const passed = new Map(
  JSON.parse(readFileSync(path.join(root, "trials/passed.json"), "utf8")).passed.map((entry) => {
    if (
      !existsSync(path.join(root, "trials/platforms", entry.trial, "platform.json")) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) ||
      !/^\d+\.\d+\.\d+$/.test(entry.release) ||
      !["released", "candidate", "builder"].includes(entry.mode) ||
      !Number.isInteger(entry.runs) ||
      // A harness badge takes three passing runs in a row and names the
      // directions file it followed; a builder run is one run on the
      // platform itself, by the platform's own agent.
      (entry.mode !== "builder" &&
        (entry.runs < 3 ||
          !/^[0-9a-f]{12}$/.test(entry.directions ?? "") ||
          !Array.isArray(entry.agents) ||
          entry.agents.length === 0 ||
          !entry.agents.every((agent) => /^(cursor|codex|claude)\/\S+$/.test(agent)))) ||
      (entry.mode === "builder" && entry.runs < 1)
    ) {
      throw new Error(`${TARGET}: invalid trials/passed.json entry ${JSON.stringify(entry)}`);
    }
    return [
      entry.trial,
      {
        date: entry.date,
        release: entry.release,
        ...(entry.agents === undefined ? {} : { agents: entry.agents }),
      },
    ];
  }),
);

const frameworks = FRAMEWORKS.map((framework) => {
  const { demo: demoKey, ...row } = framework;
  const demo =
    demoKey === null ? null : OPENRECEIVE_DEMOS.find((entry) => entry.keys.includes(demoKey));
  if (demoKey !== null && !demo) {
    throw new Error(
      `${TARGET}: framework ${row.id} names demo "${demoKey}", which is not in tools/shared/demo-catalog.mjs`,
    );
  }
  const quickstart = bySlug.get(row.quickstart_slug);
  if (!quickstart?.public) {
    throw new Error(
      `${TARGET}: framework ${row.id} names quickstart ${row.quickstart_slug}, which is not a public doc in docs/manifest.json`,
    );
  }
  if (!AGENT_PAYLOADS.some((payload) => payload.stack === row.agent_stack)) {
    throw new Error(
      `${TARGET}: framework ${row.id} names agent stack ${row.agent_stack}, which has no payload in AGENT_PAYLOADS`,
    );
  }
  const payloadPath = `/agent-directions/${row.agent_stack}.md`;
  if (!AGENT_PAYLOAD_PATHS.includes(payloadPath)) {
    throw new Error(
      `${TARGET}: ${payloadPath} is not in AGENT_PAYLOAD_PATHS (tools/docs/site-paths.mjs)`,
    );
  }
  const example_path = demo ? demo.dir : row.example_path;
  if (
    !existsSync(path.join(root, example_path)) ||
    !statSync(path.join(root, example_path)).isDirectory()
  ) {
    throw new Error(
      `${TARGET}: framework ${row.id} names example ${example_path}, which is not a directory in this repo`,
    );
  }
  const video = row.video;
  const videoOk =
    video === null ||
    /^https:\/\//.test(video) ||
    servedAssets.some((asset) => asset.path === video && asset.content_type === "video/mp4");
  if (!videoOk) {
    throw new Error(
      `${TARGET}: framework ${row.id} video must be null, an absolute https URL, or an assets[] mp4 under docs/assets/ (got ${video})`,
    );
  }
  return {
    id: row.id,
    label: row.label,
    family: row.family,
    heading: `Accept Bitcoin & Stablecoin Payments With ${row.label}`,
    quickstart_slug: row.quickstart_slug,
    quickstart_path: `/guides/${row.quickstart_slug}`,
    quickstart_title: quickstart.title,
    agent_stack: row.agent_stack,
    agent_payload_path: payloadPath,
    agent_full_path: agentFullPath(payloadPath),
    adapter_package: row.adapter_package,
    install: row.install,
    requires: row.requires,
    example_path,
    example_url: `${GITHUB_TREE}/${example_path}`,
    demo_port: demo ? demo.port : null,
    video,
    shared_checkout_demo: row.shared_checkout_demo,
    tested: passed.get(row.agent_stack) ?? null,
  };
});

// The platform pages (contract v8), from docs/site/platforms.json. A platform
// runs on a framework above; it adds where secrets live, which database URL to
// use, a starter and, for AI builders, the prompt to paste. The prompt is the
// block between platform-prompt markers in the platform's guide, the same text
// the agent trial sends, so the copied prompt is the tested one.
const PLATFORM_KINDS = ["ai-builder", "host", "database", "store"];
const PROMPT_BLOCK =
  /<!-- platform-prompt:begin -->\s*```text\n([\s\S]*?)\n```\s*<!-- platform-prompt:end -->/;
const platformIds = new Set();
const platforms = JSON.parse(
  readFileSync(path.join(root, "docs/site/platforms.json"), "utf8"),
).platforms.map((row) => {
  const fail = (message) => {
    throw new Error(`${TARGET}: platform ${row.id}: ${message} (docs/site/platforms.json)`);
  };
  if (!/^[a-z0-9-]+$/.test(row.id ?? "") || platformIds.has(row.id)) fail("needs a unique slug id");
  platformIds.add(row.id);
  if (!PLATFORM_KINDS.includes(row.kind)) fail(`kind must be one of ${PLATFORM_KINDS.join(", ")}`);
  if (typeof row.label !== "string" || typeof row.summary !== "string")
    fail("needs a label and a summary");
  if (row.framework !== null && !frameworks.some((entry) => entry.id === row.framework)) {
    fail(`names framework ${row.framework}, which is not in frameworks[]`);
  }
  const base = {
    id: row.id,
    label: row.label,
    kind: row.kind,
    summary: row.summary,
    framework: row.framework,
    framework_path: row.framework === null ? null : `/integrations/${row.framework}`,
  };
  if (row.planned === true) return { ...base, status: "planned", path: null };
  const guide = bySlug.get(row.guide);
  if (!guide?.public)
    fail(`names guide ${row.guide}, which is not a public doc in docs/manifest.json`);
  let prompt = null;
  if (row.prompt === true) {
    prompt =
      readFileSync(path.join(root, guide.source_path), "utf8").match(PROMPT_BLOCK)?.[1] ?? null;
    if (prompt === null) fail(`${guide.source_path} has no platform-prompt block`);
  }
  const starter = row.starter ?? null;
  if (
    starter !== null &&
    !(/^https:\/\//.test(starter.url) && /^https:\/\//.test(starter.source_url))
  ) {
    fail("starter needs https url and source_url");
  }
  if (!existsSync(path.join(root, "trials/platforms", row.trial, "platform.json"))) {
    fail(`names trial ${row.trial}, which has no trials/platforms/${row.trial}/platform.json`);
  }
  const tested = passed.get(row.trial) ?? null;
  return {
    ...base,
    status: tested === null ? "guide" : "tested",
    path: `/platforms/${row.id}`,
    markdown_path: markdownTwin(`/platforms/${row.id}`),
    database: row.database,
    secrets: row.secrets,
    settlement: row.settlement,
    guide_slug: row.guide,
    guide_path: `/guides/${row.guide}`,
    guide_source: guide.source_path,
    prompt,
    starter,
    // Published as `eval` since contract v8; the site reads that name.
    eval: row.trial,
    tested,
  };
});
const platformPagePaths = platforms
  .filter((entry) => entry.path !== null)
  .map((entry) => entry.path)
  .sort();
if (JSON.stringify(platformPagePaths) !== JSON.stringify([...PLATFORM_PATHS].sort())) {
  throw new Error(
    `${TARGET}: PLATFORM_PATHS in tools/docs/site-paths.mjs disagrees with platforms[]`,
  );
}

// Each stack publishes two raw-markdown files (contract v7). The URL people
// paste, `/agent-directions/<stack>.md`, is a cover a few hundred bytes long
// whose one instruction is to download the full directions with the shell; the
// full directions are at `full_path`. The copy button copies the full file, so
// a paste is still complete with no network at all.
const copyButton = AGENT_PAYLOADS.flatMap(({ path: urlPath, source, stack }) => {
  const fullPath = agentFullPath(urlPath);
  const cover = `docs/agents/cover/${stack}.md`;
  return [
    {
      path: urlPath,
      source: cover,
      kind: "agent-directions-cover",
      stack,
      content_type: "text/markdown; charset=utf-8",
      bytes: statSync(path.join(root, cover)).size,
      copy_button: false,
      self_contained: false,
      full_path: fullPath,
    },
    {
      path: fullPath,
      source,
      kind: "agent-directions-payload",
      stack,
      content_type: "text/markdown; charset=utf-8",
      bytes: statSync(path.join(root, source)).size,
      copy_button: true,
      self_contained: true,
    },
  ];
});

// Redirects must land directly on a declared page and cannot shadow content.
const pagePaths = new Set([
  ...publish.flatMap((entry) => [entry.path, entry.markdown_path]),
  ...copyButton.map((entry) => entry.path),
  ...SITE_OWNED_PATHS,
  ...frameworks.map((entry) => `/integrations/${entry.id}`),
  PLATFORM_INDEX_PATH,
  ...platforms.flatMap((entry) => (entry.path === null ? [] : [entry.path, entry.markdown_path])),
]);
const redirectPaths = new Set();
for (const redirect of SITE_REDIRECTS) {
  if (
    !redirect.from.startsWith("/") ||
    redirect.from.startsWith("//") ||
    pagePaths.has(redirect.from) ||
    redirectPaths.has(redirect.from) ||
    !pagePaths.has(redirect.to) ||
    redirect.status !== 301
  ) {
    throw new Error(`${TARGET}: invalid permanent redirect ${JSON.stringify(redirect)}`);
  }
  redirectPaths.add(redirect.from);
}

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
  // v5 adds `frameworks[]`: one row per /integrations/<id> landing page, with
  // the quickstart, payload, install line, example and demo port the page
  // renders, each gated here against the manifest, the payload list, the
  // demo catalog and the filesystem. A bump because the site's landing
  // template reads the table instead of a hand-kept list: a site on v4 has
  // no framework pages, and one that half-read v5 would render a page for a
  // framework whose payload it does not serve. v7 turns each
  // /agent-directions/<stack>.md into a cover (kind `agent-directions-cover`)
  // and moves the full directions to /agent-directions/<stack>/full.md
  // (`full_path`, and `agent_full_path` on each framework row), which is what
  // the copy button copies. A bump because a site on v6 would serve no full
  // file, leaving every cover's curl line a 404, and its copy button would
  // copy the cover. v8 adds `platforms[]` (the /platforms index and one
  // /platforms/<id> page per row, each a header from the row above its guide)
  // and `tested` on every framework row, from trials/passed.json. A
  // bump because the published guides link /platforms: a site on v7 would
  // 404 them.
  contract_version: 8,
  // The library release this documentation set belongs to. The site publishes
  // one release at a time; `docs_manifest_version` moves only when the shape of
  // the manifest itself changes.
  release_version: release,
  docs_manifest_version: manifest.version,
  generated_by: "tools/docs/generate-site-contract.mjs",
  how_to_update: "docs/internal/site-build.md",
  publish: [...publish, ...copyButton],
  // The framework landing pages (contract v5). Render one page per row at
  // /integrations/<id>; the copy button copies `agent_full_path`, a link for
  // an agent to follow is `agent_payload_path` (the cover), the
  // "read the guide" link is `quickstart_path`, the "finished example" link
  // is `example_url`. `video` is null until a speed-run exists (hide the
  // slot), an absolute URL, or an `assets[]` path to serve. When
  // `shared_checkout_demo` is false the page shows the video and screenshots
  // instead of the shared checkout panel.
  frameworks,
  // Where people build and host (contract v8). Render /platforms as the index
  // and one page per row whose `path` is not null; docs/internal/site-build.md
  // has the layout. `status` is "tested" only when `tested` names a passing
  // live run; "guide" rows are documented, "planned" rows have no page yet.
  platforms_index: {
    path: PLATFORM_INDEX_PATH,
    method_guide_path: "/guides/how-we-test-platforms",
  },
  platforms,
  // Images embedded by a publish[] entry (contract v4). Serve `source`'s bytes
  // at `path` with `content_type`; the renderer maps the source's relative
  // <img src> to `path`, in the page and in the markdown twin alike.
  assets: servedAssets,
  // Pages openreceive.org authors and owns. The agent directions link to these,
  // so removing or renaming one breaks a payload that is already pasted into
  // other people's editors and cannot be recalled.
  site_owned: SITE_OWNED_PATHS.map((urlPath) => ({ path: urlPath, must_exist: true })),
  // Permanent redirects imported by the site alongside the framework routes.
  // The existing v6 shape is unchanged; each must_exist obligation is required.
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
    `${copyButton.filter((entry) => entry.copy_button).length} copy payloads, ${copyButton.filter((entry) => !entry.copy_button).length} covers, ${frameworks.length} frameworks, ${platforms.length} platforms, ${servedAssets.length} assets, ${contract.never_publish.length} never-publish.`,
);
