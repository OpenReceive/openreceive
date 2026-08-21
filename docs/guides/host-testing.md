# Testing an OpenReceive host

How to test a host integration — your `loadOrder`, `amountForOrder`,
`authorize`, and `onPaid` wiring — without touching a real wallet or a swap
provider.

## Inject a fake wallet client

`createOpenReceive` accepts a pre-built client via the `client` option and
skips NWC entirely when one is supplied:

```ts
import { createOpenReceive } from "@openreceive/node";
import type { OpenReceiveReceiveNwcClient } from "@openreceive/node";

const service = await createOpenReceive({
  client: myFakeClient, // implements OpenReceiveReceiveNwcClient
  priceProviders: [new StaticPriceProvider()],
});
```

Any object implementing `OpenReceiveReceiveNwcClient` works: mint
deterministic invoices from `makeInvoice`, report settlement from
`lookupInvoice`/`listTransactions`, and your whole host — HTTP routes,
persistence, reconcile, `onPaid` — runs the production code paths against it.
Settlement follows the real rule: a transaction settles on a finality signal
(`settled_at`, a settled state, or a settled/paid boolean), never on the mere
presence of a preimage.

For fiat pricing without a network, pass
`priceProviders: [new StaticPriceProvider()]` (from `@openreceive/core`).
There is deliberately no implicit static fallback: a service must refuse to
price invoices rather than silently quote a hard-coded rate, so tests opt in
explicitly.

## Click through a full checkout with no wallet

The Hello Fruit demo boots against in-process fakes when `DEMO_WALLET=testkit`
is set — no `NWC_URI`, no network:

```sh
DEMO_WALLET=testkit npm run dev   # in examples/hello-fruit/server/node-express
```

The shop, the checkout wizard (all four framework tabs), Lightning invoices,
and swap flows all work; a test-only control surface under `/__testkit` lets
you settle or expire invoices and advance swap states from `curl` or a
browser console. The prefix hard-404s in every other mode, the compose files
never set `DEMO_WALLET`, and the client-bundle scanner proves no testkit code
ships — see
[examples/README.md](../../examples/README.md) for the endpoint list.

## The repository's own E2E lane

`npm run test:e2e` runs Playwright specs against exactly this testkit demo
mode: four-framework mount-and-pay walkthroughs, swap advance + refund,
expire-and-remint, and resume/theme-toggle behavior. The specs in
[tests/e2e/](../../tests/e2e) are a working reference for driving a checkout
end-to-end against the fakes.

The `@openreceive/testkit` package that powers all of this is internal and
unpublished; its API may change without notice. The stable seams for your own
tests are the `client` option and `StaticPriceProvider` above.
