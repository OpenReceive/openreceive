# OpenReceive DX & Docs Cleanup — Implementation Brief

**Audience:** a coding agent working directly in the `OpenReceive/openreceive` repo.
**Goal:** make OpenReceive trivial to adopt and trivial to onboard an AI agent onto. The end developer is thinking _"I use X on the backend and Y on the frontend — give me code I can copy, paste, and run."_ Everything that doesn't serve that thought either gets cut, rewritten as an explicit do-this-then-that instruction, or moved out of the end-developer path into a contributor-only area.
**Constraint:** there are no production users. Break things freely. No deprecation aliases, no "old version still works" notes. Delete, don't preserve.

---

## 0. Read this first — current ground truth

There is already a large brief in the repo, `zz-simplify.md`, that planned an API-surface re-architecture (collapse status fields, one auth vocabulary, tier the browser package, rename long exports to short ones). **Most of that is already implemented.** Do not redo it. Specifically, these are already true in the code today:

- `packages/js/browser/src/index.ts` is a 28-line app-facing surface that re-exports short names (`createInvoice`, `status`, `openWallet`, `copyInvoice`, `qrSvg`, `lightningUri`, `createCheckoutController`) from `internal.ts`. The 200+ internal exports live in `packages/js/browser/src/internal.ts` behind `@openreceive/browser/internal`. ✅
- `@openreceive/node` exports only `createOpenReceive` (plus types and store helpers). The redundant free functions (`mountOpenReceiveExpress`, `createOpenReceiveFetchHandler`, `dispatchOpenReceiveNextRoute`, etc.) are no longer on the public surface. ✅
- `createOpenReceive(...)` returns an object with `mountExpress` / `handleFetch` / `handleNode` / `runtime` / `close`. ✅
- `@openreceive/react` exports the short names the API reference promises (`Checkout`, `useCheckout`, `CheckoutProvider`, `ThemeScope`, `QRCode`, `CopyInvoiceButton`, `OpenWalletButton`, `InvoiceSummary`). ✅
- The CLI `worker` / `listen` commands are already intentional "this was removed, use `poll --once`" stubs — that's good, leave them.

**So this brief is NOT another API rewrite.** It is three things: (1) split end-developer docs from contributor/spec docs, (2) make the specific confusing passages explicit and copy-pasteable, (3) fix a handful of genuine code/docs inconsistencies that will trip up the first real users and any agent.

**One place this brief overrides `zz-simplify.md`:** that brief said to _update_ `docs/sdk-status.md` for renames. This brief says **delete it** (see §3). The user wants code to be the single source of truth and does not want hand-maintained status tables that rot. After completing this brief, delete `zz-simplify.md` too (it's a finished working note; `docs/architecture.md` is the durable home for rationale).

Verify the "already done" claims before trusting them:

```sh
wc -l packages/js/browser/src/index.ts          # expect ~28
grep -c '^export' packages/js/node/src/index.ts # createOpenReceive + types only
cat packages/js/next/src/index.ts               # see §4.3 — currently `export {};`
```

---

## 1. The biggest DX problem: end-developer docs and contributor docs are mixed together

`docs/` is a single flat folder of ~33 markdown files. `docs/manifest.json` indexes 23 of them; ~10 (the contributor ones like `forbidden-without-approval.md`, `package-ownership.md`, `test-command-map.md`, `v0.1-scope-lock.md`, and `adr/*`) aren't indexed at all. The manifest `category` field mixes audiences — e.g. `category: "reference"` contains both `api-reference.md` (an end developer needs this) and `release-process.md` (only a maintainer needs this). The manifest `public` flag is applied inconsistently — `architecture.md` is `public: false` but `07-nwc-client-strategy.md`, which is equally internal/spec, is `public: true`.

Net effect: a developer (or an agent) browsing `docs/` cannot tell "what do I read to ship" from "what does an OpenReceive maintainer read." This is the single thing to fix first because it makes everything else legible.

### Task 1.1 — Create two physical doc trees

Restructure into:

```
docs/
  guides/          <- everything an APP DEVELOPER reads to integrate OpenReceive
  internal/        <- everything a CONTRIBUTOR to OpenReceive reads
    adr/
  recipes/         <- keep
```

Then move every file per the table in §1.2. Physical folders (not just a metadata flag) are the right call here because the separation has to survive someone reading the repo on GitHub with no doc site.

### Task 1.2 — Move/merge/delete map (apply exactly)

| Current file                                                                | Action                                                                                                                                 | New location / note                                                                                                                                                                            |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `00-what-is-openreceive.md`                                                 | move + rewrite (§2.2)                                                                                                                  | `guides/what-is.md`                                                                                                                                                                            |
| `01-quickstart-node.md`                                                     | move + rewrite (§2.1, §2.3, §4.1)                                                                                                      | `guides/quickstart-node.md`                                                                                                                                                                    |
| `05-frontend-checkout.md`                                                   | move + rewrite (§2.4–2.6)                                                                                                              | `guides/frontend-checkout.md`                                                                                                                                                                  |
| `06-mobile-apps.md`                                                         | move                                                                                                                                   | `guides/mobile-apps.md`                                                                                                                                                                        |
| `08-price-feeds.md`                                                         | move                                                                                                                                   | `guides/price-feeds.md`                                                                                                                                                                        |
| `09-provider-registry.md`                                                   | move, trim internal rationale into `internal/architecture.md`                                                                          | `guides/provider-registry.md`                                                                                                                                                                  |
| `10-security.md`                                                            | move                                                                                                                                   | `guides/security.md`                                                                                                                                                                           |
| `14-secret-management.md`                                                   | move                                                                                                                                   | `guides/secret-management.md`                                                                                                                                                                  |
| `15-framework-auth.md`                                                      | move + rewrite (§4.1 — document `merchantScope`)                                                                                       | `guides/authorization.md`                                                                                                                                                                      |
| `16-supported-databases.md` + `18-storage-and-namespaces.md`                | **merge** (they overlap heavily — both say "OpenReceive owns invoice storage; your app keeps orders/carts")                            | `guides/storage.md`                                                                                                                                                                            |
| `17-background-workers.md`                                                  | move + rewrite (§2.2 negatives, §2.7 step-by-step deploy)                                                                              | `guides/deployment-and-recovery.md`                                                                                                                                                            |
| `api-reference.md`                                                          | move                                                                                                                                   | `guides/api-reference.md`                                                                                                                                                                      |
| `02-quickstart-rails.md`, `03-quickstart-python.md`, `04-quickstart-php.md` | **rename — these are NOT quickstarts** (titles literally say "…Quickstart Status"; bodies are "coming soon")                           | `guides/language-support.md` (one combined "status of other languages" page) OR `internal/` if you'd rather hide them. Do not leave them in the quickstart category pretending to be runnable. |
| `architecture.md`                                                           | move; becomes the single home for "why we built it this way"                                                                           | `internal/architecture.md`                                                                                                                                                                     |
| `07-nwc-client-strategy.md`                                                 | **merge into** `internal/architecture.md` then delete (it's pure strategy/spec: "The first JavaScript path will wrap getAlby/js-sdk…") | —                                                                                                                                                                                              |
| `11-conformance.md`                                                         | move                                                                                                                                   | `internal/conformance.md`                                                                                                                                                                      |
| `12-release-process.md`                                                     | move                                                                                                                                   | `internal/release-process.md`                                                                                                                                                                  |
| `13-demo-deployment.md`                                                     | move                                                                                                                                   | `internal/demo-deployment.md`                                                                                                                                                                  |
| `forbidden-without-approval.md`                                             | move                                                                                                                                   | `internal/forbidden-without-approval.md`                                                                                                                                                       |
| `package-ownership.md`                                                      | move                                                                                                                                   | `internal/package-ownership.md`                                                                                                                                                                |
| `test-command-map.md`                                                       | move (or fold into `CONTRIBUTING.md`)                                                                                                  | `internal/test-command-map.md`                                                                                                                                                                 |
| `v0.1-scope-lock.md`                                                        | move                                                                                                                                   | `internal/scope-lock.md`                                                                                                                                                                       |
| `adr/*`                                                                     | move                                                                                                                                   | `internal/adr/*`                                                                                                                                                                               |
| `sdk-status.md`                                                             | **DELETE** (see §3)                                                                                                                    | —                                                                                                                                                                                              |
| `recipes/react-material-ui.md`                                              | keep                                                                                                                                   | `recipes/`                                                                                                                                                                                     |

### Task 1.3 — Make the split machine- and human-visible

1. Add `docs/guides/README.md` — a short index that is _the_ developer entry point: one line per guide, ordered as a reading path (what-is → quickstart-node → frontend-checkout → authorization → storage → deployment-and-recovery → api-reference → security/secret-management). No contributor docs linked here.
2. Add `docs/internal/README.md` — index for contributors.
3. In `docs/manifest.json`, add an explicit `"audience": "developer" | "contributor"` field to every entry, fix the `public` flags so they're consistent with audience, and update every `source_path` to the new location. Remove the `sdk-status` entry. Add entries for the previously-unindexed `internal/*` docs (or have the build script glob `internal/` and tag them `contributor` automatically).
4. Update `tools/docs/build-index.mjs` to understand the two trees (it currently validates against `manifest.json`; make sure it still passes and that `npm run build:docs` is green).
5. **Before renaming, find every reference to the old paths so nothing dangles:**

```sh
grep -rn "docs/0[0-9]\|docs/1[0-8]\|docs/sdk-status\|docs/architecture\|07-nwc\|sdk-status" \
  README.md AGENTS.md CONTRIBUTING.md docs/ examples/ tools/ packages/
```

Known referencers to update: `README.md` (its "## Docs" section names `docs/01-quickstart-node.md`, `docs/17-background-workers.md`, `docs/sdk-status.md`, etc.), and `examples/hello-fruit/server/*/src/server/create-server.ts` (carries `docsPath: "docs/01-quickstart-node.md"`).

**Done when:** `docs/guides/` contains only developer-facing docs, `docs/internal/` contains only contributor docs, `npm run build:docs` passes, and no file references a moved/deleted path.

---

## 2. Rewrite the specific confusing passages (these are the ones flagged)

For each: the rule is **imperative and copy-pasteable**. State the runtime ("you're on Express", "you're on a Fetch-style framework"), then give the block to paste, then one sentence on what it does. Cut anything that describes what OpenReceive _doesn't_ do unless a reader would actively make a mistake without it.

### Task 2.1 — Kill the redundant GET/POST "Fetch-style handlers" block

In `docs/01-quickstart-node.md`, the `## Other Frameworks` section currently shows a bare:

```ts
export const GET = ({ request }) => openreceive.handleFetch(request);
export const POST = ({ request }) => openreceive.handleFetch(request);
```

…immediately followed by the Next.js App Router example that _also_ calls `handleFetch`. Two near-identical blocks teach nothing. **Replace the whole section** with one block per actual target framework, each labeled by the framework the developer is actually using:

- **Express** → `openreceive.mountExpress(app)` (already shown above in the quickstart; cross-link, don't repeat).
- **Next.js (App Router)** → keep exactly one block (the catch-all route calling `handleFetch`).
- **Raw Node / Fastify** → `await openreceive.handleNode(req, res)`.

Delete the standalone "Fetch-style handlers" snippet. If you want to mention that any Web-`Request` framework works, say it in one prose sentence: "Any framework whose route receives a Web `Request` and returns a `Response` can call `openreceive.handleFetch(request)` directly." No code block needed for the generic case.

### Task 2.2 — Remove the gratuitous negative statements

Two openers describe absence for no reason:

- `docs/00-what-is-openreceive.md`, "## Runtime Model": _"There is no notification listener, webhook bridge, SSE bus, or in-memory coordination state."_
- `docs/17-background-workers.md`, line 1 of body: _"OpenReceive does not require a worker, wallet notification listener, webhook bridge, or in-memory event bus."_

Rewrite as a positive statement of the model. Example replacement for both:

> OpenReceive runs inside your normal web process. Mount `/openreceive/v1`, and the browser checkout polls a backend lookup route to learn when an invoice settles. For extra recovery, you can optionally call `POST /openreceive/v1/poll` (or `openreceive poll --once`) on a schedule. The OpenReceive store is the only thing coordinating across processes.

That conveys the same architecture (no daemon needed) without a list of technologies the reader was never going to reach for. Keep one short factual line in `internal/architecture.md` about _why_ there's no event bus, for contributors.

### Task 2.3 — Fix "For primitive composition:"

`docs/05-frontend-checkout.md:61` introduces a code block with the bare phrase **"For primitive composition:"**. A developer doesn't know what "primitive composition" means. Replace the lead-in with what they'd actually be trying to do:

> **To build your own checkout layout from the individual pieces** (QR code, invoice summary, copy button, open-wallet button) instead of using the default `<Checkout>`:

…then the existing `useCheckout` + `<QRCode>` / `<CopyInvoiceButton>` / etc. example. Same fix applies anywhere "primitive" is used as a noun for the small components — call them "the individual checkout components."

### Task 2.4 — Fix the `openWallet` line

`docs/05-frontend-checkout.md:16` reads: ``- `openWallet({ invoice })` opens a `lightning:` URI.`` — terse, and it states a side effect without telling the developer when/why they'd call it. Rewrite in the bullet list to say what it does _for the user and the developer_:

> - `openWallet({ invoice })` — call this from your own "Open in wallet" button's click handler to launch the visitor's installed Lightning wallet app with this invoice prefilled.

The point is the developer should immediately know "this is the thing I wire to my button," not have to infer it from "opens a `lightning:` URI."

### Task 2.5 — Remove "## Internal Subpath" from the frontend guide

`docs/05-frontend-checkout.md:195-201` ("## Internal Subpath") explains `@openreceive/browser/internal` to app developers. App developers must never touch that subpath, so this section only adds doubt ("wait, should I be importing from internal?"). **Delete the section from the guide.** If it needs to exist at all, one sentence belongs in `internal/architecture.md` under an "adapter authors" heading. The api-reference can keep a single trailing line: "Framework-adapter internals live under `@openreceive/browser/internal` and are not part of the supported app surface." — but that's the most it should ever get in developer-facing docs.

### Task 2.6 — Stop spec from leaking into developer docs

Beyond §2.5, sweep the developer guides for spec/strategy/rationale prose and move it to `internal/architecture.md`. Tell-tale signs to grep for and relocate: future-tense planning ("the first … path will…", "future SDKs must…"), package-boundary justifications, "why we built it" passages, conformance/vector requirements, and capability-checklist language. Primary offenders: `07-nwc-client-strategy.md` (move whole file, §1.2), the package-ownership rationale inside `09-provider-registry.md`, and any "every NWC client needs: URI parsing, capability preflight, NIP-04…" lists. A developer guide answers "how do I do X," never "here is our internal contract for building SDK Y."

### Task 2.7 — Make the host-deploy instructions explicit ("do this, then this")

`docs/17-background-workers.md` (→ `guides/deployment-and-recovery.md`) has Vercel/Cloudflare guidance as vague bullets ("Use Postgres or another durable store for production", "Use a Node-compatible runtime"). Convert each host into a numbered, copy-pasteable sequence. Target shape per host:

**Vercel**

1. Put the catch-all route at `app/openreceive/v1/[...openreceive]/route.ts` calling `openreceive.handleFetch(request)` (link the Next.js quickstart block).
2. Set `OPENRECEIVE_NWC` and `OPENRECEIVE_STORE=postgres://…` in Project → Settings → Environment Variables.
3. (Optional recovery) Add a Vercel Cron entry hitting `POST /openreceive/v1/poll` with the `OPENRECEIVE_CRON_SECRET` header. Paste the exact `vercel.json` cron snippet.

**Cloudflare**

1. Use the Node-compat runtime for the OpenReceive route (show the exact `compatibility_flags`/`nodejs_compat` line in `wrangler.toml`).
2. Set `OPENRECEIVE_STORE` to a Postgres URL. **Do not use Workers KV as the invoice store** (keep this one negative — it prevents a real mistake).
3. (Optional recovery) Add a Cron Trigger calling `POST /openreceive/v1/poll`; paste the snippet.

Same treatment for any other host mentioned. The test: a developer can follow the steps top to bottom without making a single judgment call.

---

## 3. Delete docs that will rot (code is the source of truth)

### Task 3.1 — Delete `docs/sdk-status.md`

It's a hand-maintained table of "which package is implemented / initial / quarantined." It will be wrong within weeks and it duplicates information that lives in `package.json` versions and the test suite. **Delete the file and its `manifest.json` entry.** Remove the README "## Docs" bullet that points to it.

If a status surface is genuinely wanted later, generate it — e.g. a tiny script that reads each `packages/js/*/package.json` + whether the package's tests exist/pass and emits a table in CI — rather than a doc humans edit by hand. Don't build that now; just remove the rot.

### Task 3.2 — Move release/process docs out of the developer path

`12-release-process.md`, `test-command-map.md`, `package-ownership.md`, `v0.1-scope-lock.md`, `forbidden-without-approval.md`, and `11-conformance.md` are maintainer docs. They move to `internal/` per §1.2. Consider folding `test-command-map.md` and the release checklist into `CONTRIBUTING.md` so there's one obvious "I'm contributing to OpenReceive itself" entry point. None of these should appear in `guides/`.

---

## 4. Genuine code/docs inconsistencies to fix (not style — these break the copy-paste promise)

These are the ones that will actually bite the first real user or confuse an agent reading the repo.

### Task 4.1 — `merchantScope` is used everywhere but documented nowhere

`merchantScope` is a real option on `OpenReceiveNodeOptions` and the canonical Express example depends on it:

- `packages/js/node/src/http.ts:135,178,286` — defines/consumes `merchantScope: (req) => string`, defaulting to `() => "default"`.
- `examples/hello-fruit/server/node-express-react/src/server/create-server.ts:40` — `merchantScope: () => "demo:hello-fruit"`.

But it appears in **zero docs** (`grep -rln merchantScope docs/` → nothing). Meanwhile `docs/api-reference.md:29` tells developers the `Idempotency-Key` must be "stable for your configured OpenReceive scope" — referencing a "scope" the docs never explain how to set. Fix in `guides/authorization.md` and the quickstart: document `merchantScope`, what it's for (it namespaces idempotency/lookup so two orders or two tenants don't collide), how it relates to the three `authorize` hooks (`request` / `invoice` / `scheduler`), and show the default. The canonical Express example and the canonical quickstart should configure the same options so they match exactly.

### Task 4.2 — The quickstart's first command can't succeed

`docs/01-quickstart-node.md` opens with:

```sh
npm install @openreceive/node @openreceive/browser @openreceive/react express pg
```

…but **every `@openreceive/*` package is `private: true`** and unpublished (`grep -l '"private": true' packages/js/*/package.json` → all of them). So the very first thing a developer copies fails with a registry 404. `README.md` admits packages are private "until publishing is explicitly approved," but the quickstart presents the install as working. Pick one and make the docs honest:

- **If you intend to publish soon:** publish (flip `private`, set up the `publish.yml` path) — then the command works.
- **If not yet:** put a one-line callout at the top of the quickstart: "These packages aren't on npm yet. For now, clone the repo and run the demos (`npm run demo node`); the install snippet below is what integration will look like once published." And/or document the `npm install <local-path>` / workspace approach so someone _can_ run it today.

Either way the quickstart must not silently hand the user a command that 404s.

### Task 4.3 — `@openreceive/next` is an empty package but is advertised

`packages/js/next/src/index.ts` is literally `export {};`. Yet `@openreceive/next` is listed in the quickstart install set, in `12-release-process.md`'s release surface and tags, and in `sdk-status.md`. The Next.js example doesn't even import it — it imports `@/server/openreceive` and calls `handleFetch`. Decide:

- **Delete the package** (recommended — the Next example proves it's unnecessary), removing it from release docs/tags and any install lists; or
- **Give it a real export** (e.g. a `createOpenReceiveNextRoute` helper) if catch-all param plumbing ever justifies it.

Don't ship an empty package that's referenced in five places.

### Task 4.4 — The Rails demo is presented as a peer but is a skeleton

`README.md`'s "Run A Demo" lists four equal stacks including `npm run demo rails` (:3003). `tools/run-demo.mjs` wires it up. But `docs/02-quickstart-rails.md` and `sdk-status.md` describe it as an "initial skeleton" with "complete Rails demo smoke still pending," and `examples/hello-fruit/server/rails-react` is "Quarantined … must not be treated as an active demo" while still sitting on disk under the `examples/hello-fruit/server/*` workspace glob. Fix the expectation mismatch:

- In the README, either mark Rails as experimental/WIP next to that line, or remove it from the headline list until it's real.
- Remove or clearly quarantine `rails-react` on disk so it isn't picked up by the workspace glob or mistaken for a runnable demo.

### Task 4.5 — Explain the demo double-gate (or note it in the quickstart)

Demo mode requires **two** different opt-ins and the quickstart only shows one:

- Config option `unsafeAllowUnauthenticatedDemoMode: true` (shown in `01-quickstart-node.md`), AND
- Env var `OPENRECEIVE_ALLOW_UNAUTHENTICATED_DEMO=true`, which `http.ts:1486-1497` additionally requires when `NODE_ENV=production`.

A developer copying just the config option into a production build hits a fail-closed error they won't understand. Add one sentence where demo mode is introduced: "In a production build you must _also_ set `OPENRECEIVE_ALLOW_UNAUTHENTICATED_DEMO=true` — this double opt-in exists so you can't ship unauthenticated checkout by accident." (Keep the friction; just explain it.)

### Task 4.6 — Surface `openreceive init` in the quickstart

The CLI implements `init` (scaffolds `.env.openreceive.example` etc.), `migrate`, `doctor`, and `poll --once` (`packages/js/node/src/cli.ts:97-127`), but the quickstart only mentions `doctor` and `poll`. `init` is exactly the kind of "do this first" affordance the onboarding wants. Add it to the quickstart's setup step: `npx openreceive init` to scaffold config, then `npx openreceive doctor` to verify.

### Task 4.7 — Pick one naming convention for secondary React/element exports

App-facing names are short (`Checkout`, `useCheckout`, `QRCode`), but secondary exports keep the long prefix: `OpenReceiveThemeToggle`, `OpenReceivePaymentWizard`, `OpenReceiveWaitingState`, `useOpenReceiveTheme` (`packages/js/react/src/index.ts`). Since there are no users, normalize to the short convention (`ThemeToggle`, `PaymentWizard`, `WaitingState`, `useTheme`) and delete the long names — matching how `Checkout`/`useCheckout` already dropped the prefix. Update `internal.ts`/adapter imports and any examples. (Low priority, but it's free consistency while you're in here.)

### Task 4.8 — Make the agent test guidance match the real gate

`AGENTS.md` says "Run the smallest relevant command before finishing: `npm test`." But `npm test` is only `validate && scan:secrets` — it runs **no** typecheck and **no** unit tests, so an agent can "finish" with broken TypeScript or broken logic and a green `npm test`. Update `AGENTS.md` to say: run `npm test` while iterating, but the real gate before declaring done is `npm run test:ci` (or at minimum `npm run typecheck && npm run test:js`). This one matters specifically because the user wants agents to onboard cleanly — the current instruction quietly lets them ship breakage.

---

## 5. Suggested execution order

Do it in phases; run the verification block after each.

1. **Phase A — structure (§1):** create `docs/guides/` and `docs/internal/`, move/merge/delete files per the §1.2 table, update `manifest.json` + `build-index.mjs` + README links. Biggest legibility win, unblocks everything else.
2. **Phase B — flagged passages (§2):** rewrite the six confusing spots + the host-deploy steps. Pure docs edits inside the now-correct structure.
3. **Phase C — rot removal (§3):** delete `sdk-status.md`, relocate maintainer docs.
4. **Phase D — code/docs inconsistencies (§4):** `merchantScope` docs (4.1), install honesty (4.2), empty `@openreceive/next` (4.3), Rails expectation (4.4), demo double-gate (4.5), `init` (4.6), naming (4.7), AGENTS test guidance (4.8).
5. **Phase E — cleanup:** delete `zz-simplify.md` and this brief once applied; confirm `internal/architecture.md` is the single home for all "why" content.

### Verification (run after every phase)

```sh
# docs build + manifest stay valid
npm run build:docs

# nothing references a moved/deleted doc path
grep -rn "docs/0[0-9]\|docs/1[0-8]\|sdk-status\|07-nwc" README.md AGENTS.md docs/ examples/ tools/ packages/ || echo "clean"

# the real gate (do this before calling any of it done)
npm run test:ci
```

**Whole-brief done when:** a new developer opening `docs/guides/README.md` can go what-is → quickstart → frontend → deploy and copy-paste working code at each step without hitting a private-package 404, an undocumented required option, an empty package, or a "coming soon" page mislabeled as a quickstart; and a contributor finds all spec/process/rationale under `docs/internal/`. No developer-facing doc describes what OpenReceive _doesn't_ do except the single load-bearing "don't use Workers KV as the invoice store" warning.

---

## Appendix — files this brief touches

**Docs (move/rewrite/delete):** all of `docs/*.md` and `docs/adr/*` (restructured into `guides/` + `internal/`), `docs/manifest.json`, `docs/recipes/react-material-ui.md` (stays).
**Tooling:** `tools/docs/build-index.mjs`, `tools/run-demo.mjs` (Rails expectation, 4.4).
**Code:** `packages/js/next/` (4.3), `packages/js/react/src/index.ts` + `packages/js/browser/src/internal.ts` (4.7), `packages/js/*/package.json` (4.2 publish decision).
**Examples:** `examples/hello-fruit/server/*/src/server/create-server.ts` (doc path refs; option parity with quickstart), `examples/hello-fruit/server/rails-react/` (quarantine, 4.4).
**Root:** `README.md` (doc links, Rails line, install honesty), `AGENTS.md` (4.8), `CONTRIBUTING.md` (absorb maintainer docs), `.env.example` (cross-check 4.5 wording), and delete `zz-simplify.md` at the end.
