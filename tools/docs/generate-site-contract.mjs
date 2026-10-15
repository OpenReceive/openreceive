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
  { path: "/agent-directions/nestjs.md", source: "docs/agents/nestjs.md", stack: "nestjs" },
  { path: "/agent-directions/fastapi.md", source: "docs/agents/fastapi.md", stack: "fastapi" },
  { path: "/agent-directions/django.md", source: "docs/agents/django.md", stack: "django" },
  { path: "/agent-directions/flask.md", source: "docs/agents/flask.md", stack: "flask" },
  { path: "/agent-directions/rails.md", source: "docs/agents/rails.md", stack: "rails" },
  { path: "/agent-directions/php.md", source: "docs/agents/php.md", stack: "php" },
  { path: "/agent-directions/laravel.md", source: "docs/agents/laravel.md", stack: "laravel" },
  { path: "/agent-directions/btcpay.md", source: "docs/agents/btcpay.md", stack: "btcpay" },
  { path: "/agent-directions/lovable.md", source: "docs/agents/lovable.md", stack: "lovable" },
  {
    path: "/agent-directions/sveltekit.md",
    source: "docs/agents/sveltekit.md",
    stack: "sveltekit",
  },
  { path: "/agent-directions/nuxt.md", source: "docs/agents/nuxt.md", stack: "nuxt" },
  { path: "/agent-directions/astro.md", source: "docs/agents/astro.md", stack: "astro" },
  {
    path: "/agent-directions/react-router.md",
    source: "docs/agents/react-router.md",
    stack: "react-router",
  },
  {
    path: "/agent-directions/tanstack-start.md",
    source: "docs/agents/tanstack-start.md",
    stack: "tanstack-start",
  },
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
//
// Since contract v9 each row also says what kind of integration it is, so a
// page never presents guide-only support as a package:
//   package     an OpenReceive adapter for this framework, from its registry
//   plugin      a store plugin, from the store's plugin directory
//   guide       a quickstart and agent directions over another row's package
//   recipe      a recipe page of code to copy, with no example app; since
//               v10 it may have agent directions that inline the recipe
//   via-btcpay  a store that takes payments through BTCPay Server and its plugin
// and carries a capability record for the page's "How it runs" list.
// `runtime` and `databases` are what CI and the agent trials (or, for a
// recipe, the check the recipe describes) ran it on; `requires` is the floor.
const GITHUB_TREE = "https://github.com/OpenReceive/openreceive/tree/master";
const INTEGRATION_TYPES = ["package", "plugin", "guide", "recipe", "via-btcpay"];
const CAPABILITY_FIELDS = ["runtime", "databases", "secrets", "refunds", "mobile"];
// Every server-side row says the same about secrets, refunds and mobile apps.
const SERVER_CAPABILITIES = {
  secrets:
    "NWC_URI, and LSC_URI_PRIMARY for swaps, in the server's environment or .env file, never in browser code",
  refunds:
    "Refund a settled Lightning payment from your own wallet: the wallet code is receive-only. A swap deposit that never converted goes back to the payer through the checkout's refund form.",
  mobile:
    "No app SDK. A mobile app opens your checkout page in a browser tab, which the app stores allow for physical goods and real-world services; digital goods need a link-out program.",
};
const STORE_MOBILE =
  "No app SDK. Payers pay on the store's web checkout, and an app that opens it follows the same app store rules as any web checkout.";
const NODE_CAPABILITIES = {
  runtime: "Node 22",
  databases: "PostgreSQL, directly or through a transaction pooler, and SQLite",
  ...SERVER_CAPABILITIES,
};
const PYTHON_CAPABILITIES = {
  runtime: "Python 3.10 to 3.13",
  databases: "PostgreSQL, directly or through a transaction pooler, MySQL 8 and SQLite",
  ...SERVER_CAPABILITIES,
};
const PHP_CAPABILITIES = {
  runtime: "PHP 8.2 to 8.4",
  databases: "PostgreSQL, MySQL 8 and SQLite",
  ...SERVER_CAPABILITIES,
};
// The four recipes checked together on 2026-10-13 (docs/recipes/*.md say how).
const RECIPE_CAPABILITIES = {
  databases: "PostgreSQL",
  ...SERVER_CAPABILITIES,
};
const FRAMEWORKS = [
  {
    id: "woocommerce",
    label: "WordPress + WooCommerce",
    type: "plugin",
    family: "php",
    quickstart_slug: "quickstart-woocommerce",
    agent_stack: "woocommerce",
    adapter_package: "openreceive/wordpress",
    install: "wp plugin install openreceive --activate",
    requires: "WordPress ≥ 6.6, WooCommerce ≥ 9, PHP ≥ 8.2, GMP and sodium",
    demo: "wordpress",
    video: null,
    shared_checkout_demo: false,
    capabilities: {
      runtime: "WordPress 7.1 with WooCommerce, on PHP 8.2",
      databases: "MySQL 8, WordPress's own database",
      secrets:
        "The plugin's settings, encrypted with keys derived from WordPress's auth keys, or OPENRECEIVE_NWC_URI in wp-config.php",
      refunds:
        "Refund a settled Lightning payment from your own wallet: the wallet code is receive-only. A payer reclaims a swap deposit that never converted from the order's pay link.",
      mobile: STORE_MOBILE,
    },
  },
  {
    id: "express",
    label: "Express",
    type: "package",
    family: "node",
    quickstart_slug: "quickstart-node",
    agent_stack: "node",
    adapter_package: "@openreceive/express",
    install: "npm install @openreceive/express @openreceive/react",
    requires: "Node ≥ 22",
    demo: "node-express",
    video: null,
    shared_checkout_demo: true,
    capabilities: NODE_CAPABILITIES,
  },
  {
    id: "fastify",
    label: "Fastify",
    type: "package",
    family: "node",
    quickstart_slug: "quickstart-fastify",
    agent_stack: "fastify",
    adapter_package: "@openreceive/fastify",
    install: "npm install @openreceive/fastify @openreceive/react",
    requires: "Node ≥ 22",
    demo: "fastify",
    video: null,
    shared_checkout_demo: true,
    capabilities: NODE_CAPABILITIES,
  },
  {
    id: "nextjs",
    label: "Next.js",
    type: "package",
    family: "node",
    quickstart_slug: "quickstart-next",
    agent_stack: "next",
    adapter_package: "@openreceive/next",
    install: "npm install @openreceive/next @openreceive/react",
    requires: "Node ≥ 22, Next.js ≥ 15 (App Router)",
    demo: "nextjs",
    video: null,
    shared_checkout_demo: true,
    capabilities: NODE_CAPABILITIES,
  },
  // NestJS mounts the Express adapter in main.ts. It has no Buy a Button demo:
  // its example is the one-product starter.
  {
    id: "nestjs",
    label: "NestJS",
    type: "guide",
    family: "node",
    quickstart_slug: "quickstart-nestjs",
    agent_stack: "nestjs",
    adapter_package: "@openreceive/express",
    install: "npm install @openreceive/express @openreceive/http @openreceive/react",
    requires: "Node ≥ 22, NestJS ≥ 10 on the Express platform",
    demo: null,
    example_path: "examples/nestjs-starter",
    video: null,
    shared_checkout_demo: true,
    capabilities: NODE_CAPABILITIES,
  },
  {
    id: "rails",
    label: "Rails",
    type: "package",
    family: "rails",
    quickstart_slug: "quickstart-rails",
    agent_stack: "rails",
    adapter_package: "openreceive-rails",
    install: "bundle add openreceive-rails",
    requires: "Ruby ≥ 3.2, Rails ≥ 8.0",
    demo: "rails",
    video: null,
    shared_checkout_demo: true,
    capabilities: {
      runtime: "Ruby 3.2 to 3.4, Rails 8.1",
      databases: "PostgreSQL and SQLite",
      ...SERVER_CAPABILITIES,
    },
  },
  {
    id: "btcpay-server",
    label: "BTCPay Server",
    type: "plugin",
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
    capabilities: {
      runtime: "BTCPay Server 2.4.5",
      databases: "BTCPay Server's own PostgreSQL",
      secrets: "The store's OpenReceive settings, in BTCPay Server's database",
      refunds:
        "Refund a settled Lightning payment from your own wallet: the wallet code is receive-only, so BTCPay's Lightning refunds are off. A payer reclaims a swap deposit that never converted from the invoice page.",
      mobile: STORE_MOBILE,
    },
  },
  // Stores on the BTCPay route (contract v11): the platform's own BTCPay
  // module takes the order to BTCPay, and BTCPay takes the payment with the
  // OpenReceive plugin. The copy button gives the BTCPay directions, for the
  // BTCPay half; the guide covers the store's half. Tested by
  // `npm run trial:btcpay-route`, not an agent trial.
  {
    id: "odoo",
    label: "Odoo",
    type: "via-btcpay",
    family: "btcpay",
    quickstart_slug: "odoo",
    agent_stack: "btcpay",
    adapter_package: "payment_btcpayserver",
    install:
      "Install the Payment Provider: BTCPay Server add-on (btcpayserver/odoo) and pip install ecdsa",
    requires: "Odoo 17, 18 or 19, and BTCPay Server ≥ 2.4.4 with the OpenReceive plugin",
    demo: null,
    example_path: null,
    video: null,
    shared_checkout_demo: false,
    capabilities: {
      runtime: "Odoo 19 Community with btcpayserver/odoo 19.0.1.1, on BTCPay Server 2.4.5",
      databases: "Odoo's PostgreSQL and BTCPay Server's own PostgreSQL",
      secrets:
        "The wallet code in BTCPay's OpenReceive settings; Odoo keeps only its BTCPay pairing token",
      refunds:
        "Refund a settled Lightning payment from your own wallet: the wallet code is receive-only. A payer reclaims a swap deposit that never converted from the BTCPay invoice page.",
      mobile: STORE_MOBILE,
    },
  },
  {
    id: "magento",
    label: "Magento",
    type: "via-btcpay",
    family: "btcpay",
    quickstart_slug: "magento",
    agent_stack: "btcpay",
    adapter_package: "btcpayserver/magento2-btcpay-module",
    install: "composer require btcpayserver/magento2-btcpay-module",
    requires: "Magento 2.4 or Mage-OS, and BTCPay Server ≥ 2.4.4 with the OpenReceive plugin",
    demo: null,
    example_path: null,
    video: null,
    shared_checkout_demo: false,
    capabilities: {
      runtime:
        "Mage-OS 3.6 (Magento 2.4.9) with btcpayserver/magento2-plugin 2.0.12, on BTCPay Server 2.4.5",
      databases: "Magento's MySQL or MariaDB and BTCPay Server's own PostgreSQL",
      secrets:
        "The wallet code in BTCPay's OpenReceive settings; Magento keeps only a BTCPay API key limited to invoices and webhooks",
      refunds:
        "Refund a settled Lightning payment from your own wallet: the wallet code is receive-only. A payer reclaims a swap deposit that never converted from the BTCPay invoice page.",
      mobile: STORE_MOBILE,
    },
  },
  {
    id: "prestashop",
    label: "PrestaShop",
    type: "via-btcpay",
    family: "btcpay",
    quickstart_slug: "prestashop",
    agent_stack: "btcpay",
    adapter_package: "btcpayserver/prestashop-plugin",
    install: "Upload btcpay.zip from btcpayserver/prestashop-plugin in Modules → Module Manager",
    requires: "PrestaShop 8 or 9, and BTCPay Server ≥ 2.4.4 with the OpenReceive plugin",
    demo: null,
    example_path: null,
    video: null,
    shared_checkout_demo: false,
    capabilities: {
      runtime: "PrestaShop 9.2.0 with btcpayserver/prestashop-plugin 6.3.3, on BTCPay Server 2.4.5",
      databases: "PrestaShop's MySQL or MariaDB and BTCPay Server's own PostgreSQL",
      secrets:
        "The wallet code in BTCPay's OpenReceive settings; PrestaShop keeps only a BTCPay API key limited to one store's settings, invoices and webhooks",
      refunds:
        "Refund a settled Lightning payment from your own wallet: the wallet code is receive-only. A payer reclaims a swap deposit that never converted from the BTCPay invoice page.",
      mobile: STORE_MOBILE,
    },
  },
  // The `python` family (contract v6): the install line is `pip install`, the
  // adapter is an extra of the one `openreceive` distribution.
  {
    id: "django",
    label: "Django",
    type: "package",
    family: "python",
    quickstart_slug: "quickstart-django",
    agent_stack: "django",
    adapter_package: "openreceive[django]",
    install: 'pip install "openreceive[django]"',
    requires: "Python ≥ 3.10, Django ≥ 5.2",
    demo: "django",
    video: null,
    shared_checkout_demo: true,
    capabilities: { ...PYTHON_CAPABILITIES, runtime: "Python 3.10 to 3.13, Django 5.2 and 6.0" },
  },
  {
    id: "fastapi",
    label: "FastAPI",
    type: "package",
    family: "python",
    quickstart_slug: "quickstart-fastapi",
    agent_stack: "fastapi",
    adapter_package: "openreceive[fastapi]",
    install: 'pip install "openreceive[fastapi]"',
    requires: "Python ≥ 3.10, FastAPI ≥ 0.115",
    demo: "fastapi",
    video: null,
    shared_checkout_demo: true,
    capabilities: PYTHON_CAPABILITIES,
  },
  // Flask has no adapter package: the quickstart's one-file Blueprint over the
  // engine is the integration until it meets the promotion rule, so the
  // install line is the engine with its SQLAlchemy extra.
  {
    id: "flask",
    label: "Flask",
    type: "guide",
    family: "python",
    quickstart_slug: "quickstart-flask",
    agent_stack: "flask",
    adapter_package: "openreceive[sqlalchemy]",
    install: 'pip install "openreceive[sqlalchemy]"',
    requires: "Python ≥ 3.10, Flask ≥ 3",
    demo: null,
    example_path: "examples/flask-starter",
    video: null,
    shared_checkout_demo: true,
    capabilities: PYTHON_CAPABILITIES,
  },
  {
    id: "laravel",
    label: "Laravel",
    type: "package",
    family: "php",
    quickstart_slug: "quickstart-laravel",
    agent_stack: "laravel",
    adapter_package: "openreceive/laravel",
    install: "composer require openreceive/laravel",
    requires: "PHP ≥ 8.2 (64-bit), Laravel 11, 12 or 13, ext-gmp",
    demo: "laravel",
    video: null,
    shared_checkout_demo: true,
    capabilities: { ...PHP_CAPABILITIES, runtime: "PHP 8.2 to 8.4, Laravel 12 and 13" },
  },
  {
    id: "php",
    label: "PHP",
    type: "package",
    family: "php",
    quickstart_slug: "quickstart-php",
    agent_stack: "php",
    adapter_package: "openreceive/openreceive",
    install: "composer require openreceive/openreceive nyholm/psr7 nyholm/psr7-server",
    requires: "PHP ≥ 8.2 (64-bit), ext-gmp",
    demo: "php-plain",
    video: null,
    shared_checkout_demo: true,
    capabilities: PHP_CAPABILITIES,
  },
  // Recipes (contract v9): the web-standard handler from @openreceive/http,
  // mounted by hand. The page links the recipe in place of a quickstart, and
  // there is no example app. Since v10 each has agent directions that inline
  // the recipe, so its page has a copy button too.
  {
    id: "sveltekit",
    label: "SvelteKit",
    type: "recipe",
    family: "node",
    quickstart_slug: "sveltekit-recipe",
    agent_stack: "sveltekit",
    adapter_package: "@openreceive/http",
    install: "npm install @openreceive/http @openreceive/svelte pg",
    requires: "Node ≥ 22, SvelteKit with @sveltejs/adapter-node",
    demo: null,
    example_path: null,
    video: null,
    shared_checkout_demo: true,
    capabilities: {
      runtime:
        "Node 22: agent trials on SvelteKit 3.0 with adapter-node 6, and the recipe's own check",
      ...RECIPE_CAPABILITIES,
    },
  },
  {
    id: "nuxt",
    label: "Nuxt",
    type: "recipe",
    family: "node",
    quickstart_slug: "nuxt-recipe",
    agent_stack: "nuxt",
    adapter_package: "@openreceive/http",
    install: "npm install @openreceive/http @openreceive/vue pg",
    requires: "Node ≥ 22, Nuxt on Nitro's node-server preset",
    demo: null,
    example_path: null,
    video: null,
    shared_checkout_demo: true,
    capabilities: {
      runtime: "Node 22: agent trials on Nuxt 4.6 (Nitro 2), and the recipe's own check",
      ...RECIPE_CAPABILITIES,
    },
  },
  {
    id: "astro",
    label: "Astro",
    type: "recipe",
    family: "node",
    quickstart_slug: "astro-recipe",
    agent_stack: "astro",
    adapter_package: "@openreceive/http",
    install: "npx astro add node\nnpm install @openreceive/http @openreceive/elements pg",
    requires: "Node ≥ 22, Astro with @astrojs/node",
    demo: null,
    example_path: null,
    video: null,
    shared_checkout_demo: true,
    capabilities: {
      runtime:
        "Node 22: agent trials on Astro 7.3 with @astrojs/node 11.1, and the recipe's own check",
      ...RECIPE_CAPABILITIES,
    },
  },
  {
    id: "react-router",
    label: "React Router",
    type: "recipe",
    family: "node",
    quickstart_slug: "react-router-recipe",
    agent_stack: "react-router",
    adapter_package: "@openreceive/http",
    install: "npm install @openreceive/http @openreceive/react pg",
    requires: "Node ≥ 22, React Router in framework mode",
    demo: null,
    example_path: null,
    video: null,
    shared_checkout_demo: true,
    capabilities: {
      runtime:
        "Node 22: agent trials on React Router 8.4 (react-router-serve), and the recipe's own check",
      ...RECIPE_CAPABILITIES,
    },
  },
  // Lovable's stack. CI runs the recipe's Supabase route as a Worker.
  {
    id: "tanstack-start",
    label: "TanStack Start",
    type: "recipe",
    family: "node",
    quickstart_slug: "tanstack-start-recipe",
    agent_stack: "tanstack-start",
    adapter_package: "@openreceive/http",
    install: "npm install @openreceive/http @openreceive/react pg",
    requires: "Node ≥ 22, or Cloudflare Workers with Node compatibility",
    demo: null,
    example_path: null,
    video: null,
    shared_checkout_demo: true,
    capabilities: {
      runtime:
        "Node 22: agent trials on TanStack Start 1.169 (Nitro node-server). Cloudflare Workers (workerd): checked with TanStack Start 1.168, and CI runs its Supabase route as a Worker",
      databases: "PostgreSQL through a transaction pooler, or Supabase over its HTTPS API",
      ...SERVER_CAPABILITIES,
      secrets:
        "NWC_URI, and LSC_URI_PRIMARY for swaps, as server secrets (Worker secrets on Cloudflare), never with a VITE_ prefix",
    },
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
    // A BTCPay-route entry (contract v11) is one run of
    // `npm run trial:btcpay-route`: no agent, a store from trials/btcpay-route,
    // and `release` is the published BTCPay plugin's version.
    if (entry.mode === "btcpay-route") {
      if (
        !existsSync(path.join(root, "trials/btcpay-route", entry.trial)) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) ||
        !/^\d+\.\d+\.\d+$/.test(entry.release) ||
        !/^\d+\.\d+\.\d+$/.test(entry.btcpay ?? "") ||
        typeof entry.store !== "string" ||
        !Number.isInteger(entry.runs) ||
        entry.runs < 1
      ) {
        throw new Error(`${TARGET}: invalid trials/passed.json entry ${JSON.stringify(entry)}`);
      }
      return [
        entry.trial,
        {
          date: entry.date,
          release: entry.release,
          via: "btcpay-route",
          store: entry.store,
          btcpay: entry.btcpay,
        },
      ];
    }
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
  const fail = (message) => {
    throw new Error(`${TARGET}: framework ${row.id} ${message}`);
  };
  if (!INTEGRATION_TYPES.includes(row.type)) {
    fail(`has type ${row.type}; it must be one of ${INTEGRATION_TYPES.join(", ")}`);
  }
  const capabilities = row.capabilities ?? {};
  const fields = Object.keys(capabilities);
  if (
    fields.length !== CAPABILITY_FIELDS.length ||
    !CAPABILITY_FIELDS.every((field) => typeof capabilities[field] === "string")
  ) {
    fail(`needs a capability record of exactly ${CAPABILITY_FIELDS.join(", ")} (got ${fields})`);
  }
  const demo =
    demoKey === null ? null : OPENRECEIVE_DEMOS.find((entry) => entry.keys.includes(demoKey));
  if (demoKey !== null && !demo) {
    fail(`names demo "${demoKey}", which is not in tools/shared/demo-catalog.mjs`);
  }
  const quickstart = bySlug.get(row.quickstart_slug);
  if (!quickstart?.public) {
    fail(
      `names quickstart ${row.quickstart_slug}, which is not a public doc in docs/manifest.json`,
    );
  }
  // A recipe has no example app: its page links the recipe where other rows
  // link their quickstart. Since contract v10 a recipe may carry agent
  // directions, which inline the recipe as their quickstart; every other
  // type must.
  const recipe = row.type === "recipe";
  if (recipe && (demo || row.example_path !== null)) {
    fail("is a recipe, so its demo and example_path must be null");
  }
  // A store on the BTCPay route (contract v11) has no example app either:
  // BTCPay's checkout and the platform's own module do the work. Its Tested
  // badge comes from its BTCPay-route run, never from an agent trial.
  const viaBtcpay = row.type === "via-btcpay";
  if (viaBtcpay && (demo || row.example_path !== null || row.shared_checkout_demo)) {
    fail("is via-btcpay, so its demo and example_path are null and it has no shared checkout demo");
  }
  if (!recipe && row.agent_stack === null) {
    fail(`has type ${row.type}, so it needs an agent_stack`);
  }
  if (recipe !== (quickstart.category === "recipe")) {
    fail(`has type ${row.type}, but ${row.quickstart_slug} is in category ${quickstart.category}`);
  }
  const payloadPath = row.agent_stack === null ? null : `/agent-directions/${row.agent_stack}.md`;
  if (
    payloadPath !== null &&
    !AGENT_PAYLOADS.some((payload) => payload.stack === row.agent_stack)
  ) {
    fail(`names agent stack ${row.agent_stack}, which has no payload in AGENT_PAYLOADS`);
  }
  if (payloadPath !== null && !AGENT_PAYLOAD_PATHS.includes(payloadPath)) {
    fail(`needs ${payloadPath} in AGENT_PAYLOAD_PATHS (tools/docs/site-paths.mjs)`);
  }
  const example_path = recipe || viaBtcpay ? null : demo ? demo.dir : row.example_path;
  if (
    example_path !== null &&
    !(
      existsSync(path.join(root, example_path)) &&
      statSync(path.join(root, example_path)).isDirectory()
    )
  ) {
    fail(`names example ${example_path}, which is not a directory in this repo`);
  }
  const video = row.video;
  const videoOk =
    video === null ||
    /^https:\/\//.test(video) ||
    servedAssets.some((asset) => asset.path === video && asset.content_type === "video/mp4");
  if (!videoOk) {
    fail(
      `video must be null, an absolute https URL, or an assets[] mp4 under docs/assets/ (got ${video})`,
    );
  }
  return {
    id: row.id,
    label: row.label,
    family: row.family,
    type: row.type,
    heading: `Accept Bitcoin & Stablecoin Payments With ${row.label}`,
    quickstart_slug: row.quickstart_slug,
    quickstart_path: `/guides/${row.quickstart_slug}`,
    quickstart_title: quickstart.title,
    agent_stack: row.agent_stack,
    agent_payload_path: payloadPath,
    agent_full_path: payloadPath && agentFullPath(payloadPath),
    adapter_package: row.adapter_package,
    install: row.install,
    requires: row.requires,
    example_path,
    example_url: example_path && `${GITHUB_TREE}/${example_path}`,
    demo_port: demo ? demo.port : null,
    video,
    shared_checkout_demo: row.shared_checkout_demo,
    capabilities: Object.fromEntries(
      CAPABILITY_FIELDS.map((field) => [field, capabilities[field]]),
    ),
    tested: viaBtcpay
      ? passed.get(row.id)?.via === "btcpay-route"
        ? passed.get(row.id)
        : null
      : ((row.agent_stack && passed.get(row.agent_stack)?.via === undefined
          ? passed.get(row.agent_stack)
          : null) ?? null),
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
  // 404 them. v9 adds `type` and `capabilities` to every frameworks[] row,
  // and recipe rows whose agent_stack, agent_payload_path, agent_full_path,
  // example_path and example_url are null. A bump because a site on v8 would
  // draw a copy button and an example link from those nulls. v10 lets a
  // recipe row carry agent directions: the five recipes get an agent_stack
  // and a payload that inlines the recipe, and still no example app. A bump
  // because a site on v9 treats every recipe row as having no directions, so
  // it would publish the payloads but hide their copy buttons. v11 adds
  // via-btcpay rows (Odoo, Magento): no example app, no shared checkout
  // demo, and a `tested` from a BTCPay-route run (`via: "btcpay-route"`, the
  // `store` and `btcpay` versions, and the plugin's version as `release`). A
  // bump because a site on v10 requires an example on every non-recipe row.
  contract_version: 11,
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
  // instead of the shared checkout panel. Since v9, show `type` on every card
  // and page and `capabilities` as the page's "How it runs" list; a recipe row
  // has no copy button and no example link, and `quickstart_path` is its recipe.
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
