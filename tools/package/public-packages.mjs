// The single authoritative list of publicly published npm packages.
// Consumed by BOTH tools/release/npm-release.mjs (what gets published) and
// tools/validate/check-release-readiness.mjs (what gets checked) so the two
// release gates can never disagree about the publishable set again.
export const OPENRECEIVE_PUBLIC_PACKAGE_NAMES = [
  "openreceive",
  "@openreceive/angular",
  "@openreceive/browser",
  "@openreceive/core",
  "@openreceive/elements",
  "@openreceive/express",
  "@openreceive/fastify",
  "@openreceive/http",
  "@openreceive/next",
  "@openreceive/node",
  "@openreceive/provider-data",
  "@openreceive/react",
  "@openreceive/svelte",
  "@openreceive/vue",
];
