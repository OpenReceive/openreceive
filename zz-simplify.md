# OpenReceive Developer-Experience Re-Architecture — Implementation Brief

**Audience:** a coding agent working directly in the `OpenReceive/openreceive` repo.
**Goal:** make OpenReceive dramatically easier to adopt by replacing the current sprawling surface with a small, opinionated app-facing API and rewriting the docs to be task-first — without weakening any security boundary.

---

## 0. No backwards compatibility — delete the old surface

**There are no production users. Do not preserve backwards compatibility. Do not add deprecated aliases, dual names, compatibility shims, or "old name still works" paths. When this brief renames or replaces something, the old identifier is deleted outright.**

Concretely, that means:

- Renamed exports get the new name only. The old exported name is removed, and every internal reference is updated to the new name. No re-export of the old name.
- Replaced config options (e.g. `onPaymentSettled` → `onPaid`) are deleted, not aliased.
- Redundant public functions that are superseded by object methods are deleted from the public surface.
- Superseded docs sections are deleted, not left "for reference."

**One clarification so you do not delete load-bearing code:** "old surface" means the _legacy/duplicate public API_ — old names, aliases, redundant entry points, and dead code. It does **not** mean the internal building blocks that the framework adapters (`react`, `elements`, `vue`, `svelte`, `angular`) currently import. Those are live dependencies, not legacy. They are **relocated** to an internal subpath (§8) and stop being app-facing; they are only _deleted_ if, after the refactor, nothing imports them (true dead code). Rule of thumb: **duplicate / superseded / aliased / unimported → delete; live internal building block → relocate to `/internal`.**

---

## 1. How to use this document

Work top to bottom, one phase at a time. After each phase, run the verification commands in §11 and confirm they pass before moving on. Each task lists **Files**, **Steps**, **Keep intact**, and **Done when**. Appendices A–F give the concrete target shapes and the explicit delete list — copy from them.

Guiding principle (§3): **build a small app-facing layer over the existing engine, delete the legacy surface, relocate live internals, and rewrite the docs. Do not modify core lifecycle, storage coordination, or settlement logic.**

---

## 2. Project context (orientation)

OpenReceive is a server-owned "receive checkout" toolkit. The app's backend creates a BOLT11 Lightning invoice through a server-side receive-only NWC (Nostr Wallet Connect / NIP-47) wallet, the browser shows display-safe checkout UI, and the backend verifies settlement before app-owned fulfillment. It is not a wallet, exchange, processor, or custodian.

Monorepo layout that matters:

| Path                                   | What it is                                                                                                                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec/`                                | Source of truth: `openapi/`, `schemas/`, `test-vectors/`, `asyncapi/`, `data/`.                                                                    |
| `tools/codegen/`                       | Generates `packages/js/core/src/generated/contracts.ts` from `spec/`.                                                                              |
| `packages/js/core/`                    | Engine: errors, rates, NWC client contract, KV storage contract, **pure state transitions**, gated lookup, bounded sweep, settlement-action lease. |
| `packages/js/node/`                    | `createOpenReceive`, Express/Fetch/raw-Node bridges, Postgres/SQLite stores, the `openreceive` CLI.                                                |
| `packages/js/next/`                    | Next.js App Router wrapper.                                                                                                                        |
| `packages/js/browser/`                 | Framework-neutral browser helpers (**currently 216 public exports in one 114 KB `src/index.ts`**).                                                 |
| `packages/js/react/`                   | Hook, provider, theme scope, primitives, default `OpenReceiveCheckout`.                                                                            |
| `packages/js/elements/`                | No-framework web components (`<openreceive-checkout>`, `<openreceive-theme-toggle>`).                                                              |
| `packages/js/{vue,svelte,angular}/`    | Thin typed bindings around the web component.                                                                                                      |
| `packages/js/{provider-data,testkit}/` | Provider registry helpers; conformance fixtures.                                                                                                   |
| `examples/hello-fruit/`                | Canonical demos (Express+React, static+API, Next.js, Rails).                                                                                       |
| `docs/`                                | Public docs, indexed by `docs/manifest.json`, validated by `tools/docs/`.                                                                          |

Key symbols you will touch (all under `packages/js/`):

- `node/src/http.ts`: `createOpenReceive`, `OpenReceiveServer` (already has `mountExpress` / `handleFetch` / `handleNode` / `close`), `OpenReceiveNodeHandlers`, `OpenReceiveAuthorization` (`request`/`invoice`/`scheduler`), `OpenReceiveNodeAuthorization` (`create`/`poll`/`read`/`lookup`/`refresh`), `CreateOpenReceiveOptions`, `OpenReceiveNodeOptions`, plus the free functions `mountOpenReceiveExpress`, `createOpenReceiveFetchHandler`, `createOpenReceiveNodeHandler`, `createOpenReceiveNodeRuntime`, `dispatchOpenReceiveFetchRoute`, `dispatchOpenReceiveFetchHandler`, `matchOpenReceiveHttpRoute`, `createOpenReceiveFetchNoWalletResponse`, `openReceiveFetchJsonResponse`, `createOpenReceiveFetchRouteNotFoundResponse`, `createOpenReceiveFetchPath`, `createOpenReceiveNodeHandlers`.
- `core/src/storage/index.ts`: `InvoiceStorageRow` (carries `transaction_state`, `workflow_state`, `settlement_action_state`).
- `core/src/state/transitions.ts`: the invoice state machine.
- `browser/src/index.ts`: `createOpenReceiveInvoice` + ~215 other exports.
- `react/src/`: `OpenReceiveCheckout`, `useOpenReceiveCheckout`, `OpenReceiveProvider`, `OpenReceiveThemeScope`, primitives.
- `next/src/`: `dispatchOpenReceiveNextRoute`.
- `node/src/cli.ts`: `openreceive init|doctor|migrate|poll --once`.

---

## 3. Hard invariants — MUST NOT break

From `or-master-plan.txt`, `docs/10-security.md`, and `docs/14-secret-management.md`. Every change must preserve all of them. If a refactor would violate one, stop and choose a different approach. (These are _behavioral_ guarantees; deleting the legacy API surface does not relax any of them.)

1. **NWC secrets stay server-side.** Connection strings and wallet secrets must never reach browser code, mobile code, source maps, screenshots, logs, docs, tests, or demo assets. The secret-scan gate stays green.
2. **Receive-only.** The wallet client and all public APIs expose only `make_invoice` and `lookup_invoice`. Never add send/pay methods.
3. **Backend is the settlement authority.** Settlement is proven only by backend `lookup_invoice`. Notifications and a bare preimage are **not** proof. Frontend payment status is a **display hint only**.
4. **Settled definition is stable.** Settlement requires `settled_at` present / `transaction_state === "settled"`. You change how it is _surfaced_, never the definition.
5. **`amount_msats` in public payloads.** Keep millisat amounts in wire payloads.
6. **Exact fiat math.** No floats anywhere in money math.
7. **Durable store is the only cross-process coordination point.** No required daemon, NWC listener, webhook bridge, SSE route, or in-memory event bus. The `workflow_state` / `settlement_action_state` columns + the lease/claim logic make at-least-once settlement safe across replicas. **Keep these columns and their transitions.** You stop _exposing_ them to app code; you do not delete them.
8. **Settlement hook is at-least-once.** The settlement callback stays idempotent and dedupes by `payment_hash`. Keep and document that contract.
9. **`spec/` is source of truth.** If you change any _wire_ payload or error shape, update `spec/openapi`, `spec/schemas`, `spec/test-vectors`, and re-run `tools/codegen` so `core/src/generated/contracts.ts` stays aligned. Conformance must pass.

---

## 4. Strategy and guiding principle

The lifecycle engine (idempotent create, pure transitions, store-as-coordination, gated lookup, bounded sweep, receive-only boundary, no daemon) is the strongest part of the codebase. Keep its behavior. The DX problems live in three layers _above_ the engine:

- **What the first `createOpenReceive` call demands** → too many required decisions.
- **What types/fields/exports the app developer sees** → three status fields, two auth vocabularies, 216 browser exports, redundant mount functions, redundant naming.
- **What the docs explain** → internal package-boundary rationale instead of the task.

Replace those three layers with a small, single-vocabulary surface and delete what they replace.

---

## 5. Phase 1 — Collapse three status fields into one app-facing status

**Why:** every invoice exposes `transaction_state`, `workflow_state`, and `settlement_action_state`. React props leak both `transaction_state` and `workflow_state`. The Hello Fruit client checks `workflow_state === "settlement_action_completed"` while the master plan defines settled as `transaction_state === "settled"`. App developers cannot tell which field means "paid."

### Task 1.1 — Define the public status type

- **Files:** new `packages/js/browser/src/status.ts`, re-exported from the browser entry.
- **Steps:**
  1. Define `export type Status = "pending" | "paid" | "expired" | "failed";`
  2. Implement a `status(invoiceLike): Status` helper using the mapping in **Appendix C**. It reads only existing display-safe fields (`transaction_state`, `expires_at`, `settled_at`).
- **Decision:** derive `status` in the client/view layer only. **Do not** add `status` to the HTTP payload in this pass (that would force a `spec/` + codegen change). The store and wire keep `transaction_state` as the source of truth. (Promoting `status` to a wire field is a possible later change — §9 note.)
- **Keep intact:** `transaction_state`/`workflow_state`/`settlement_action_state` stay in `InvoiceStorageRow` and on the wire. You add a derived view, you do not remove data.
- **Done when:** `status()` is unit-tested against Appendix C and exported.

### Task 1.2 — Simplify the React checkout surface

- **Files:** `packages/js/react/src/` (`OpenReceiveCheckout`/`Checkout`, `useOpenReceiveCheckout`/`useCheckout`).
- **Steps:**
  1. Accept a single `invoice` prop that is the whole invoice response object from `createInvoice`; read `invoice_id`, `invoice`, `payment_hash`, `amount_msats`, `expires_at` off it. **Delete the per-field required props** (`invoice_id`, `payment_hash`, `amount_msats`, `transaction_state`, `workflow_state`, `expires_at`, `workflow_state` as separate inputs). They are superseded by the single `invoice` object.
  2. Default `lookupUrl` to `"/openreceive/v1/invoices/lookup"`; keep it overridable.
  3. Expose a single `status` on the hook's returned view model (Task 1.1). **Remove `workflow_state` and `transaction_state` from the hook return type and the component prop surface.**
  4. Add an `onPaid` callback prop that fires when the polled `status` first becomes `"paid"`. **Document it as a UI hint only** — authoritative fulfillment uses the server hook (Phase 2 / Appendix A). Add a code comment saying exactly that.
- **Keep intact:** watcher/polling/countdown/copy/open-wallet behavior; "frontend is a hint" boundary.
- **Done when:** `<Checkout invoice={invoice} onPaid={...} />` works with no other required props, and no React example references `workflow_state` or `transaction_state`.

### Task 1.3 — Same simplification for elements + framework bindings

- **Files:** `packages/js/elements/src/`, and the `vue`/`svelte`/`angular` binding helpers.
- **Steps:** the web component accepts the invoice fields it already does, exposes a single `status` concept in its public attributes/events, and **drops `workflow-state` as a public attribute** (keep internal). Update framework bindings to match.
- **Done when:** the static-HTML demo (Task 9.2) works using only the simplified status.

---

## 6. Phase 2 — One authorization vocabulary

**Why:** `createOpenReceive` documents `authorize.{request, invoice, scheduler}` (3 hooks) while `OpenReceiveNodeOptions` uses `auth.{create, poll, read, lookup, refresh}` (5 hooks), and `docs/15-framework-auth.md` describes the 5-route world plus `cronSecret` and `OPENRECEIVE_CRON_SECRET`. The mismatch is the main reason doc 15 reads as confusing.

### Task 2.1 — Make the 3-hook model the only public contract

- **Files:** `packages/js/node/src/http.ts`.
- **Steps:**
  1. `OpenReceiveAuthorization` (`request` / `invoice` / `scheduler`) is the **only** auth surface. Map internally per **Appendix D**: `request → create`; `invoice → read + lookup + refresh`; `scheduler → poll`.
  2. **Delete the public 5-hook `OpenReceiveNodeAuthorization` type and the `auth` option.** Convert any internal need into a private, non-exported mapping inside the engine. Do not export a granular hook surface at all.
  3. Consolidate the cron secret to **one** name: env `OPENRECEIVE_CRON_SECRET`, option `cronSecret`. **Delete the other** if a duplicate exists.
  4. Fail-closed default (D5 below): with no auth hooks and no demo flag, unauthenticated invoice creation is rejected. Provide the single-hook happy path.
- **Decision D5:** unauthenticated invoice creation must still fail closed in production; the common authenticated path is a single hook (`authorize.request`); local/demo stays behind the explicit `unsafeAllowUnauthenticatedDemoMode` escape hatch.
- **Done when:** a project secures all routes with `authorize.request` + `authorize.invoice` + `authorize.scheduler` and nothing else, and `create`/`read`/`lookup`/`refresh`/`poll` no longer appear as public hook names anywhere (grep-clean).

### Task 2.2 — Rename the settlement hook

- **Files:** `packages/js/node/src/http.ts` (and references).
- **Steps:** rename the public option `onPaymentSettled` → `onPaid`. **Delete `onPaymentSettled` entirely — no alias.** Keep the at-least-once + dedupe-by-`payment_hash` contract and document it inline.
- **Done when:** quickstart uses `onPaid`; `onPaymentSettled` returns zero source hits.

---

## 7. Phase 3 — One construction path and a minimal "hello world"

**Why:** the quickstart passes a `createOpenReceive()` server into `mountOpenReceiveExpress`, while `examples/hello-fruit/.../create-server.ts` passes a raw options object into the same function. Several redundant mount functions exist. The first call demands `merchantScope`, three authorize hooks, `csrf`, and `onPaymentSettled` before anything runs.

### Task 3.1 — Make minimal config actually minimal

- **Files:** `packages/js/node/src/http.ts` (`createOpenReceive`, `CreateOpenReceiveOptions`).
- **Steps:**
  1. Make `createOpenReceive({ nwc })` valid alone: `store` defaults to `local-sqlite` (already does), `merchantScope` defaults to `() => "default"`, prices/CORS/rate-limit knobs default sensibly.
  2. The only things a real app must add are `authorize.request` (or the explicit demo flag) and `onPaid`.
  3. Keep all advanced knobs working (`merchantScope`, `cors`, `priceProviders`, `lookupBurst`, `lookupRatePerSecond`, `actionLeaseTtlSeconds`, `sweepIntervalSeconds`, `backgroundSweep`, `basePath`, `namespace`, `clock`, …) but **out of the quickstart**.
- **Done when:** Appendix A's server snippet compiles and runs end to end.

### Task 3.2 — One way to mount; delete the redundant free functions

- **Files:** `packages/js/node/src/http.ts`, `packages/js/next/src/`, `packages/js/node/src/index.ts`.
- **Steps:**
  1. Documented path: `const openreceive = await createOpenReceive({...})`, then `openreceive.mountExpress(app)` / `openreceive.handleFetch(req)` / `openreceive.handleNode(req, res)`.
  2. **Delete the public free functions** superseded by those methods: `mountOpenReceiveExpress`, `createOpenReceiveFetchHandler`, `createOpenReceiveNodeHandler`, `createOpenReceiveNodeRuntime`, `dispatchOpenReceiveFetchRoute`, `dispatchOpenReceiveFetchHandler`, `matchOpenReceiveHttpRoute`, `createOpenReceiveFetchNoWalletResponse`, `openReceiveFetchJsonResponse`, `createOpenReceiveFetchRouteNotFoundResponse`, `createOpenReceiveFetchPath`, `createOpenReceiveNodeHandlers`. Remove them from `node/src/index.ts` exports and delete the definitions if nothing else imports them. If the engine still needs one of these as private plumbing, keep it **non-exported** inside `http.ts`.
  3. **Next.js:** prefer calling `openreceive.handleFetch(request)` directly from the catch-all route — it takes a `Request` and returns a `Response`, so the dedicated dispatcher is unnecessary. **Delete `dispatchOpenReceiveNextRoute`** and have the Next example use `handleFetch`. (Only if catch-all param plumbing turns out to be genuinely required, keep a single minimal _internal_ helper in `@openreceive/next`, not a public export.)
  4. **Update `examples/hello-fruit/server/node-express-react/src/server/create-server.ts`** to the documented `createOpenReceive(...)` + `openreceive.mountExpress(app)` path so the canonical example and the canonical doc are identical. Update the Next.js example route to `handleFetch`.
- **Done when:** there is exactly one wiring pattern in docs and demos, and every deleted function name is grep-clean.

---

## 8. Phase 4 — Tier the package surface and shorten app-facing names

**Why:** `@openreceive/browser` exposes 216 symbols (mostly 30–50-char adapter-internal names) from a single 114 KB file; `docs/05-frontend-checkout.md` lists ~100 of them. App developers need ~6.

### Task 4.1 — Split browser into a tiny top-level entry + an `/internal` subpath

- **Files:** `packages/js/browser/package.json` (`exports` map), `packages/js/browser/src/`.
- **Steps:**
  1. Define the app-facing allow-list for the top-level `@openreceive/browser` entry — see **Appendix B** (single-digit to low-double-digit exports).
  2. **Relocate** everything that currently exists "so adapters do not drift" to `@openreceive/browser/internal` (new `exports` subpath): display/snapshot model builders, attribute/selector/part name constants, label/icon registries, theme model helpers, custom-event constructors, wizard DOM contracts, escaping helpers, etc. These are live internal dependencies — relocate, do not delete (§0).
  3. Keep the existing `@openreceive/browser/country-map` subpath.
  4. Split `src/index.ts` (114 KB) into files by concern; the top-level `index.ts` re-exports only the allow-list.
  5. **Delete** any helper that has zero importers after the refactor (true dead code).
- **Keep intact:** every still-used symbol remains importable (from `/internal`). No behavior change.
- **Done when:** top-level browser exports match Appendix B; the framework adapters import building blocks from `@openreceive/browser/internal` and build/test green.

### Task 4.2 — Repoint intra-monorepo imports to the internal subpath

- **Files:** `packages/js/{react,elements,vue,svelte,angular}/src/`.
- **Steps:** repoint imports of relocated helpers from `@openreceive/browser` to `@openreceive/browser/internal`. Run a workspace build/typecheck to catch breakage.
- **Done when:** the whole workspace builds.

### Task 4.3 — Rename app-facing exports to short names and delete the long ones (D2)

- **Decision D2:** rename the app-facing exports to short names and **delete the old exported names — no aliases.** Update all internal references to the new names. (Non-exported internal helpers may keep verbose names; only the _exported app-facing_ identifiers must change and the old ones must be gone.)
- **Files:** the top-level entry files / source of `node`, `browser`, `react`, `elements` (and the implementations of the renamed symbols).
- **Renames (old → new; old is deleted):**
  - `@openreceive/browser`: `createOpenReceiveInvoice` → `createInvoice`; expose `status` / `Status`, `lightningUri`, `qrSvg`, `qrPngDataUrl`, `copyInvoice`, `openWallet`, `createCheckoutController`.
  - `@openreceive/react`: `OpenReceiveCheckout` → `Checkout`; `useOpenReceiveCheckout` → `useCheckout`; `OpenReceiveProvider` → `CheckoutProvider`; `OpenReceiveThemeScope` → `ThemeScope`; `OpenReceiveQRCode` → `QRCode`; `CopyInvoiceButton`, `OpenWalletButton`, `OpenReceiveInvoiceSummary` → `InvoiceSummary`.
  - `@openreceive/elements`: keep `defineOpenReceiveElements` (it is already the single clear entry) and the two custom-element tag names; no alias churn needed here.
  - Optional sugar: add an `amount` helper (`usd("10.00")` → `{ currency: "USD", value: "10.00" }`) producing the existing `fiat` object; `fiat: { currency, value }` stays canonical.
- **Done when:** Appendix A's client snippet compiles using the short names, and every old exported name in the rename list is grep-clean across `packages/`, `examples/`, and `docs/`.

---

## 9. Phase 5 — Documentation rewrite

**Why:** `docs/05-frontend-checkout.md` is dominated by "X also lives in the browser package so adapters do not drift on Y" — maintainer rationale, not a task guide. `docs/15-framework-auth.md` teaches a different vocabulary than the quickstart and mixes app responsibilities with engine internals.

### Task 5.1 — Rewrite `docs/01-quickstart-node.md` task-first

- **Steps:** reduce the headline path to Appendix A: install → set `OPENRECEIVE_NWC` → `createOpenReceive({ nwc, authorize.request, onPaid })` → `openreceive.mountExpress(app)` → `createInvoice` + `<Checkout>`. It fits on roughly one screen before any "advanced" heading. Move multi-framework mounts (Hono/SvelteKit/Fastify/Koa/raw Node/Nest) into a separate "Other frameworks" section _after_ the working happy path. Keep doctor/recovery below the fold. **Delete** references to the removed free mount functions.
- **Done when:** a reader can take a payment by copy-pasting the first screen, and the snippets match the Express example verbatim.

### Task 5.2 — Rewrite `docs/05-frontend-checkout.md`

- **Steps:** lead with the ~6 app-facing helpers (Appendix B) and the three React UI paths (default component / primitives+slots / fully headless). **Delete the ~100-item helper inventory and the entire "also lives in the browser package so adapters do not drift" narrative.** The relevant rationale moves to the architecture doc (Task 5.4).
- **Done when:** the doc describes only what an app developer does; no internal export inventory remains.

### Task 5.3 — Rewrite `docs/15-framework-auth.md` around the 3 hooks

- **Steps:** structure as: (1) the three hooks `request` / `invoice` / `scheduler` and what each gates, with the one-liner common case; (2) a copy-paste "secure production config" block; (3) CSRF and CORS as the app's responsibility; (4) demo mode as the explicit escape hatch. **Delete** the per-invoice cooldown, global token-bucket, and settlement-action-claim explanations from this doc and move them to the architecture doc.
- **Done when:** the auth doc uses the same vocabulary as the quickstart and never names `create`/`read`/`lookup`/`refresh`/`poll` as app-facing hooks.

### Task 5.4 — Add a contributor/architecture doc and relocate rationale

- **Steps:** create `docs/architecture.md` (or an ADR under `docs/adr/`). Move into it the package-ownership/drift rationale from doc 05, the cooldown/token-bucket/settlement-claim internals from doc 15, and the "why the store is the only coordination point" explanation. Link from contributor docs only.
- **Done when:** the rationale is preserved for maintainers and absent from getting-started docs.

### Task 5.5 — Keep the docs index and gate green

- **Files:** `docs/manifest.json`, `docs/api-reference.md`, `docs/sdk-status.md`, plus whatever `tools/docs/` validates.
- **Steps:** update `manifest.json` for added/renamed docs; rewrite `api-reference.md` to the new app-facing surface (point to `/internal` for advanced); update `sdk-status.md` for the renames. Run the docs validator.
- **Done when:** `npm run test:ci` docs checks pass.

> **Note on `status` as a wire field (future, optional):** to make `status` a first-class HTTP response field rather than client-derived, update `spec/openapi`, `spec/schemas`, `spec/test-vectors`, re-run `tools/codegen`, and bump conformance vectors. Do **not** bundle it into this pass.

---

## 10. Phase 6 — Sweep for stragglers

After Phases 1–5, do a final deletion pass so nothing legacy survives:

- **Files:** entire `packages/`, `examples/`, `docs/`, `tools/`.
- **Steps:** for every name in **Appendix F**, grep the repo. Any hit outside `CHANGELOG.md` is a straggler — update or delete it. Search comments and string literals too (doc snippets, test fixtures, demo metadata). Update `CHANGELOG.md` to record the breaking rename/removal set.
- **Done when:** Appendix F grep gate is clean (see §11).

---

## 11. Verification checklist (run after every phase, and at the end)

From the repo root:

```sh
npm test                 # fast: contract + secret checks
npm run test:ci          # full local gate (schemas, vectors, contracts, packages, secret scans, release, deploy, docs)
npx openreceive doctor   # storage round-trip, NWC preflight, config/store contract
npm run mock-wallet      # then run conformance against the deterministic wallet
```

Smoke the demos end to end (they exercise the real app-facing path you changed):

```sh
npm run demo node        # Express + React        http://localhost:3000
npm run demo static      # Static HTML + small API http://localhost:3001
npm run demo nextjs      # Next.js fullstack       http://localhost:3002
```

Deletion / grep gate (must return no source hits outside `CHANGELOG.md`):

```sh
# run from repo root; expect empty output
grep -rn --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.js' --include='*.md' --include='*.json' \
  -e 'onPaymentSettled' \
  -e 'OpenReceiveNodeAuthorization' \
  -e 'mountOpenReceiveExpress' \
  -e 'createOpenReceiveFetchHandler' \
  -e 'createOpenReceiveNodeHandler' \
  -e 'createOpenReceiveNodeRuntime' \
  -e 'dispatchOpenReceiveFetchRoute' \
  -e 'dispatchOpenReceiveFetchHandler' \
  -e 'matchOpenReceiveHttpRoute' \
  -e 'createOpenReceiveNodeHandlers' \
  -e 'dispatchOpenReceiveNextRoute' \
  -e 'createOpenReceiveInvoice' \
  -e 'OpenReceiveCheckout' \
  -e 'useOpenReceiveCheckout' \
  -e 'OpenReceiveProvider' \
  -e 'OpenReceiveThemeScope' \
  -e 'OpenReceiveQRCode' \
  -e 'OpenReceiveInvoiceSummary' \
  packages/ examples/ docs/ tools/
```

Hard gates that must stay green:

- [ ] Secret-scan passes — no NWC string in bundles, source maps, logs, docs, tests, or demo assets (Invariant 1).
- [ ] No send/pay method on any public client or route (Invariant 2).
- [ ] Frontend never asserts settlement on its own; backend `lookup_invoice` remains authority; client `onPaid` documented as a hint (Invariant 3).
- [ ] `workflow_state` / `settlement_action_state` columns still exist and still transition; multi-replica settlement-claim test passes (Invariant 7).
- [ ] Settlement hook still at-least-once and idempotent by `payment_hash` (Invariant 8).
- [ ] If any wire payload/error changed, `spec/` updated and codegen re-run; conformance vectors pass (Invariant 9).
- [ ] All three JS demos complete an invoice → checkout → settled flow using the simplified surface.
- [ ] The Express demo source and `docs/01-quickstart-node.md` are byte-for-byte consistent on wiring.
- [ ] The deletion grep gate above is empty.

---

## 12. Suggested commit/PR sequence

Land in order so each PR is reviewable and the gate stays green between them:

1. `feat(status)!: single derived Status; remove transaction_state/workflow_state from app surface`
2. `feat(auth)!: collapse to request/invoice/scheduler; delete 5-hook auth + onPaymentSettled`
3. `feat(node)!: minimal createOpenReceive; single mount path; delete free mount fns; align example`
4. `refactor(browser)!: app-facing entry vs /internal; split index.ts; delete dead exports`
5. `feat(api)!: rename app-facing exports to short names; delete old names`
6. `docs!: task-first quickstart/checkout/auth; move rationale to architecture; final delete sweep`

(`!` marks breaking changes — expected and fine; record them in `CHANGELOG.md`.)

---

## Appendix A — Target minimal quickstart (copy this shape)

**Server — `server/openreceive.ts`:**

```ts
import { createOpenReceive } from "@openreceive/node";

export const openreceive = await createOpenReceive({
  nwc: process.env.OPENRECEIVE_NWC!, // server-only; never reaches the browser
  authorize: {
    request: (req) => Boolean(req.user), // who may create an invoice (the realistic minimum)
  },
  onPaid: async ({ invoice }) => {
    // authoritative: fires after backend-verified settlement,
    await markOrderPaid(invoice.metadata.order_id); // at-least-once — dedupe by invoice/payment_hash
  },
});
```

**Server — `server/index.ts`:**

```ts
import express from "express";
import { openreceive } from "./openreceive";

const app = express();
app.use(express.json());
openreceive.mountExpress(app); // serves /openreceive/v1/*
app.listen(3000);
```

**Next.js catch-all — `src/app/openreceive/v1/[...openreceive]/route.ts`:**

```ts
import { openreceive } from "@/server/openreceive";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handle = (request: Request) => openreceive.handleFetch(request);

export const GET = handle;
export const POST = handle;
```

**Client — checkout:**

```tsx
import { createInvoice } from "@openreceive/browser";
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

const invoice = await createInvoice({
  idempotencyKey: orderId, // stable order/cart id; prevents duplicate invoices
  fiat: { currency: "USD", value: "10.00" },
  metadata: { order_id: orderId },
});

// onPaid here is a UI hint only; fulfillment is the server onPaid above.
<Checkout invoice={invoice} onPaid={() => showThankYou()} />;
```

**Even shorter, local/demo only** (explicit escape hatch — not for production):

```ts
export const openreceive = await createOpenReceive({
  nwc: process.env.OPENRECEIVE_NWC!,
  unsafeAllowUnauthenticatedDemoMode: true,
});
```

Intentionally **absent** from the quickstart (still available as advanced config): `merchantScope`, `authorize.invoice`, `authorize.scheduler`, `csrf`, `cors`, `lookupUrl` wiring, `transaction_state` / `workflow_state`, rate-limit/sweep knobs.

---

## Appendix B — Target app-facing public surface (allow-lists)

Everything not listed here lives under an `/internal` subpath. Nothing is exposed under a legacy name.

**`@openreceive/node` (top-level):**

- `createOpenReceive(options)` → object with `mountExpress(app)`, `handleFetch(req)`, `handleNode(req, res)`, `runtime`, `close()`.
- `createNwcReceiveClient` (advanced/manual wiring).
- `OpenReceiveError` + error types.
- Types: `CreateOpenReceiveOptions` (the minimal documented shape), `OpenReceiveAuthorization` (3 hooks), `Status`.

**`@openreceive/browser` (top-level) — target ~6–10:**

- `createInvoice`
- `status` / `Status`
- `lightningUri`, `qrSvg`, `qrPngDataUrl`
- `copyInvoice`, `openWallet`
- `createCheckoutController`

**`@openreceive/react` (top-level):**

- `Checkout`, `useCheckout`, `CheckoutProvider`, `ThemeScope`
- primitives: `QRCode`, `CopyInvoiceButton`, `OpenWalletButton`, `InvoiceSummary`

**`@openreceive/next` (top-level):**

- nothing required — the catch-all uses `openreceive.handleFetch`. (No `dispatch*` export.)

**`@openreceive/elements` (top-level):**

- `defineOpenReceiveElements`, the two custom elements, `styles.css`

**`@openreceive/browser/internal` (new subpath):** the relocated display/snapshot model builders, attribute/selector/part constants, label & icon registries, theme model helpers, custom-event constructors, wizard DOM contracts, escaping helpers — consumed by the framework adapters, not by app developers.

---

## Appendix C — Status mapping (Phase 1)

Derive the single app-facing `status` from existing display-safe fields. First match wins:

| Condition (on display-safe invoice fields)                                          | `status`  |
| ----------------------------------------------------------------------------------- | --------- |
| `transaction_state === "settled"` (or `settled_at` present)                         | `paid`    |
| `transaction_state === "failed"`                                                    | `failed`  |
| `transaction_state === "expired"` **or** (`expires_at` in the past and not settled) | `expired` |
| otherwise                                                                           | `pending` |

Notes:

- Client display may show `paid` as soon as `transaction_state === "settled"`. **Server-side fulfillment still keys off the `onPaid` server hook**, which runs only after backend `lookup_invoice` proves settlement and is delivered at-least-once. Keep the two distinct; say so in code comments.
- Do **not** map any `workflow_state` / `settlement_action_state` value into `status`. Those stay internal (Invariant 7).

---

## Appendix D — Auth hook mapping (Phase 2)

The three public hooks fan out to internal route checks:

| Public hook (`authorize.*`) | Internal route(s) gated | HTTP                                                                                  |
| --------------------------- | ----------------------- | ------------------------------------------------------------------------------------- |
| `request`                   | create                  | `POST /openreceive/v1/invoices`                                                       |
| `invoice`                   | read, lookup, refresh   | `GET .../invoices/{id}`, `POST .../invoices/lookup`, `POST .../invoices/{id}/refresh` |
| `scheduler`                 | poll                    | `POST /openreceive/v1/poll` (also accepts `OPENRECEIVE_CRON_SECRET`)                  |

The granular 5-hook surface is internal-only and **not exported**.

---

## Appendix E — Docs restructure summary

| Doc                                    | Action                                                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/01-quickstart-node.md`           | Rewrite task-first (Appendix A first screen); push multi-framework mounts + recovery below the fold; delete references to removed free functions. |
| `docs/05-frontend-checkout.md`         | Lead with ~6 app-facing helpers + 3 React UI paths; delete the ~100-item helper inventory and the "also lives in the browser package…" narrative. |
| `docs/15-framework-auth.md`            | Restructure around the 3 hooks + secure-prod block + CSRF/CORS + demo mode; move cooldown/token-bucket/settlement-claim internals out.            |
| `docs/architecture.md` (new) or an ADR | New home for package-ownership/drift rationale and engine coordination internals removed from 05 and 15.                                          |
| `docs/manifest.json`                   | Update index for added/renamed docs; keep `tools/docs/` validation green.                                                                         |
| `docs/api-reference.md`                | Rewrite to the new app-facing surface; point to `/internal` for advanced.                                                                         |
| `docs/sdk-status.md`                   | Reflect renames/removals.                                                                                                                         |

---

## Appendix F — Explicit delete list (grep gate)

These identifiers and option names are **removed entirely** (no alias, no re-export). After the work, none may appear in source outside `CHANGELOG.md`.

**Config options / env:**

- `onPaymentSettled` (→ `onPaid`)
- `OpenReceiveNodeAuthorization` + the `auth` option (→ `authorize` with `request`/`invoice`/`scheduler`)
- the duplicate cron-secret name, if one exists (keep `OPENRECEIVE_CRON_SECRET` / `cronSecret`)

**Node free functions (superseded by object methods):**

- `mountOpenReceiveExpress`, `createOpenReceiveFetchHandler`, `createOpenReceiveNodeHandler`, `createOpenReceiveNodeRuntime`, `dispatchOpenReceiveFetchRoute`, `dispatchOpenReceiveFetchHandler`, `matchOpenReceiveHttpRoute`, `createOpenReceiveFetchNoWalletResponse`, `openReceiveFetchJsonResponse`, `createOpenReceiveFetchRouteNotFoundResponse`, `createOpenReceiveFetchPath`, `createOpenReceiveNodeHandlers`

**Next:**

- `dispatchOpenReceiveNextRoute` (→ `openreceive.handleFetch`)

**Browser app-facing rename (old names deleted):**

- `createOpenReceiveInvoice` (→ `createInvoice`)

**React app-facing renames (old names deleted):**

- `OpenReceiveCheckout` (→ `Checkout`), `useOpenReceiveCheckout` (→ `useCheckout`), `OpenReceiveProvider` (→ `CheckoutProvider`), `OpenReceiveThemeScope` (→ `ThemeScope`), `OpenReceiveQRCode` (→ `QRCode`), `OpenReceiveInvoiceSummary` (→ `InvoiceSummary`)

**Removed from app-facing types (kept in store only):**

- `workflow_state`, `settlement_action_state`, `transaction_state` as inputs/outputs of the React/elements public API and the documented invoice view. (Columns remain in `InvoiceStorageRow`; they are simply not part of the app-facing surface.)

**Relocated, NOT deleted** (move to `@openreceive/browser/internal`): the ~200 framework-adapter building-block exports currently in `browser/src/index.ts`. Delete only those with zero importers after the refactor.

---

### Definition of done (whole brief)

A new developer can take a Lightning payment by copy-pasting the first screen of the Node quickstart; the app-facing browser surface is single-digit/low-double-digit; there is one auth vocabulary, one status field, and one mount pattern across docs and examples; no deprecated alias, dual name, or redundant entry point survives (Appendix F grep gate is empty); all internal coordination machinery and every security invariant in §3 are unchanged; and `npm run test:ci` plus the three JS demos pass.
