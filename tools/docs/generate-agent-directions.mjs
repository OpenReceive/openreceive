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
//   2. It stays bounded. BUDGET_BYTES fails the build before the paste grows
//      past what an agent will follow as instructions rather than skim as
//      reference. Every rule that only applies to a custom UI lives in the
//      checkout-ux guide instead, whether or not there is room for it here.
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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { agentFullPath, isServablePath, MARKDOWN_SUFFIX, markdownTwin } from "./site-paths.mjs";

const root = process.cwd();
const check = process.argv.includes("--check");

// The payload never named a release, so "check the installed version against
// the documented one" was not an instruction anyone could follow: the
// documented one was not written down. It is stamped on the payload's own H1,
// from the same place generate-site-contract.mjs reads it.
const RELEASE = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;

// ~13k tokens — about 1,000 lines at the ~52 bytes per line both payloads run
// at. Raised deliberately from 24 KB (~6k tokens) on 2026-08-27: that ceiling
// was sized for an 8k-token context that had to hold the payload, the files the
// agent is editing, and its own reply. That was a reasonable floor in 2025 and
// is a conservative one now, and the Rails payload had grown into it at 93%,
// leaving the next correctness fix nowhere to go.
//
// The ceiling did not go away, because the reason for it was never only the
// context window: this is a PROMPT, and past some size an agent skims it instead
// of following it. Both payloads sat at ~30 KB before the UI rules moved into
// docs/guides/checkout-ux.md, which is the kind of growth this number exists to
// catch — a guide has no budget, and that is still where a rule belongs when it
// only applies to a custom UI.
const BUDGET_BYTES = 52_000;

// Step 0 in brief: the rules an agent breaks first when it never sees Step 0.
// They ride at the top of every payload as bullets, because a summarizing
// fetch tool keeps short bullets and drops prose (see HEADER below). Each one
// stays under 120 characters, short enough to be quoted rather than
// paraphrased; tests/agent-directions.test.mjs holds that line. The full Step 0
// in each source still governs: change it there first, then here.
const NO_ROTATION = "Do not suggest rotating or revoking a code because it was pasted here.";
const ASK_NWC_FIRST =
  "Before installing or editing anything, ask the user for a receive-only NWC code. One question per message.";
const ASK_LSC_NEXT =
  "Next ask for the LSC code. If the user wants stablecoins, USDT, USDC, ETH, SOL or crypto, do not ask yes/no first.";

const WOOCOMMERCE_BRIEF = [
  ASK_NWC_FIRST,
  ASK_LSC_NEXT,
  "The user only pastes codes into this chat. Never ask them to run a command, edit a file or use an admin page.",
  "Store each code yourself as Step 2 says. Never put a code in a shell command.",
  NO_ROTATION,
  'Setup is done only when the NWC code is saved, and the LSC code is saved or the user said "Bitcoin only".',
];

// A billing panel's extension (Paymenter, FOSSBilling) is a release ZIP plus
// console commands, so Step 0 is the plugin's: the same rules break first.
const BILLING_PANEL_BRIEF = [
  ASK_NWC_FIRST,
  ASK_LSC_NEXT,
  "The user only pastes codes into this chat. Never ask them to run a command, edit a file or use an admin page.",
  "Store each code yourself as Step 2 says. Never put a code in a shell command.",
  NO_ROTATION,
  'Setup is done only when the NWC code is saved, and the LSC code is saved or the user said "Bitcoin only".',
];

// A mobile app takes the payment on its server's checkout page, so its list
// is about where the codes may and may not go.
const MOBILE_BRIEF = [
  "Find the app's server first: OpenReceive runs there, and the app only opens its checkout page.",
  ASK_NWC_FIRST,
  ASK_LSC_NEXT,
  "Write each code into the server's env file yourself. Never into the app, its config or an EXPO_PUBLIC_ name.",
  "The app never decides paid: it asks the server. A link back to the app is navigation only.",
  NO_ROTATION,
];

/** The library stacks: the agent writes both codes into the app's env file. */
const libraryBrief = (envFile) => [
  ASK_NWC_FIRST,
  ASK_LSC_NEXT,
  `The user only pastes codes into this chat. Never ask them to edit ${envFile} or run a command to save one.`,
  `Write each code into ${envFile} yourself, as Step 0 says. Never echo it or put it in a shell command.`,
  NO_ROTATION,
  'Start the quickstart only once the NWC code is saved, and the LSC code is saved or the user said "Bitcoin only".',
];

// Lovable's agent has no terminal and keeps codes as project secrets, so its
// list asks through Lovable's secret input and never mentions a file.
const LOVABLE_BRIEF = [
  "Before adding packages or editing anything, ask the user for a receive-only NWC code. One question per message.",
  ASK_LSC_NEXT,
  "Ask for NWC_URI and LSC_URI_PRIMARY with Lovable's secret input. Never put a code in .env, code or a VITE_ name.",
  "You have no terminal: never ask the user to run a command. Every step is a file, a package, a migration or a secret.",
  NO_ROTATION,
  'Start Step 1 only once NWC_URI is saved, and LSC_URI_PRIMARY is saved or the user said "Bitcoin only".',
];

// Bolt's agent cannot store a secret: the user adds each code in Bolt's
// Secrets tab, so its list asks for that and never for a pasted code's home.
const BOLT_BRIEF = [
  "Before adding packages or editing anything, ask the user to add a receive-only NWC code as a secret.",
  ASK_LSC_NEXT,
  "The user adds NWC_URI and LSC_URI_PRIMARY in Bolt's Secrets tab. Never put a code in .env, code or a VITE_ name.",
  "Never ask the user to run a command. Every step is a file, a package, a migration, a function or a secret.",
  NO_ROTATION,
  'Start Step 1 only once NWC_URI is saved, and LSC_URI_PRIMARY is saved or the user said "Bitcoin only".',
];

// BTCPay checks the deployment first, and its own store page is a supported
// place to save a code, so it gets its own list.
const BTCPAY_BRIEF = [
  "Check first: BTCPay Server 2.4.4 or later, and the plugin installed from Plugins → Plugin Directory.",
  "Unless the store already uses OpenReceive, stop and ask the user for a receive-only NWC code.",
  "Save it via Store → OpenReceive or the Greenfield API, never BTCPay's Lightning node screen. Never echo it.",
  "If the user wants USDT, USDC, ETH or SOL, ask for an LSC code too, but do not wait for it.",
  "Never tick the spend-capable override to make a save succeed.",
  NO_ROTATION,
];

const STACKS = [
  {
    stack: "edd",
    source: "docs/agents/src/edd.md",
    quickstart: "docs/guides/quickstart-edd.md",
    brief: WOOCOMMERCE_BRIEF,
    quickstartRole:
      "Steps 0–3 above are the setup and this is their reference: where the two differ, the steps win, and its wp-admin screens are only for a store with no WP-CLI.",
  },
  {
    stack: "woocommerce",
    source: "docs/agents/src/woocommerce.md",
    quickstart: "docs/guides/quickstart-woocommerce.md",
    brief: WOOCOMMERCE_BRIEF,
    // Steps 1–3 already run the WP-CLI half of the quickstart; its wp-admin
    // screens read as a second procedure unless the payload says what they are for.
    quickstartRole:
      "Steps 0–3 above are the setup and this is their reference: where the two differ, the steps win, and its wp-admin screens are only for a store with no WP-CLI.",
  },
  {
    stack: "paymenter",
    source: "docs/agents/src/paymenter.md",
    quickstart: "docs/guides/quickstart-paymenter.md",
    brief: BILLING_PANEL_BRIEF,
    quickstartRole:
      "Steps 0–3 above are the setup and this is their reference: where the two differ, the steps win, and its admin-area screens are only for a Paymenter with no shell.",
  },
  {
    stack: "fossbilling",
    source: "docs/agents/src/fossbilling.md",
    quickstart: "docs/guides/quickstart-fossbilling.md",
    brief: BILLING_PANEL_BRIEF,
    quickstartRole:
      "Steps 0–3 above are the setup and this is their reference: where the two differ, the steps win, and its admin-area screens are only for a FOSSBilling with no shell.",
  },
  {
    stack: "prestashop",
    source: "docs/agents/src/prestashop.md",
    quickstart: "docs/guides/quickstart-prestashop.md",
    brief: BILLING_PANEL_BRIEF,
    quickstartRole:
      "Steps 0–3 above are the setup and this is their reference: where the two differ, the steps win, and its back-office screens are only for a PrestaShop with no shell.",
  },
  {
    stack: "medusa",
    source: "docs/agents/src/medusa.md",
    quickstart: "docs/guides/quickstart-medusa.md",
    brief: libraryBrief(".env"),
    quickstartRole:
      "Steps 0–4 above are the setup and this is their reference: it has the code they name. Where the two differ, the steps win, and its admin screens are only for a store whose Medusa server has no shell.",
  },
  {
    stack: "vendure",
    source: "docs/agents/src/vendure.md",
    quickstart: "docs/guides/quickstart-vendure.md",
    brief: libraryBrief(".env"),
    quickstartRole:
      "Steps 0–4 above are the setup and this is their reference: it has the code they name. Where the two differ, the steps win, and its dashboard screens are only for a shop whose Vendure server has no shell.",
  },
  {
    stack: "node",
    source: "docs/agents/src/node.md",
    quickstart: "docs/guides/quickstart-node.md",
    brief: libraryBrief(".env"),
  },
  {
    stack: "fastify",
    source: "docs/agents/src/fastify.md",
    quickstart: "docs/guides/quickstart-fastify.md",
    brief: libraryBrief(".env"),
  },
  {
    stack: "next",
    source: "docs/agents/src/next.md",
    quickstart: "docs/guides/quickstart-next.md",
    brief: libraryBrief(".env.local"),
  },
  {
    stack: "nestjs",
    source: "docs/agents/src/nestjs.md",
    quickstart: "docs/guides/quickstart-nestjs.md",
    brief: libraryBrief(".env"),
  },
  {
    stack: "fastapi",
    source: "docs/agents/src/fastapi.md",
    quickstart: "docs/guides/quickstart-fastapi.md",
    brief: libraryBrief(".env"),
  },
  {
    stack: "django",
    source: "docs/agents/src/django.md",
    quickstart: "docs/guides/quickstart-django.md",
    brief: libraryBrief(".env"),
  },
  {
    stack: "flask",
    source: "docs/agents/src/flask.md",
    quickstart: "docs/guides/quickstart-flask.md",
    brief: libraryBrief(".env"),
  },
  {
    stack: "rails",
    source: "docs/agents/src/rails.md",
    quickstart: "docs/guides/quickstart-rails.md",
    brief: libraryBrief(".env"),
  },
  {
    stack: "php",
    source: "docs/agents/src/php.md",
    quickstart: "docs/guides/quickstart-php.md",
    brief: libraryBrief(".env"),
  },
  {
    stack: "laravel",
    source: "docs/agents/src/laravel.md",
    quickstart: "docs/guides/quickstart-laravel.md",
    brief: libraryBrief(".env"),
  },
  {
    stack: "btcpay",
    source: "docs/agents/src/btcpay.md",
    quickstart: "docs/guides/quickstart-btcpay.md",
    brief: BTCPAY_BRIEF,
  },
  {
    stack: "lovable",
    source: "docs/agents/src/lovable.md",
    quickstart: "docs/recipes/tanstack-start.md",
    quickstartSlug: "tanstack-start-recipe",
    brief: LOVABLE_BRIEF,
    quickstartRole:
      "Steps 0–6 above are the setup on Lovable and this recipe is their reference: follow its On Supabase (Lovable) section, not its pg pool, and skip its npm commands. Where the two differ, the steps win.",
    // Lovable's agent reads pages with its fetch tool and has no shell.
    fetchOnly: true,
  },
  {
    stack: "bolt",
    source: "docs/agents/src/bolt.md",
    quickstart: "docs/recipes/supabase-edge-functions.md",
    quickstartSlug: "supabase-edge-functions-recipe",
    brief: BOLT_BRIEF,
    quickstartRole:
      "Steps 0–6 above are the setup on Bolt and this recipe is their reference: its function and page are the code to write, and its supabase CLI commands are Bolt's Secrets tab and Bolt's own deploy. Where the two differ, the steps win.",
    // Bolt's agent reads pages with its fetch tool; the WebContainer it runs
    // commands in cannot reach every host.
    fetchOnly: true,
  },
  {
    stack: "sveltekit",
    source: "docs/agents/src/sveltekit.md",
    quickstart: "docs/recipes/sveltekit.md",
    quickstartSlug: "sveltekit-recipe",
    brief: libraryBrief(".env"),
  },
  {
    stack: "nuxt",
    source: "docs/agents/src/nuxt.md",
    quickstart: "docs/recipes/nuxt.md",
    quickstartSlug: "nuxt-recipe",
    brief: libraryBrief(".env"),
  },
  {
    stack: "astro",
    source: "docs/agents/src/astro.md",
    quickstart: "docs/recipes/astro.md",
    quickstartSlug: "astro-recipe",
    brief: libraryBrief(".env"),
  },
  {
    stack: "react-router",
    source: "docs/agents/src/react-router.md",
    quickstart: "docs/recipes/react-router.md",
    quickstartSlug: "react-router-recipe",
    brief: libraryBrief(".env"),
  },
  {
    stack: "tanstack-start",
    source: "docs/agents/src/tanstack-start.md",
    quickstart: "docs/recipes/tanstack-start.md",
    quickstartSlug: "tanstack-start-recipe",
    brief: libraryBrief(".env"),
    // The recipe's route builds a stack per request for Workers; on Node the
    // directions' one-stack module replaces it.
    quickstartRole:
      "On Node, the one-stack module in the non-negotiables above replaces its per-request handleOpenReceive, and its On Supabase (Lovable) section does not apply.",
  },
  {
    stack: "mobile",
    source: "docs/agents/src/mobile.md",
    quickstart: "docs/guides/mobile-apps.md",
    brief: MOBILE_BRIEF,
    quickstartRole:
      "Steps 1 and 2 above say when to use each part: its server code is an example in Express, for the server's own stack.",
  },
];

/**
 * Guides a payload is allowed NOT to link, and why.
 *
 * Everything else in the manifest's `public` set has to appear in the payload's
 * reading list. That list used to be a hand-kept literal beside a manifest the
 * generator was already reading, so publishing a guide and forgetting to name
 * it was silent — and the guides that went missing were the ones answering the
 * questions an integrator gets wrong (provider-registry.md owns the
 * asset-hosting rule; the payload sent readers to a three-paragraph summary
 * instead).
 *
 * A reason is required, so dropping a guide off the list is a decision someone
 * wrote down rather than an omission nobody noticed.
 */
const UNLISTED_GUIDES = {
  "agent-directions-woocommerce": "this payload’s own page",
  "agent-directions-paymenter": "this payload's own page",
  "quickstart-paymenter": "inlined in full below, or another stack's",
  "agent-directions-fossbilling": "this payload's own page",
  "quickstart-fossbilling": "inlined in full below, or another stack's",
  "agent-directions-prestashop": "this payload's own page",
  "quickstart-prestashop": "inlined in full below, or another stack's",
  "agent-directions-medusa": "this payload's own page",
  "quickstart-medusa": "inlined in full below, or another stack's",
  "agent-directions-vendure": "this payload's own page",
  "quickstart-vendure": "inlined in full below, or another stack's",
  "quickstart-woocommerce": "inlined in full below, or another stack’s",
  "agent-directions-edd": "this payload's own page",
  "quickstart-edd": "inlined in full below, or another stack's",
  "wordpress-hosting": "WordPress hosts only; the WooCommerce quickstart links it",
  odoo: "a store that takes payments through BTCPay Server; the merchant's guide, on its integration page",
  magento:
    "a store that takes payments through BTCPay Server; the merchant's guide, on its integration page",
  prestashop:
    "PrestaShop through BTCPay Server, the other way in; the PrestaShop quickstart links it",
  vercel: "for people who hand these directions to v0; it links them, not the reverse",
  lovable: "for people who build on Lovable; the Lovable payload links it, not the other stacks",
  "agent-directions-lovable": "this payload's own page",
  bolt: "for people who build on Bolt; the Bolt payload links it, not the other stacks",
  "agent-directions-bolt": "this payload's own page",
  "supabase-edge-functions-recipe":
    "an Edge Function on another site than its page; the Bolt payload inlines it and the Supabase guide links it",
  "supabase-migration":
    "the Supabase over HTTPS migration, for agents with no terminal; the Lovable payload and the Supabase guide link it",
  replit: "for people who hand these directions to Replit Agent; it links them, not the reverse",
  "how-we-test-platforms": "explains the Tested badges to people; it is not integration guidance",
  "agent-directions-node": "this payload's own page",
  "agent-directions-fastify": "this payload's own page",
  "agent-directions-next": "this payload's own page",
  "agent-directions-nestjs": "this payload's own page",
  "agent-directions-fastapi": "this payload's own page",
  "agent-directions-django": "this payload's own page",
  "agent-directions-flask": "this payload's own page",
  "agent-directions-rails": "this payload's own page",
  "agent-directions-php": "this payload's own page",
  "agent-directions-laravel": "this payload's own page",
  "agent-directions-btcpay": "this payload's own page",
  "agent-directions-sveltekit": "this payload's own page",
  "agent-directions-nuxt": "this payload's own page",
  "agent-directions-astro": "this payload's own page",
  "agent-directions-react-router": "this payload's own page",
  "agent-directions-tanstack-start": "this payload's own page",
  "agent-directions-mobile": "this payload's own page",
  guides: "linked as the index at the end of the reading list, not as an entry",
  "quickstart-node": "inlined in full below, or another stack's",
  "quickstart-fastify": "inlined in full below, or another stack's",
  "quickstart-next": "inlined in full below, or another stack's",
  "quickstart-nestjs": "inlined in full below, or another stack's",
  "quickstart-fastapi": "inlined in full below, or another stack's",
  "quickstart-django": "inlined in full below, or another stack's",
  "quickstart-flask": "inlined in full below, or another stack's",
  "quickstart-rails": "inlined in full below, or another stack's",
  "quickstart-php": "inlined in full below, or another stack's",
  "quickstart-laravel": "inlined in full below, or another stack's",
  "quickstart-btcpay": "inlined in full below, or another stack's",
  "btcpay-reference":
    "the BTCPay plugin's reference; linked from the BTCPay payload, another stack's otherwise",
  "node-orms": "Node only; the Rails engine owns its tables",
  "tanstack-start-recipe":
    "TanStack Start only; the Next.js payload links it as the web-standard sibling, the other stacks have no use for it",
  ...Object.fromEntries(
    ["sveltekit-recipe", "nuxt-recipe", "astro-recipe", "react-router-recipe"].map((slug) => [
      slug,
      "one JavaScript framework each; the Node and Next.js payloads link them for an app that turns out to be that framework",
    ]),
  ),
};

/**
 * Guides one stack's payload may skip on top of the shared list. The BTCPay
 * plugin has no host hooks, no `openreceive_payments` table, no mounted routes
 * and no browser package: BTCPay's checkout is the UI and BTCPay owns pricing,
 * budgets and authorization. Listing the library guides there would send an
 * agent to install npm packages into a BTCPay deployment. The Node and Rails
 * payloads keep linking every one of these.
 */
const UNLISTED_GUIDES_BY_STACK = {
  woocommerce: {
    ...Object.fromEntries(
      [
        "authorization",
        "storage",
        "frontend-checkout",
        "checkout-ux",
        "headless-checkout",
        "custom-checkout-route",
        "provider-registry",
        "host-testing",
        "rate-limiting",
        "environment-variables",
        "deploying",
        "api-reference",
        "react-material-ui-recipe",
      ].map((slug) => [
        slug,
        "WooCommerce plugin supplies these internals; its quickstart documents the merchant setup",
      ]),
    ),
    supabase: "WordPress keeps its data in MySQL",
    serverless: "WordPress runs on an ordinary PHP host",
    "mobile-apps": "the WooCommerce store's own checkout is the payment page",
  },
  edd: {
    ...Object.fromEntries(
      [
        "authorization",
        "storage",
        "frontend-checkout",
        "checkout-ux",
        "headless-checkout",
        "custom-checkout-route",
        "provider-registry",
        "host-testing",
        "rate-limiting",
        "environment-variables",
        "deploying",
        "api-reference",
        "react-material-ui-recipe",
      ].map((slug) => [
        slug,
        "the WordPress plugin supplies these internals; its quickstart documents the merchant setup",
      ]),
    ),
    supabase: "WordPress keeps its data in MySQL",
    serverless: "WordPress runs on an ordinary PHP host",
    "mobile-apps": "the EDD store's own purchase confirmation page is the payment page",
    "wordpress-hosting": "linked from the quickstart's GMP section",
  },
  paymenter: {
    ...Object.fromEntries(
      [
        "authorization",
        "storage",
        "frontend-checkout",
        "checkout-ux",
        "headless-checkout",
        "custom-checkout-route",
        "provider-registry",
        "host-testing",
        "rate-limiting",
        "environment-variables",
        "deploying",
        "api-reference",
        "react-material-ui-recipe",
        "node-orms",
      ].map((slug) => [
        slug,
        "the Paymenter extension supplies these internals; its quickstart documents the merchant setup",
      ]),
    ),
    supabase: "Paymenter keeps its data in MySQL or MariaDB",
    serverless: "Paymenter runs on an ordinary PHP host",
    "mobile-apps": "Paymenter's own invoice page is the payment page",
    "wordpress-hosting": "WordPress hosts only",
  },
  fossbilling: {
    ...Object.fromEntries(
      [
        "authorization",
        "storage",
        "frontend-checkout",
        "checkout-ux",
        "headless-checkout",
        "custom-checkout-route",
        "provider-registry",
        "host-testing",
        "rate-limiting",
        "environment-variables",
        "deploying",
        "api-reference",
        "react-material-ui-recipe",
        "node-orms",
      ].map((slug) => [
        slug,
        "the FOSSBilling extension supplies these internals; its quickstart documents the merchant setup",
      ]),
    ),
    supabase: "FOSSBilling keeps its data in MySQL or MariaDB",
    serverless: "FOSSBilling runs on an ordinary PHP host",
    "mobile-apps": "FOSSBilling's own invoice page is the payment page",
    "wordpress-hosting": "WordPress hosts only",
  },
  prestashop: {
    ...Object.fromEntries(
      [
        "authorization",
        "storage",
        "frontend-checkout",
        "checkout-ux",
        "headless-checkout",
        "custom-checkout-route",
        "provider-registry",
        "host-testing",
        "rate-limiting",
        "environment-variables",
        "deploying",
        "api-reference",
        "react-material-ui-recipe",
        "node-orms",
      ].map((slug) => [
        slug,
        "the PrestaShop module supplies these internals; its quickstart documents the merchant setup",
      ]),
    ),
    supabase: "PrestaShop keeps its data in MySQL or MariaDB",
    serverless: "PrestaShop runs on an ordinary PHP host",
    "mobile-apps": "PrestaShop's own order confirmation page is the payment page",
    "wordpress-hosting": "WordPress hosts only",
  },
  medusa: {
    ...Object.fromEntries(
      [
        "authorization",
        "storage",
        "custom-checkout-route",
        "host-testing",
        "rate-limiting",
        "environment-variables",
        "deploying",
        "api-reference",
        "node-orms",
      ].map((slug) => [
        slug,
        "the Medusa plugin supplies these internals; its quickstart documents the merchant setup",
      ]),
    ),
    "frontend-checkout": "the quickstart has the storefront's checkout code",
    "checkout-ux": "the storefront shows the shipped checkout, as the quickstart does",
    "headless-checkout": "the storefront shows the shipped checkout, as the quickstart does",
    "provider-registry": "the shipped checkout carries the provider registry",
    "react-material-ui-recipe": "the Next.js starter's checkout is Medusa UI, not Material UI",
    supabase: "Medusa keeps its data in its own PostgreSQL database",
    serverless: "a Medusa server is a long-running Node process",
    "mobile-apps": "the storefront's own checkout is the payment page",
    "wordpress-hosting": "WordPress hosts only",
  },
  vendure: {
    ...Object.fromEntries(
      [
        "authorization",
        "storage",
        "custom-checkout-route",
        "host-testing",
        "rate-limiting",
        "environment-variables",
        "deploying",
        "api-reference",
        "node-orms",
      ].map((slug) => [
        slug,
        "the Vendure plugin supplies these internals; its quickstart documents the merchant setup",
      ]),
    ),
    "frontend-checkout": "the quickstart has the storefront's checkout code",
    "checkout-ux": "the storefront shows the shipped checkout, as the quickstart does",
    "headless-checkout": "the storefront shows the shipped checkout, as the quickstart does",
    "provider-registry": "the shipped checkout carries the provider registry",
    "react-material-ui-recipe": "the Next.js starter's checkout is shadcn/ui, not Material UI",
    supabase: "Vendure keeps its data in its own database",
    serverless: "a Vendure server and its worker are long-running Node processes",
    "mobile-apps": "the storefront's own checkout is the payment page",
    "wordpress-hosting": "WordPress hosts only",
  },
  btcpay: {
    authorization:
      "BTCPay's store permissions and invoice ids authorize; there is no authorize hook",
    storage: "the plugin owns openreceive_swaps inside BTCPay's database, not openreceive_payments",
    "frontend-checkout": "BTCPay's checkout is the UI; the plugin ships no browser package",
    "checkout-ux": "BTCPay's checkout is the UI; the plugin's Vue component already follows it",
    "headless-checkout": "no @openreceive/browser in a BTCPay deployment",
    "custom-checkout-route": "the plugin mounts no OpenReceive routes to replace",
    "provider-registry": "no wallet wizard; BTCPay's checkout offers the wallets",
    "price-feeds": "BTCPay owns fiat rates",
    "host-testing": "no host hooks to test; packages/dotnet/docker is the end-to-end stack",
    "rate-limiting":
      "BTCPay owns request budgets; the swap routes are bounded by the invoice-id bearer and the provider weight budget",
    "environment-variables":
      "no environment variables; every setting lives in BTCPay's store settings",
    deploying: "BTCPay's own deployment; settlement is BTCPay's LightningListener",
    "api-reference": "documents the library API; the plugin's routes are in the BTCPay quickstart",
    "react-material-ui-recipe": "a custom browser UI recipe; not applicable inside BTCPay",
    supabase: "BTCPay keeps the plugin's table in its own database",
    serverless: "BTCPay Server is a long-running server",
    "mobile-apps": "BTCPay's checkout is the payment page",
  },
  lovable: {
    "node-orms": "no ORM: payments go through Supabase's HTTPS API",
    "headless-checkout": "Lovable apps use the drop-in; the directions forbid a custom checkout UI",
    "custom-checkout-route": "the recipe's route is the integration",
    "host-testing": "Lovable's agent has no terminal to run host tests",
    "payment-safety-upgrade": "a new integration has no existing attempts to upgrade",
    "react-material-ui-recipe":
      "Lovable apps use the drop-in; the directions forbid a custom checkout UI",
    serverless: "the Lovable directions already cover Cloudflare Workers, Lovable's only host",
    "mobile-apps": "Lovable builds web apps",
  },
  bolt: {
    "node-orms": "no ORM: payments go through Supabase's HTTPS API",
    "headless-checkout": "Bolt apps use the drop-in; the directions forbid a custom checkout UI",
    "custom-checkout-route": "the recipe's function is the integration",
    "host-testing": "the server function has no host hooks to test outside Supabase",
    "payment-safety-upgrade": "a new integration has no existing attempts to upgrade",
    "react-material-ui-recipe":
      "Bolt apps use the drop-in; the directions forbid a custom checkout UI",
    serverless: "the recipe already covers Supabase Edge Functions, Bolt's server functions",
    "mobile-apps":
      "Bolt's mobile apps are Expo apps; their payments go through the mobile directions",
  },
  rails: {
    supabase: "the Supabase guide covers Node and Python servers",
    serverless: "the serverless guide covers Node and Python servers",
  },
  php: {
    supabase: "the Supabase guide covers Node and Python servers",
    serverless: "the serverless guide covers Node and Python servers",
  },
  laravel: {
    supabase: "the Supabase guide covers Node and Python servers",
    serverless: "the serverless guide covers Node and Python servers",
  },
  // The app's server gets OpenReceive from its own directions, which link
  // these; the mobile payload keeps to the app, the checkout link and the page.
  mobile: Object.fromEntries(
    [
      "api-reference",
      "automated-swaps",
      "checkout-ux",
      "custom-checkout-route",
      "environment-variables",
      "headless-checkout",
      "payment-safety-upgrade",
      "price-feeds",
      "provider-registry",
      "rate-limiting",
      "react-material-ui-recipe",
      "storage",
    ].map((slug) => [slug, "the server's own directions link it"]),
  ),
};

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
  // The shared-section fences (tools/docs/check-quickstart-parity.mjs) are a
  // build-time gate, not prose; a pasted payload has no use for them.
  // A screenshot is for a human reading the guide. The payload's reader is a
  // coding agent, so an <img> line is budget spent on a picture it cannot see,
  // pointing at a repository path that is dead once this file is pasted
  // elsewhere — the same reason the relative-link rewrite below drops those.
  // The step's own bold instruction above it says what the picture shows.
  const lines = markdown
    .replace(/\n## Next\n[\s\S]*$/, "\n")
    .split("\n")
    .filter(
      (line) =>
        !/^<!-- shared:(begin|end) [a-z0-9-]+ -->$/.test(line) &&
        !/^\s*<img\b[^>]*>\s*$/.test(line),
    );
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    out.push(inFence || !/^#{1,5} /.test(line) ? line : `#${line}`);
  }
  return (
    out
      .join("\n")
      // A recipe links its siblings by file name (`tanstack-start.md`); their
      // public slugs carry a `-recipe` suffix.
      .replace(/\]\(([a-z0-9-]+)\.md(#[a-z0-9_-]+)?\)/g, (whole, file, anchor) => {
        const slug = publicSlugs.has(file) ? file : `${file}-recipe`;
        return publicSlugs.has(slug) ? `](${GUIDE_MARKDOWN_URL(slug)}${anchor ?? ""})` : whole;
      })
      // A path into the repository (the demo app, a contributor doc) is dead
      // once the file has been pasted somewhere else, and cloning is not the
      // shape of this integration. Keep the name, drop the link.
      .replace(/\[([^\]]+)\]\(\.{1,2}\/[^)]+\)/g, "$1")
      // Preserve blank lines inside code examples (including Python class spacing).
      .trim()
  );
}

// A web-fetch tool hands the agent another model's rewrite of a page, not the
// page. Claude Code's turned the 17 KB WooCommerce payload into 1.6 KB with
// Step 0 gone; with a download block and Step 0 in brief at the top, the next
// rewrite (1 KB, in Claude Code's own voice) cut both. The more a page says,
// the more the rewrite picks and chooses. So the URL people paste,
// /agent-directions/<stack>.md, serves COVER below: a title, the size, and one
// curl line to the full file. A rewrite of a page that short has nothing else
// to keep. The full file opens with FULL_FILE_LINE so an agent that lands on it
// does not go looking for a fuller one, and keeps the download block (pointed
// at itself, for an agent that web-fetched it anyway) and Step 0 in brief. The
// block's skip line is there because the same bytes are pasted by the site's
// copy button and mirrored into the skills, whose readers have the whole file.
const fullUrl = (stack) =>
  `https://openreceive.org${agentFullPath(`/agent-directions/${stack}.md`)}`;

const FULL_FILE_LINE = "This is the full file; follow it from Step 0.";

const HEADER = (stack, kilobytes, fetchOnly) =>
  fetchOnly
    ? [
        "```text",
        `READ THIS FIRST: this file is ${kilobytes} KB and a summary drops required steps. Read all of it:`,
        fullUrl(stack),
        "If your fetch tool gave you a summary, fetch that URL again for the full text.",
        "```",
      ].join("\n")
    : [
        "```sh",
        `# READ THIS FIRST: this file is ${kilobytes} KB and a summary drops required steps. Download it whole:`,
        `curl -fsSL ${fullUrl(stack)}`,
        "# Skip the download only if you already have all of it: pasted, read from disk or fetched raw.",
        "```",
      ].join("\n");

// Every line here competes with the curl line in a rewrite: add nothing.
// tests/agent-directions.test.mjs holds it under 400 characters.
const COVER = (stack, name, kilobytes, fetchOnly) =>
  fetchOnly
    ? [
        `# OpenReceive agent directions: ${name} (${RELEASE})`,
        "",
        `These directions are ${kilobytes} KB. Fetch the full file and follow it from Step 0:`,
        "",
        `    ${fullUrl(stack)}`,
        "",
        "Do this before anything else. A summary of them drops required steps.",
        "",
      ].join("\n")
    : [
        `# OpenReceive agent directions: ${name} (${RELEASE})`,
        "",
        `These directions are ${kilobytes} KB. Download them with your shell and follow them from Step 0:`,
        "",
        `    curl -fsSL ${fullUrl(stack)}`,
        "",
        "Do this before anything else. A web-fetch summary of them drops required steps.",
        "",
      ].join("\n");

function render(
  stack,
  brief,
  directions,
  quickstart,
  quickstartSlug,
  publicSlugs,
  role,
  fetchOnly,
  kilobytes,
) {
  const top = [
    HEADER(stack, kilobytes, fetchOnly),
    "",
    "**Step 0 in brief** (Step 0 below has the details):",
    "",
    ...brief.map((rule) => `- ${rule}`),
    "",
    `These directions describe OpenReceive ${RELEASE}.`,
  ].join("\n");
  return [
    FULL_FILE_LINE,
    "",
    directions
      .trim()
      .replace(/^# (.*)$/m, (title) => `${title}\n\n${top}`)
      // A pinned download (the WordPress plugin ZIP) names the release it describes.
      .replaceAll("{{release}}", RELEASE),
    "",
    "---",
    "",
    "## The quickstart, in full",
    "",
    ...(role === undefined
      ? [
          "Inlined verbatim so this file needs no network access — follow it once Step 0",
          `passes. The page it comes from is ${GUIDE_URL(quickstartSlug)}.`,
        ]
      : [
          `Inlined verbatim so this file needs no network access. ${role}`,
          `The page it comes from is ${GUIDE_URL(quickstartSlug)}.`,
        ]),
    "",
    inlineGuide(quickstart, publicSlugs),
    "",
  ].join("\n");
}

/** Renders until the size the header states is the size of the file it is in. */
function renderSized(...args) {
  let kilobytes = 0;
  for (;;) {
    const payload = render(...args, kilobytes);
    const actual = Math.round(Buffer.byteLength(payload, "utf8") / 1000);
    if (actual === kilobytes) return { payload, kilobytes };
    kilobytes = actual;
  }
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
    if (isServablePath(pathname, publicSlugs)) continue;
    bad.push(pathname);
  }
  return [...new Set(bad)];
}

/**
 * Public guides this payload neither links nor has a reason to skip. The
 * reading list IS the payload for anything not inlined, so a guide the site
 * serves and the payload never names is unreachable to its one reader.
 */
export function unlistedGuides(payload, publicSlugs, stack) {
  const linked = new Set(
    [...payload.matchAll(/https:\/\/openreceive\.org\/guides\/([a-z0-9-]+)/g)].map(
      (match) => match[1],
    ),
  );
  const stackUnlisted = UNLISTED_GUIDES_BY_STACK[stack] ?? {};
  return [...publicSlugs]
    .filter((slug) => !linked.has(slug))
    .filter(
      (slug) =>
        UNLISTED_GUIDES[slug] === undefined &&
        stackUnlisted[slug] === undefined &&
        slug !== `quickstart-${stack}`,
    )
    .sort();
}

const { publicSlugs } = readManifestSlugs();
const problems = [];
const built = [];

/** Writes `content` to `target`, or under --check reports it stale. */
function sync(target, content) {
  const absolute = path.join(root, target);
  const current = (() => {
    try {
      return readFileSync(absolute, "utf8");
    } catch {
      return null;
    }
  })();
  if (current === content) return;
  if (check) problems.push(`${target} is stale. Run \`npm run generate:agent-directions\`.`);
  else {
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

for (const { stack, source, quickstart, brief, quickstartRole, fetchOnly, ...entry } of STACKS) {
  const target = `docs/agents/${stack}.md`;
  const coverTarget = `docs/agents/cover/${stack}.md`;
  const quickstartSlug = entry.quickstartSlug ?? path.basename(quickstart, ".md");
  const directions = readFileSync(path.join(root, source), "utf8");
  const name = directions.match(/^# OpenReceive agent directions \((.+)\)$/m)?.[1];
  if (name === undefined) {
    problems.push(`${source}: the title must read "# OpenReceive agent directions (<platform>)".`);
    continue;
  }
  const { payload, kilobytes } = renderSized(
    stack,
    brief,
    directions,
    readFileSync(path.join(root, quickstart), "utf8"),
    quickstartSlug,
    publicSlugs,
    quickstartRole,
    fetchOnly === true,
  );
  const cover = COVER(stack, name, kilobytes, fetchOnly === true);

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

  const unlisted = unlistedGuides(payload, publicSlugs, stack);
  if (unlisted.length > 0) {
    problems.push(
      `${target}: ${unlisted.join(", ")} ${unlisted.length === 1 ? "is" : "are"} published in ` +
        `docs/manifest.json but never linked from the payload. Add it to the reading list in ` +
        `${source}, or give it a reason in UNLISTED_GUIDES (or UNLISTED_GUIDES_BY_STACK) in this generator.`,
    );
  }

  const unserved = unservedUrls(payload + cover, publicSlugs);
  if (unserved.length > 0) {
    problems.push(
      `${target}: links to openreceive.org ${unserved.join(", ")}, which is neither a public ` +
        `doc in docs/manifest.json nor a site-owned path in SITE_OWNED_PATHS.`,
    );
  }

  sync(target, payload);
  sync(coverTarget, cover);
  built.push({ target, bytes, source, quickstart, coverTarget, coverBytes: cover.length });
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`error: ${problem}`);
  process.exit(1);
}

for (const { target, bytes, coverTarget, coverBytes } of built) {
  const percent = Math.round((bytes / BUDGET_BYTES) * 100);
  console.log(
    `${check ? "Checked" : "Wrote"} ${target}: ${bytes} bytes (${percent}% of budget, ~${Math.round(bytes / 4000)}k tokens) + ${coverTarget}: ${coverBytes} bytes`,
  );
}
