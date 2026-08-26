# Building openreceive.org From This Repo

For whoever maintains the openreceive.org site repository. The site and the
library ship separately, so this file — and the machine-readable
[`docs/site-contract.json`](../site-contract.json) it describes — is the whole
coupling between them. Read the contract; this page explains why each part of it
is there.

## Why there is a contract at all

The agent directions ([`docs/agents/node.md`](../agents/node.md),
[`docs/agents/rails.md`](../agents/rails.md)) are the payload behind the site's
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

The contract is at **v2**. A site that reads it should refuse to publish a
version it does not understand rather than publish part of it — a half-honoured
contract is how a payload ends up linking a page nobody serves.

- **v1** — `publish[]`, `site_owned[]`, `never_publish[]`.
- **v2** — adds `markdown_path` to every `publish[]` entry rendered from a
  source here. This is a version bump rather than an additive field because the
  directions generated alongside it link `markdown_path`, so a site that ignores
  the field serves 404s for its entire reading list.

`release_version` moves with every library release and says nothing about the
shape of this file; `contract_version` moves only when the site has to do
something new.

## On every OpenReceive release

1. Check out this repo at the release tag.
2. Read [`docs/site-contract.json`](../site-contract.json). It is committed, so
   nothing has to be built to read it. Running `npm ci && npm run build:docs`
   additionally produces `dist/docs/` with the same contract plus
   `manifest.json` and `search-index.json` (a prebuilt full-text index, stamped
   with `generated_at`), if the site wants search.
3. Publish every entry in `publish[]`: render `source` (a markdown path in this
   repo) at `path`. `release_version` tells you which library release the set
   belongs to.
4. Serve every `markdown_path` as **raw markdown** — the `source` file's bytes,
   `text/markdown; charset=utf-8`, no chrome. This is not optional and not a
   nicety: it is what the directions link, so a site that publishes only `path`
   ships a reading list that resolves to blank pages.
5. Serve the two `agent-directions-payload` entries as **raw markdown**, and use
   the same bytes behind the copy button.
6. Publish nothing in `never_publish[]`. Those are contributor docs — release
   keys, unreleased internals, forbidden-change lists.
7. Confirm every path in `site_owned[]` still resolves. Those pages are yours,
   not generated from here, and the directions link to them.

## The routes

| Kind | Path | Notes |
| --- | --- | --- |
| `guide` | `/guides/<slug>` | Every public doc. `/guides` itself is the index (`docs/guides/README.md`). |
| `api-docs` | `/api_docs` | Alias of `/guides/api-reference`, kept because the directions and the site have always linked it. |
| `agent-directions` | `/guides/agent-directions-node`, `…-rails` | The payload as a normal page, for people reading it. |
| `agent-directions-payload` | `/agent-directions/node.md`, `/rails.md` | The same bytes as `text/markdown`, for an agent told to fetch one URL. |

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

The agent payloads need no such treatment: every link in them is already
absolute, and already points at a `.md`, which is the point of them.

## The copy button

- Copy the payload **verbatim and whole**. No site chrome, no truncation, no
  "read more". It is engineered to be complete on its own: the stack's
  quickstart is inlined in full, so an agent with no network, a blocked
  github.com, or no fetch tool at all can still finish the integration.
- The payload is size-gated in this repo at 24 KB (~6k tokens) by
  `tools/docs/generate-agent-directions.mjs`, because it has to fit in one
  prompt on a small free model alongside the user's own code. `bytes` in the
  contract is what the button will copy. If a payload ever exceeds the budget,
  CI here fails before it reaches you.
- Put the button on the matching quickstart page, and say what it is: directions
  for a coding agent, including the quickstart itself.

## Recommended: `/llms.txt` and `/llms-full.txt`

The contract has everything needed to generate both — `llms.txt` as a titled
link index over `publish[]`, `llms-full.txt` as the concatenation of the guide
sources. Agents look for these paths by convention, and they cost one build
step. They do not replace the copy button: `llms-full.txt` is the whole corpus,
while the payload is the one-prompt subset with Step 0 in front of it.

In `llms.txt`, link each entry's `markdown_path`, not its `path`. The file
exists to be read by something without a browser, and pointing it at the page
would reintroduce the empty shell one level of indirection later.

## What breaks integrations

Renaming or dropping any of these strands a payload that is already pasted
somewhere:

- a `/guides/<slug>` path in `publish[]`
- **any `markdown_path`** — this is where the directions actually send an agent,
  so it is the one most likely to be quietly missing and the one whose absence
  is hardest to notice from a browser
- the `/api_docs` alias
- any path in `site_owned[]` — today `/contact`,
  `/get_a_nwc_code_to_receive_payments`, `/set_up_swap_provider`, `/guides`, `/`

If one has to change, change it here first: add the slug to the manifest, run
`npm run build:docs`, and let the directions regenerate against the new name.
The generators are `tools/docs/generate-agent-directions.mjs` (payloads, budget,
link check), `tools/docs/generate-site-contract.mjs` (the contract), and
`tools/docs/build-index.mjs` (manifest coverage and search index).
