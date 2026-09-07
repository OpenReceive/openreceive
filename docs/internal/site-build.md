# Building openreceive.org From This Repo

For whoever maintains the openreceive.org site repository. The site and the
library ship separately, so this file — and the machine-readable
[`docs/site-contract.json`](../site-contract.json) it describes — is the whole
coupling between them. Read the contract; this page explains why each part of it
is there.

## Why there is a contract at all

The agent directions in [`docs/agents/`](../agents/) cover Express, Fastify,
Next.js, Rails, FastAPI, Django, plain PHP, Laravel, BTCPay Server, and WordPress
with WooCommerce. They are the payloads behind the site's
**Copy agent directions** button. Someone pastes them into Cursor, Claude or
Codex, and from that moment the URLs inside them are running in other people's
editors and cannot be recalled. A link the site stops serving does not degrade
gracefully: a coding agent cannot tell a 404 from a blocked network, and its
next move is to invent the API it could not read.

So the URLs the directions name are not a documentation nicety. They are a
published interface, generated from `docs/manifest.json` and enforced in CI on
this side by `npm run check:docs`, which fails if a direction links to anything
the contract does not publish.

That interface is the **raw markdown**, not the page. openreceive.org renders
guides in the browser, so `curl https://openreceive.org/guides/storage` returns
an application shell — a few KB of `<head>` and an empty `<div id="root">`, with
none of the guide in it. To the one reader the directions have, that is
indistinguishable from a blocked network, which is the exact failure the
contract exists to prevent, arriving with a 200. So every entry the site renders
from a source here carries a `markdown_path` as well as a `path`, and the
directions link the former.

## `contract_version`

The contract is at **v6**. A site that reads it should refuse to publish a
version it does not understand rather than publish part of it — a half-honoured
contract is how a payload ends up linking a page nobody serves.

- **v1** — `publish[]`, `site_owned[]`, `never_publish[]`.
- **v2** — adds `markdown_path` to every `publish[]` entry rendered from a
  source here. This is a version bump rather than an additive field because the
  directions generated alongside it link `markdown_path`, so a site that ignores
  the field serves 404s for its entire reading list.
- **v3** — adds `agent_discovery` (below) and the `/agents` page in
  `publish[]`, and retires the `/agents.md → /llms.txt` redirect (`/agents.md`
  is now the markdown twin of the `/agents` page). A version bump for the same
  reason as v2: the agent skills and directions generated alongside the
  contract link `/llms.txt`, `/openapi.yaml`, and `/agents.md`, so a site that
  ignored the section would 404 links already running in other people's
  editors.
- **v4** — adds the `/btcpay` page (`kind: plugin-readme`) and `assets[]`. The
  BTCPay Server home on the site is the plugin's own README, rendered from
  `packages/dotnet/BTCPayServer.Plugins.OpenReceive/README.md` and twinned at
  `/btcpay.md` like a guide, so the page a merchant reads and the README the
  plugin ships are the same bytes. Its screenshots are listed in `assets[]`
  and served verbatim under `/assets/`. A version bump because a site that
  ignored `assets[]` would render the home page with every image broken.
- **v5** — adds `frameworks[]`: one row per framework landing page
  (`/integrations/<id>` — `express`, `fastify`, `nextjs`, `rails`,
  `btcpay-server`), carrying everything the page renders: the heading, the
  quickstart page and title, the copy-button payload path, the install line,
  the version floor, the finished-example URL, the demo port, a `video` slot
  and `shared_checkout_demo`. The table is generated and gated here — every
  quickstart is a public doc, every agent stack a payload, every example a
  directory, every video null, an absolute URL or an `assets[]` entry — so a
  demo or guide that goes missing fails this repo's build rather than the
  site's. Alongside it: two new payloads (`/agent-directions/fastify.md`,
  `/agent-directions/next.md`) and their guides. A version bump because the
  landing template reads the table instead of a hand-kept list: a site on v4
  has no framework pages, and one that half-read v5 could render a page for a
  framework whose payload it does not serve.
- **v6** — `frameworks[]` gains rows outside the Node and Ruby ecosystems:
  the `php` family (`laravel`, `php`) and the `python` family (`django`,
  `fastapi`), with `/agent-directions/{laravel,php,django,fastapi}.md` payloads
  and their quickstarts. The row shape is unchanged, but the `family` value is
  new vocabulary the landing template must render: the install snippet is a
  `composer require …` or `pip install "openreceive[…]"` line instead of `npm
  install`, `adapter_package` names a Composer package or a PyPI extra, and
  `requires` states a PHP or Python floor. A site on v5 would render those rows
  with an npm install line that installs nothing, so the version moves.
  WordPress + WooCommerce also uses the `php` family, with a plugin-upload
  instruction instead of a Composer command. Render `install` verbatim; never
  infer an installer from `family` or `adapter_package`. Its plugin overview
  is `/wordpress` (raw twin `/wordpress.md`), with its screenshot in `assets[]`.
  This adds rows using the existing v6 shape, not a new contract version.

`release_version` moves with every library release and says nothing about the
shape of this file; `contract_version` moves only when the site has to do
something new.

## On every OpenReceive release

1. Select the docs revision for the release. Normally this is the release tag.
   A later docs-only commit may document the same `release_version`; select that
   explicit commit when applying a docs correction, and record it alongside the
   library version. Never move a public release tag to update the site.
2. Read [`docs/site-contract.json`](../site-contract.json). It is committed, so
   nothing has to be built to read it. Running `npm ci && npm run build:docs`
   additionally produces `dist/openreceive-docs-<release_version>.tar.gz`, a
   complete import bundle. It contains the contract, `public-search-index.json`,
   `bundle.json` and every public source under `sources/<source>`, including
   markdown, the OpenAPI file, screenshots and video. See the bundle layout
   below. The old `dist/docs/manifest.json` and `search-index.json` include
   contributor documents and are local tooling inputs; do not serve them or use
   them for public search.
3. Publish every entry in `publish[]`: render `source` (a markdown path in this
   repo) at `path`. `release_version` tells you which library release the set
   belongs to.
4. Serve every `markdown_path` as **raw markdown** — the `source` file's bytes,
   `text/markdown; charset=utf-8`, no chrome. This is not optional and not a
   nicety: it is what the directions link, so a site that publishes only `path`
   ships a reading list that resolves to blank pages.
5. Serve every `agent-directions-payload` entry as **raw markdown**, and use
   the same bytes behind the copy button.
6. Serve every `agent_discovery.artifacts[]` entry **verbatim**: the named
   `source` file's exact bytes at `path`, with the given `content_type`, no
   rendering and no chrome. Today that is `/llms.txt` (generated here from the
   manifest — do not write your own) and `/openapi.yaml` (the normative
   `spec/openapi/openreceive-http.v1.yaml`, copied so the two can never
   drift — never regenerate or reformat it).
7. Honour `agent_discovery.head_links` on rendered pages: every page carries
   `<link rel="describedby" href="/llms.txt">`, and every `publish[]` entry
   with a `markdown_path` links it as
   `<link rel="alternate" type="text/markdown" href="…">` — the llms.txt v2
   discovery convention, so a browsing agent finds the markdown without
   guessing.
8. Serve every `assets[]` entry **verbatim**: the named `source` file's bytes
   at `path` with the given `content_type`. The `publish[]` entry that embeds
   them (`referenced_by`) references them relative to its own source file —
   `../../../docs/assets/btcpayserver/1-click-OR-icon.webp` from the plugin
   README — so the renderer resolves each `<img src>` against the source path
   and maps anything under `docs/assets/` to `/assets/<rest>`, in the page and
   in the markdown twin alike. The generator refuses an image outside
   `docs/assets/`, so that rule is complete.
9. Publish nothing in `never_publish[]`. Those are contributor docs — release
   keys, unreleased internals, forbidden-change lists.
10. Render one landing page per `frameworks[]` row at `/integrations/<id>`:
   the hero from `heading`, the copy button on `agent_payload_path`, the
   guide link on `quickstart_path`, the install line and `requires`, the
   example link on `example_url`. Hide the video slot while `video` is null;
   play an absolute URL or serve an `/assets/` path from `assets[]`. When
   `shared_checkout_demo` is false (BTCPay or WordPress), show the video and screenshots
   instead of the shared checkout panel when available. A null video stays
   hidden. WordPress uses the `/wordpress` overview and screenshot; BTCPay uses
   `/btcpay` and its video. Keep every framework row, including FastAPI,
   Django, PHP, Laravel and WooCommerce; do not maintain a smaller site-side list.
11. Confirm every path in `site_owned[]` still resolves. Most are yours; the
   agent-discovery trio (`/llms.txt`, `/openapi.yaml`, `/agents`) is listed
   there as must-exist but sourced from this repo as described above.

## Import bundle and publication checks

Build from a clean checkout of the selected docs revision:

```sh
npm ci
npm run build:docs
npm run check:docs
```

The archive is an **import input**, not a static website to extract over the
web root. Its layout is:

```text
bundle.json                  # bundle_version 1, release, revision, dirty flag, SHA-256 inventory
site-contract.json           # the v6 routes and publishing obligations
public-search-index.json     # public pages, including agents and plugin overviews
sources/docs/...             # exact public guide/payload/discovery/media bytes
sources/packages/...         # the published plugin READMEs
sources/spec/openapi/...     # exact normative OpenAPI bytes
```

Every contract `source` resolves to `sources/<source>`. `bundle.json.files[]`
records each file's relative `path`, byte count and SHA-256. Verify these before
importing, require the expected `release_version`, and record `source_revision`.
Release builds from Git must have `source_dirty: false`. An exported source tree
has null Git provenance; use it only when its revision is verified separately.
Do not mix indexes, contract files or images from different bundles.

In the private site repository, point `bin/rails docs:sync` at this selected
checkout or teach its importer the bundle layout, then build the site's JS and
deploy through that repository's normal process. The importer interface and
hosting configuration belong to the private site; this repository specifies
its inputs and obligations without prescribing undocumented command flags.

Before making the new site version live, verify the staged site against the
contract:

- Every rendered `publish[].path` and every `markdown_path` returns successfully;
  raw markdown has `text/markdown` and no application shell or login redirect.
- Every copy-button payload matches its bundled source byte for byte and fits
  its recorded `bytes`; copy buttons exist on all matching quickstart and
  `/integrations/<id>` pages.
- Discovery artifacts and media match their source bytes and `content_type`.
  Each rendered page has the specified discovery and markdown alternate links.
- Public search includes every page in `public-search-index.json` and no
  contributor documents. Preserve `path` and `markdown_path` from the index.
- Framework pages use every `frameworks[]` row and the supplied install text,
  requirements, example link and payload. Null videos render no empty player.
- Intra-doc links and plugin images resolve after source-path rewriting;
  `site_owned[]` paths and `site_redirects[]` remain available.
- The site footer/docs version matches `release_version`. Required package
  versions and downloadable artifacts exist before presenting install flows
  as available: npm, RubyGems, PyPI, Packagist, the standalone checkout tarball,
  and a built WordPress zip when that installation path is offered. A Composer
  bootstrap alone is not registry discovery, and WordPress.org listing approval
  is separate from distributing a verified plugin archive.

## The routes

| Kind | Path | Notes |
| --- | --- | --- |
| `guide` | `/guides/<slug>` | Every public doc. `/guides` itself is the index (`docs/guides/README.md`). |
| `api-docs` | `/api_docs` | Alias of `/guides/api-reference`, kept because the directions and the site have always linked it. |
| `agent-directions` | `/guides/agent-directions-<stack>` for every payload stack | The payload as a normal page, for people reading it. |
| `agent-directions-payload` | `/agent-directions/<stack>.md` for every payload stack | The same bytes as `text/markdown`, for an agent told to fetch one URL. |
| framework page | `/integrations/<id>` | `frameworks[]` (contract v5; `php` and `python` families since v6) — not a `publish[]` entry, because the page is the site's own template rendered from the row; the row names which `publish[]` pages it links. |
| `agents-page` | `/agents` | The coding-agents entrypoint (`docs/site/agents.md`): skills, install commands, which artifact answers which question. Rendered and twinned like a guide. Worth a link in the docs navigation. |
| `plugin-readme` | `/wordpress`, `/btcpay` | Render the plugin README and its markdown twin. WordPress has a screenshot and no video; BTCPay carries a `video` field: play `video.path` inline at the top of the page with `video.poster` as its poster (both are `assets[]` entries), in place of the README's GitHub-only attachment URL. The BTCPay Server home: the plugin README (`packages/dotnet/BTCPayServer.Plugins.OpenReceive/README.md`) rendered and twinned like a guide, its screenshots from `assets[]`. Link it from the site navigation as the BTCPay entrypoint; the guides (`/guides/quickstart-btcpay`, `/guides/btcpay-reference`, and the swap guides) are the full documentation behind it. |
| `asset` | `/assets/<path>` | `assets[]` — verbatim bytes of a file under `docs/assets/`, embedded or linked by a `publish[]` entry: the README's screenshots, its demo video (`video/mp4`) and the poster frame that links to it. Rewrite the link the same way as an image `src`. |
| `llms-index` | `/llms.txt` | `agent_discovery.artifacts[]` — verbatim bytes of `docs/site/llms.txt`. |
| `openapi` | `/openapi.yaml` | `agent_discovery.artifacts[]` — verbatim bytes of the normative OpenAPI file. |

Every one of those except the payloads — which are already markdown — also
carries a `markdown_path`, which is always the `path` with `.md` appended:

| `path` | `markdown_path` |
| --- | --- |
| `/guides/storage` | `/guides/storage.md` |
| `/guides` | `/guides.md` |
| `/api_docs` | `/api_docs.md` |

Serve the `source` file at `markdown_path` as `text/markdown; charset=utf-8`,
unrendered. Link rewriting (below) is fine and expected there — it is the same
document, in the form a program can read. The two obligations that make it worth
having are that it never returns HTML and that it never 404s while `path` works.

**The renderer must rewrite intra-guide links.** Guides link to each other by
filename — `[Payment storage](storage.md)`, `[errors](api-reference.md#errors)` —
because they are also read in the repository. Map `<slug>.md[#anchor]` to
`/guides/<slug>[#anchor]` for the page. In the markdown twin, map it to
`/guides/<slug>.md[#anchor]` instead: whatever followed one link will want to
follow the next one, and it still has no browser.

Resolve links by `source` path, not only by filename: a recipe under
`docs/recipes/` and a plugin README under `packages/` have different bases.
Look up the resolved repo path in `publish[]` and `assets[]`; preserve anchors.
For existing repository files without a public site route (examples, package
source or contributor material), link to GitHub at the selected docs revision.
Never invent a `/guides/` route for them or publish `never_publish[]` content.
Use the same rules for ordinary links and images; preserve external URLs.

The agent payloads need no such treatment: every link in them is already
absolute, and already points at a `.md`, which is the point of them.

## The copy button

- Copy the payload **verbatim and whole**. No site chrome, no truncation, no
  "read more". It is engineered to be complete on its own: the stack's
  quickstart is inlined in full, so an agent with no network, a blocked
  github.com, or no fetch tool at all can still finish the integration.
- The payload is size-gated in this repo at 52 KB (~13k tokens, about 1,000
  lines) by `tools/docs/generate-agent-directions.mjs`, because it has to be
  absorbed in one prompt alongside the user's own code. `bytes` in the contract
  is what the button will copy. If a payload ever exceeds the budget, CI here
  fails before it reaches you.
- Put the button on the matching quickstart page and on the framework landing
  page (`frameworks[].agent_payload_path`), and say what it is: directions for
  a coding agent, including the quickstart itself.

## `/llms.txt`, and the recommended `/llms-full.txt`

`/llms.txt` is no longer yours to generate: since contract v3 it is an
`agent_discovery` artifact — serve the committed `docs/site/llms.txt` byte for
byte. It is generated here from the manifest
(`tools/docs/generate-llms-txt.mjs`), links every guide's markdown twin, and is
stamped with the release version, so a site-side copy could only drift from
the docs set it indexes.

`/llms-full.txt` remains recommended and site-generated: the concatenation of
the `publish[]` guide sources, for agents that want the whole corpus in one
fetch. It does not replace the copy button — the payload is the one-prompt
subset with Step 0 in front of it.

## What breaks integrations

Renaming or dropping any of these strands a payload that is already pasted
somewhere:

- a `/guides/<slug>` path in `publish[]`
- a `frameworks[].id` — the site's `/integrations/<id>` URL is what the
  quickstart pages and the homepage grid link
- **any `markdown_path`** — this is where the directions actually send an agent,
  so it is the one most likely to be quietly missing and the one whose absence
  is hardest to notice from a browser
- the `/api_docs` alias
- the `/btcpay` page and its `/btcpay.md` twin, and any `/assets/` path the
  README embeds (the README is also read on GitHub, so the site is not its
  only reader — but the page is what BTCPay's plugin directory links as the
  plugin's documentation)
- any path in `site_owned[]` — today `/contact`,
  `/get_a_nwc_code_to_receive_payments`, `/set_up_swap_provider`, `/guides`,
  `/`, and the agent-discovery trio `/llms.txt`, `/openapi.yaml`, `/agents`
  (the shipped agent skills link all three, and skills travel inside published
  npm packages and gems — they cannot be recalled at all)

If one has to change, change it here first: add the slug to the manifest, run
`npm run build:docs`, and let the directions regenerate against the new name.
The generators are `tools/docs/generate-agent-directions.mjs` (payloads, budget,
link check), `tools/docs/generate-site-contract.mjs` (the contract), and
`tools/docs/build-index.mjs` (manifest coverage and search index).
