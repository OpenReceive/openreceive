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
