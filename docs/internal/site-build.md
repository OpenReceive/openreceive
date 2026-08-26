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
4. Serve the two `agent-directions-payload` entries as **raw markdown**, and use
   the same bytes behind the copy button.
5. Publish nothing in `never_publish[]`. Those are contributor docs — release
   keys, unreleased internals, forbidden-change lists.
6. Confirm every path in `site_owned[]` still resolves. Those pages are yours,
   not generated from here, and the directions link to them.

## The routes

| Kind | Path | Notes |
| --- | --- | --- |
| `guide` | `/guides/<slug>` | Every public doc. `/guides` itself is the index (`docs/guides/README.md`). |
| `api-docs` | `/api_docs` | Alias of `/guides/api-reference`, kept because the directions and the site have always linked it. |
| `agent-directions` | `/guides/agent-directions-node`, `…-rails` | The payload as a normal page, for people reading it. |
| `agent-directions-payload` | `/agent-directions/node.md`, `/rails.md` | The same bytes as `text/markdown`, for an agent told to fetch one URL. |

**The renderer must rewrite intra-guide links.** Guides link to each other by
filename — `[Payment storage](storage.md)`, `[errors](api-reference.md#errors)` —
because they are also read in the repository. Map `<slug>.md[#anchor]` to
`/guides/<slug>[#anchor]`. The agent payloads need no such treatment: every link
in them is already absolute, which is the point of them.

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

## What breaks integrations

Renaming or dropping any of these strands a payload that is already pasted
somewhere:

- a `/guides/<slug>` path in `publish[]`
- the `/api_docs` alias
- any path in `site_owned[]` — today `/contact`,
  `/get_a_nwc_code_to_receive_payments`, `/set_up_swap_provider`, `/guides`, `/`

If one has to change, change it here first: add the slug to the manifest, run
`npm run build:docs`, and let the directions regenerate against the new name.
The generators are `tools/docs/generate-agent-directions.mjs` (payloads, budget,
link check), `tools/docs/generate-site-contract.mjs` (the contract), and
`tools/docs/build-index.mjs` (manifest coverage and search index).
