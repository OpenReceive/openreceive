// Pages openreceive.org authors and owns, as opposed to rendering from a source
// file in this repo. The agent directions link to these by URL, so the list is
// shared: `generate-agent-directions.mjs` allows a link to one of them, and
// `generate-site-contract.mjs` publishes them as pages the site must keep.
// A payload already pasted into someone's editor cannot be recalled, so
// renaming one of these breaks integrations that are already running.
export const SITE_OWNED_PATHS = [
  "/",
  "/api_docs",
  "/guides",
  "/contact",
  "/get_a_nwc_code_to_receive_payments",
  "/set_up_swap_provider",
  // The agent-discovery set. These URLs must exist, and unlike the rest of
  // this list their bytes come from this repo: the contract's
  // `agent_discovery` section names a source for /llms.txt and /openapi.yaml,
  // and /agents is a rendered page like a guide (docs/site/agents.md).
  "/llms.txt",
  "/openapi.yaml",
  "/agents",
  // The BTCPay Server home (contract v4): the plugin README rendered as a page,
  // with its screenshots served from the contract's `assets[]`.
  "/btcpay",
  "/wordpress",
  // The terms and privacy policy for the price mirror. The WordPress.org
  // plugin readme must link one for every external service the plugin calls.
  "/privacy",
];

// Integration aliases share the canonical framework row and agent payload.
// The Rails site imports these obligations from docs/site-contract.json.
export const SITE_REDIRECTS = [
  { from: "/integrations/wordpress", to: "/integrations/woocommerce", status: 301 },
];

// Every page the site renders from a source in THIS repo is also served as raw
// markdown at the same URL with `.md` appended.
//
// openreceive.org renders guides in the browser, so a plain GET of
// https://openreceive.org/guides/storage returns an application shell with no
// words in it. An agent told to read that URL does not get a bad page, it gets
// no page — and cannot tell that from a blocked network, which is the failure
// this whole contract exists to prevent. So the directions link the `.md` twin,
// and the twin is as much a published interface as the page it mirrors.
export const MARKDOWN_SUFFIX = ".md";

export const markdownTwin = (urlPath) => `${urlPath}${MARKDOWN_SUFFIX}`;

// The site-owned pages that are nonetheless generated from a source here, so
// they have a markdown twin. The rest of SITE_OWNED_PATHS is hand-authored
// HTML on the site with no markdown behind it (/llms.txt and /openapi.yaml
// need no twin — they are already the raw artifact).
export const MARKDOWN_TWINNED_SITE_PAGES = [
  "/api_docs",
  "/guides",
  "/agents",
  "/btcpay",
  "/wordpress",
];

// The agent-directions URLs people paste and the videos show. Since contract
// v7 each is a cover page a few hundred bytes long whose one instruction is to
// download the full directions at agentFullPath() with the shell: a web-fetch
// tool hands the agent another model's rewrite of a page, and a rewrite of a
// long page drops the steps that matter. generate-site-contract.mjs owns the
// sources; these lists only make the paths servable to the link check below.
export const AGENT_PAYLOAD_PATHS = [
  "/agent-directions/node.md",
  "/agent-directions/fastify.md",
  "/agent-directions/next.md",
  "/agent-directions/fastapi.md",
  "/agent-directions/django.md",
  "/agent-directions/rails.md",
  "/agent-directions/php.md",
  "/agent-directions/laravel.md",
  "/agent-directions/btcpay.md",
  "/agent-directions/woocommerce.md",
];

/** The full directions behind a cover: what the copy button copies and the cover's curl fetches. */
export const agentFullPath = (payloadPath) => payloadPath.replace(/\.md$/, "/full.md");
export const AGENT_FULL_PATHS = AGENT_PAYLOAD_PATHS.map(agentFullPath);

/**
 * Whether openreceive.org serves this pathname: a site-owned path, an agent
 * cover or full payload, a `/guides/<slug>` page for a public manifest slug, or the `.md`
 * markdown twin of either. Shared by every generator that emits an
 * openreceive.org URL, so a link that would 404 fails the build in one place.
 */
export function isServablePath(pathname, publicSlugs) {
  if (SITE_OWNED_PATHS.includes(pathname)) return true;
  if (SITE_REDIRECTS.some((redirect) => redirect.from === pathname)) return true;
  if (AGENT_PAYLOAD_PATHS.includes(pathname) || AGENT_FULL_PATHS.includes(pathname)) return true;
  const isTwin = pathname.endsWith(MARKDOWN_SUFFIX);
  const page = isTwin ? pathname.slice(0, -MARKDOWN_SUFFIX.length) : pathname;
  if (isTwin && MARKDOWN_TWINNED_SITE_PAGES.includes(page)) return true;
  const guide = page.match(/^\/guides\/([a-z0-9-]+)$/);
  return Boolean(guide) && publicSlugs.has(guide[1]);
}
