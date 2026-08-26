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

// The two site-owned pages that are nonetheless generated from a source here,
// so they have a markdown twin. The rest of SITE_OWNED_PATHS is hand-authored
// HTML on the site with no markdown behind it.
export const MARKDOWN_TWINNED_SITE_PAGES = ["/api_docs", "/guides"];
