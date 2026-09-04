#!/usr/bin/env node

// Writes docs/site/llms.txt — the /llms.txt index openreceive.org serves
// verbatim (the contract's agent_discovery section names it as a source).
//
// The file exists to be read by something without a browser, so every
// documentation link is the raw-markdown twin, never the rendered page: the
// page URL returns an empty application shell to anything that cannot run its
// JS. The guide list is generated from docs/manifest.json rather than curated
// twice, so publishing a guide and forgetting to index it cannot happen.
//
// `--check` fails the gate when the committed file is stale.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isServablePath, MARKDOWN_SUFFIX } from "./site-paths.mjs";

const root = process.cwd();
const check = process.argv.includes("--check");
const TARGET = "docs/site/llms.txt";
const SITE = "https://openreceive.org";

const manifest = JSON.parse(readFileSync(path.join(root, "docs/manifest.json"), "utf8"));
const release = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;

// Slugs the generated guide list skips: the quickstarts are already in Start
// here, the payload pages are linked as their fetchable .md artifacts, and the
// guides index is named in the section prose.
const LISTED_ELSEWHERE = new Set([
  "quickstart-node",
  "quickstart-rails",
  "quickstart-btcpay",
  "agent-directions-node",
  "agent-directions-rails",
  "agent-directions-btcpay",
  "guides",
]);

const guideLines = manifest.docs
  .filter((doc) => doc.public && !LISTED_ELSEWHERE.has(doc.slug))
  .map((doc) => `- [${doc.title}](${SITE}/guides/${doc.slug}${MARKDOWN_SUFFIX})`);

const content = `# OpenReceive

> Open-source libraries for accepting inbound Bitcoin Lightning payments
> directly into a wallet the application owner controls, plus a BTCPay Server
> plugin that does the same for a BTCPay store. OpenReceive never holds funds,
> has no accounts or API keys, and connects through a receive-only Nostr
> Wallet Connect (NWC) code. This index describes OpenReceive ${release}.

Every documentation link below is raw markdown — fetch it directly, no browser
needed. Appending \`.md\` to any guide page URL returns the same document as
markdown.

## Start here

- [Node quickstart](${SITE}/guides/quickstart-node${MARKDOWN_SUFFIX}): Express, Fastify, or Next.js server with any frontend
- [Rails quickstart](${SITE}/guides/quickstart-rails${MARKDOWN_SUFFIX})
- [BTCPay Server quickstart](${SITE}/guides/quickstart-btcpay${MARKDOWN_SUFFIX}): the OpenReceive plugin, a receive-only NWC wallet as a store's Lightning node
- [Agent directions, Node](${SITE}/agent-directions/node.md): a self-contained integration prompt for a coding agent, quickstart inlined
- [Agent directions, Rails](${SITE}/agent-directions/rails.md)
- [Agent directions, BTCPay Server](${SITE}/agent-directions/btcpay.md)

## Guides

The index is [/guides${MARKDOWN_SUFFIX}](${SITE}/guides${MARKDOWN_SUFFIX}).

${guideLines.join("\n")}

## Machine-readable specifications

- [OpenReceive HTTP OpenAPI](${SITE}/openapi.yaml): the normative contract for every mounted route

## Agent resources

- [Using OpenReceive with coding agents](${SITE}/agents.md): skills, install commands, and which artifact answers which question
- [Agent skills](https://github.com/OpenReceive/openreceive/tree/master/skills): integrate-openreceive and debug-openreceive-payment — \`npx skills add OpenReceive/openreceive\`, or Claude Code \`/plugin marketplace add OpenReceive/openreceive\`
- [Contributor rules](https://github.com/OpenReceive/openreceive/blob/master/AGENTS.md): the invariants for changes to OpenReceive itself
- [GitHub repository](https://github.com/OpenReceive/openreceive)
`;

const publicSlugs = new Set(manifest.docs.filter((doc) => doc.public).map((doc) => doc.slug));
const problems = [];
for (const match of content.matchAll(/https:\/\/openreceive\.org(\/[^\s)\]<>"'`]*)?/g)) {
  const raw = (match[1] ?? "/").replace(/[,)]+$/, "");
  const url = raw.endsWith(MARKDOWN_SUFFIX) ? raw : raw.replace(/\.+$/, "");
  const [pathname] = url.split("#");
  if (!isServablePath(pathname, publicSlugs)) problems.push(pathname);
}
if (problems.length > 0) {
  console.error(
    `error: ${TARGET} links to openreceive.org ${[...new Set(problems)].join(", ")}, which the site does not serve.`,
  );
  process.exit(1);
}

const absolute = path.join(root, TARGET);
const current = (() => {
  try {
    return readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
})();

if (check && current !== content) {
  console.error(`error: ${TARGET} is stale. Run \`npm run generate:llms-txt\`.`);
  process.exit(1);
}
if (!check && current !== content) writeFileSync(absolute, content);

console.log(
  `${check ? "Checked" : "Wrote"} ${TARGET}: ${Buffer.byteLength(content, "utf8")} bytes, ${guideLines.length} guides indexed`,
);
