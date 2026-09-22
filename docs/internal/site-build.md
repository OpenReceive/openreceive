# Building openreceive.org From This Repo

This page is for whoever maintains the openreceive.org site repository. The
site and the library ship separately. The only link between them is this file
and the machine-readable [`docs/site-contract.json`](../site-contract.json) it
describes. Read the contract. This page explains why each part of it exists.

## Why there is a contract at all

The agent directions in [`docs/agents/`](../agents/) cover Express, Fastify,
Next.js, Rails, FastAPI, Django, plain PHP, Laravel, BTCPay Server, and WordPress
with WooCommerce. They are the payloads behind the site's
**Copy agent directions** button. People paste them into Cursor, Claude or
Codex. From then on, the URLs inside them are in use in other people's editors,
and we cannot recall them. A link the site stops serving fails badly. A coding
agent cannot tell a 404 from a blocked network, so its next move is to invent
the API it could not read.

So the URLs the directions name are a published interface, not a
documentation nicety. They are generated from `docs/manifest.json`. On this
side, `npm run check:docs` enforces them in CI: it fails if a direction links to
anything the contract does not publish.

That interface is the **raw markdown**, not the rendered page. openreceive.org
renders guides in the browser. So `curl https://openreceive.org/guides/storage`
returns an application shell: a few KB of `<head>` and an empty
`<div id="root">`, with none of the guide in it. The directions have one
reader, a coding agent. To that reader, the shell looks exactly like a blocked
network. That is the failure the contract exists to prevent, only now it
arrives with a 200. So every entry the site renders from a source here carries
a `markdown_path` as well as a `path`, and the directions link the
`markdown_path`.

## `contract_version`

The contract is at **v6**. A site that reads it should refuse to publish a
version it does not understand, rather than publish part of it. A half-honoured
contract is how a payload ends up linking a page nobody serves.

- **v1**: `publish[]`, `site_owned[]`, `never_publish[]`.
- **v2**: adds `markdown_path` to every `publish[]` entry rendered from a
  source here. This is a version bump rather than an additive field because the
  directions generated with it link `markdown_path`. A site that ignores the
  field serves 404s for the entire reading list.
- **v3**: adds `agent_discovery` (below) and the `/agents` page in
  `publish[]`. It retires the `/agents.md → /llms.txt` redirect, because
  `/agents.md` is now the markdown twin of the `/agents` page. The version
  bumps for the same reason as v2. The agent skills and directions generated
  with the contract link `/llms.txt`, `/openapi.yaml`, and `/agents.md`. A site
  that ignored the section would 404 links already in use in other people's
  editors.
- **v4**: adds the `/btcpay` page (`kind: plugin-readme`) and `assets[]`. The
  BTCPay Server home on the site is the plugin's own README, rendered from
  `packages/dotnet/BTCPayServer.Plugins.OpenReceive/README.md`. It has a twin
  at `/btcpay.md`, like a guide. So the page a merchant reads and the README
  the plugin ships are the same bytes. Its screenshots are listed in `assets[]`
  and served verbatim under `/assets/`. The version bumps because a site that
  ignored `assets[]` would render the home page with every image broken.
- **v5**: adds `frameworks[]`. Each row describes one framework landing page
  (`/integrations/<id>`: `express`, `fastify`, `nextjs`, `rails`,
  `btcpay-server`). A row carries everything the page renders:
  - the heading
  - the quickstart page and title
  - the copy-button payload path
  - the install line
  - the version floor
  - the finished-example URL
  - the demo port
  - a `video` slot
  - `shared_checkout_demo`

  This repo generates and gates the table. Every quickstart must be a public
  doc, and every agent stack a payload. Every example must be a directory.
  Every video must be null, an absolute URL, or an `assets[]` entry. So if a
  demo or guide goes missing, this repo's build fails, not the site's. v5 also
  adds two payloads (`/agent-directions/fastify.md`,
  `/agent-directions/next.md`) and their guides. The version bumps because the
  landing template reads the table instead of a hand-kept list. A site on v4
  has no framework pages. A site that half-read v5 could render a page for a
  framework whose payload it does not serve.
- **v6**: `frameworks[]` gains rows outside the Node and Ruby ecosystems: the
  `php` family (`laravel`, `php`) and the `python` family (`django`,
  `fastapi`). It adds the `/agent-directions/{laravel,php,django,fastapi}.md`
  payloads and their quickstarts. The row shape is unchanged, but the `family`
  value is new vocabulary the landing template must render:
  - the install snippet is a `composer require …` or
    `pip install "openreceive[…]"` line instead of `npm install`
  - `adapter_package` names a Composer package or a PyPI extra
  - `requires` states a PHP or Python floor

  A site on v5 would render those rows with an npm install line that installs
  nothing, so the version moves. WordPress + WooCommerce also uses the `php`
  family, with a plugin-upload instruction instead of a Composer command.
  Render `install` verbatim. Never infer an installer from `family` or
  `adapter_package`. The WordPress plugin overview is `/wordpress` (raw twin
  `/wordpress.md`), with its screenshot in `assets[]`. These WordPress rows use
  the existing v6 shape, so they are not a new contract version.

`release_version` changes with every library release and says nothing about the
shape of this file. `contract_version` changes only when the site has to do
something new.

## On every OpenReceive release

1. Select the docs revision for the release. Normally this is the release tag.
   A later docs-only commit may document the same `release_version`. When you
   apply a docs correction, select that explicit commit and record it next to
   the library version. Never move a public release tag to update the site.
2. Read [`docs/site-contract.json`](../site-contract.json). It is committed, so
   you do not need to build anything to read it. Running
   `npm ci && npm run build:docs` also produces
   `dist/openreceive-docs-<release_version>.tar.gz`, a complete import bundle.
   It contains the contract, `public-search-index.json`, `bundle.json`, and
   every public source under `sources/<source>`. That includes markdown, the
   OpenAPI file, screenshots and video. See the bundle layout below. The old
   `dist/docs/manifest.json` and `search-index.json` include contributor
   documents and are local tooling inputs. Do not serve them or use them for
   public search.
3. Publish every entry in `publish[]`: render `source` (a markdown path in this
   repo) at `path`. `release_version` tells you which library release the set
   belongs to.
4. Serve every `markdown_path` as **raw markdown**: the `source` file's bytes,
   `text/markdown; charset=utf-8`, no chrome. This is required. The directions
   link it, so a site that publishes only `path` ships a reading list that
   resolves to blank pages.
5. Serve every `agent-directions-payload` entry as **raw markdown**. Use the
   same bytes behind the copy button.
6. Serve every `agent_discovery.artifacts[]` entry **verbatim**: the named
   `source` file's exact bytes at `path`, with the given `content_type`. Do not
   render it or add chrome. Today there are two:
   - `/llms.txt`, generated here from the manifest. Do not write your own.
   - `/openapi.yaml`, the normative `spec/openapi/openreceive-http.v1.yaml`,
     copied so the two can never drift. Never regenerate or reformat it.
7. Honour `agent_discovery.head_links` on rendered pages. Every page carries
   `<link rel="describedby" href="/llms.txt">`. Every `publish[]` entry with a
   `markdown_path` links it as
   `<link rel="alternate" type="text/markdown" href="…">`. This is the llms.txt
   v2 discovery convention, so a browsing agent finds the markdown without
   guessing.
8. Serve every `assets[]` entry **verbatim**: the named `source` file's bytes
   at `path` with the given `content_type`. The `publish[]` entry that embeds
   an asset (`referenced_by`) refers to it relative to its own source file. For
   example, the plugin README uses
   `../../../docs/assets/btcpayserver/5-click-OR-icon.webp`. So the renderer
   resolves each `<img src>` against the source path and maps anything under
   `docs/assets/` to `/assets/<rest>`. Do this in the page and in the markdown
   twin alike. The generator refuses any image outside `docs/assets/`, so that
   rule covers every case.
9. Publish nothing in `never_publish[]`. Those are contributor docs: release
   keys, unreleased internals, forbidden-change lists.
10. Render one landing page per `frameworks[]` row at `/integrations/<id>`:
    - the hero from `heading`
    - the copy button on `agent_payload_path`
    - the guide link on `quickstart_path`
    - the install line and `requires`
    - the example link on `example_url`

    Hide the video slot while `video` is null. Play an absolute URL, or serve an
    `/assets/` path from `assets[]`. When `shared_checkout_demo` is false (BTCPay
    or WordPress), show the video and screenshots, when available, instead of
    the shared checkout panel. A null video stays hidden. WordPress uses the
    `/wordpress` overview and screenshot. BTCPay uses `/btcpay` and its video.
    Keep every framework row, including FastAPI, Django, PHP, Laravel and
    WooCommerce. Do not maintain a smaller site-side list.
11. Confirm every path in `site_owned[]` still resolves. Most of them are yours.
    The agent-discovery trio (`/llms.txt`, `/openapi.yaml`, `/agents`) is listed
    there as must-exist, but it comes from this repo as described above.

## Import bundle and publication checks

Build from a clean checkout of the selected docs revision:

```sh
npm ci
npm run build:docs
npm run check:docs
```

The archive is an **import input**. It is not a static website to extract over
the web root. Its layout is:

```text
bundle.json                  # bundle_version 1, release, revision, dirty flag, SHA-256 inventory
site-contract.json           # the v6 routes and publishing obligations
public-search-index.json     # public pages, including agents and plugin overviews
sources/docs/...             # exact public guide/payload/discovery/media bytes
sources/packages/...         # the published plugin READMEs
sources/spec/openapi/...     # exact normative OpenAPI bytes
```

Every contract `source` resolves to `sources/<source>`. `bundle.json.files[]`
records each file's relative `path`, byte count and SHA-256. Before importing:
- verify those entries
- require the expected `release_version`
- record `source_revision`

Release builds from Git must have `source_dirty: false`. An exported source tree
has null Git provenance. Use it only when you verify its revision separately.
Do not mix indexes, contract files or images from different bundles.

In the private site repository, point `bin/rails docs:sync` at this selected
checkout, or teach its importer the bundle layout. Then build the site's JS and
deploy through that repository's normal process. The importer interface and
hosting configuration belong to the private site. This repository specifies
the importer's inputs and obligations. It does not prescribe undocumented
command flags.

Before making the new site version live, check the staged site against the
contract:

- Every rendered `publish[].path` and every `markdown_path` returns successfully.
  Raw markdown has `text/markdown`, with no application shell and no login
  redirect.
- Every copy-button payload matches its bundled source byte for byte and fits
  its recorded `bytes`. Copy buttons exist on every matching quickstart and
  `/integrations/<id>` page.
- Discovery artifacts and media match their source bytes and `content_type`.
  Each rendered page has the specified discovery and markdown alternate links.
- Public search includes every page in `public-search-index.json` and no
  contributor documents. Keep `path` and `markdown_path` as the index gives them.
- Framework pages use every `frameworks[]` row, with the supplied install text,
  requirements, example link and payload. Null videos render no empty player.
- Intra-doc links and plugin images resolve after source-path rewriting.
  `site_owned[]` paths and `site_redirects[]` remain available.
- The site footer/docs version matches `release_version`.
- Before presenting an install flow as available, the package versions and
  downloadable artifacts it needs exist: npm, RubyGems, PyPI, Packagist, the
  standalone checkout tarball, and a built WordPress zip when that install path
  is offered. A Composer bootstrap alone does not mean Packagist has discovered
  the release. WordPress.org listing approval is separate from distributing a
  verified plugin archive.

## The routes

| Kind | Path | Notes |
| --- | --- | --- |
| `guide` | `/guides/<slug>` | Every public doc. `/guides` itself is the index (`docs/guides/README.md`). |
| `api-docs` | `/api_docs` | Alias of `/guides/api-reference`. Kept because the directions and the site have always linked it. |
| `agent-directions` | `/guides/agent-directions-<stack>` for every payload stack | The payload as a normal page, for people reading it. |
| `agent-directions-payload` | `/agent-directions/<stack>.md` for every payload stack | The same bytes as `text/markdown`, for an agent told to fetch one URL. |
| framework page | `/integrations/<id>` | `frameworks[]` (contract v5; `php` and `python` families since v6). Not a `publish[]` entry, because the page is the site's own template rendered from the row. The row names which `publish[]` pages it links. |
| `agents-page` | `/agents` | The entry point for coding agents (`docs/site/agents.md`): skills, install commands, which artifact answers which question. Rendered and twinned like a guide. Worth a link in the docs navigation. |
| `plugin-readme` | `/wordpress`, `/btcpay` | Render the plugin README and its markdown twin. WordPress has a screenshot and no video. BTCPay carries a `video` field: play `video.path` inline at the top of the page, with `video.poster` as its poster (both are `assets[]` entries), in place of the README's GitHub-only attachment URL. `/btcpay` is the BTCPay Server home: the plugin README (`packages/dotnet/BTCPayServer.Plugins.OpenReceive/README.md`) rendered and twinned like a guide, with its screenshots from `assets[]`. Link it from the site navigation as the BTCPay entry point. The guides (`/guides/quickstart-btcpay`, `/guides/btcpay-reference`, and the swap guides) are the full documentation behind it. |
| `asset` | `/assets/<path>` | `assets[]`: the verbatim bytes of a file under `docs/assets/` that a `publish[]` entry embeds or links. These are the README's screenshots, its demo video (`video/mp4`) and the poster frame that links to it. Rewrite the link the same way as an image `src`. |
| `llms-index` | `/llms.txt` | `agent_discovery.artifacts[]`: the verbatim bytes of `docs/site/llms.txt`. |
| `openapi` | `/openapi.yaml` | `agent_discovery.artifacts[]`: the verbatim bytes of the normative OpenAPI file. |

Every route above except the payloads also carries a `markdown_path`. The
payloads are already markdown. The `markdown_path` is always the `path` with
`.md` appended:

| `path` | `markdown_path` |
| --- | --- |
| `/guides/storage` | `/guides/storage.md` |
| `/guides` | `/guides.md` |
| `/api_docs` | `/api_docs.md` |

Serve the `source` file at `markdown_path` as `text/markdown; charset=utf-8`,
unrendered. Link rewriting (below) is fine and expected there. It is the same
document, in a form a program can read. Two rules make it worth having: it
never returns HTML, and it never 404s while `path` works.

**The renderer must rewrite intra-guide links.** Guides link to each other by
filename, such as `[Payment storage](storage.md)` or
`[errors](api-reference.md#errors)`, because people also read them in the
repository. On the page, map `<slug>.md[#anchor]` to `/guides/<slug>[#anchor]`.
In the markdown twin, map it to `/guides/<slug>.md[#anchor]` instead. A reader
that followed one link will want to follow the next, and it still has no
browser.

Resolve links by `source` path, not only by filename. A recipe under
`docs/recipes/` and a plugin README under `packages/` have different bases.
Look up the resolved repo path in `publish[]` and `assets[]`, and keep anchors.
Some existing repository files have no public site route: examples, package
source, or contributor material. Link those to GitHub at the selected docs
revision. Never invent a `/guides/` route for them, and never publish
`never_publish[]` content. Use the same rules for ordinary links and images.
Leave external URLs as they are.

The agent payloads need none of this. Every link in them is already absolute
and already points at a `.md`, which is the point of them.

## The copy button

- Copy the payload **verbatim and whole**. No site chrome, no truncation, no
  "read more". The payload is built to be complete on its own. It inlines the
  stack's quickstart in full, so an agent can finish the integration even with
  no network, a blocked github.com, or no fetch tool at all.
- `tools/docs/generate-agent-directions.mjs` limits the payload in this repo
  to 52 KB (~13k tokens, about 1,000 lines). The limit exists because an agent
  has to absorb the payload in one prompt alongside the user's own code.
  `bytes` in the contract is what the button will copy. If a payload ever
  exceeds the budget, CI here fails before it reaches you.
- Put the button on the matching quickstart page and on the framework landing
  page (`frameworks[].agent_payload_path`). Label what it is: directions for a
  coding agent, including the quickstart itself.

## `/llms.txt`, and the recommended `/llms-full.txt`

`/llms.txt` is no longer yours to generate. Since contract v3 it is an
`agent_discovery` artifact: serve the committed `docs/site/llms.txt` byte for
byte. This repo generates it from the manifest
(`tools/docs/generate-llms-txt.mjs`). It links every guide's markdown twin and
is stamped with the release version. A site-side copy could only drift from
the docs set it indexes.

`/llms-full.txt` is still recommended, and the site generates it. It is the
`publish[]` guide sources joined into one file, for agents that want the whole
corpus in one fetch. It does not replace the copy button. The payload is the
subset that fits in one prompt, with Step 0 in front of it.

## What breaks integrations

Renaming or dropping any of these breaks a payload that someone has already
pasted:

- a `/guides/<slug>` path in `publish[]`
- a `frameworks[].id`. The quickstart pages and the homepage grid link the
  site's `/integrations/<id>` URL.
- **any `markdown_path`**. This is where the directions actually send an agent.
  So it is the path most likely to go quietly missing, and its absence is the
  hardest to notice from a browser.
- the `/api_docs` alias
- the `/btcpay` page and its `/btcpay.md` twin, and any `/assets/` path the
  README embeds. People also read the README on GitHub, so the site is not its
  only reader. But BTCPay's plugin directory links the page as the plugin's
  documentation.
- any path in `site_owned[]`. Today those are `/contact`,
  `/get_a_nwc_code_to_receive_payments`, `/set_up_swap_provider`, `/guides`,
  `/`, and the agent-discovery trio `/llms.txt`, `/openapi.yaml`, `/agents`.
  The shipped agent skills link all three of the trio. Skills travel inside
  published npm packages and gems, so they cannot be recalled at all.

If one has to change, change it here first. Add the slug to the manifest, run
`npm run build:docs`, and let the directions regenerate against the new name.
The generators are:
- `tools/docs/generate-agent-directions.mjs`: payloads, budget, link check
- `tools/docs/generate-site-contract.mjs`: the contract
- `tools/docs/build-index.mjs`: manifest coverage and search index
