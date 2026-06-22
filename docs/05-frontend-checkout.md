# Frontend Checkout

Frontend code receives display-safe invoice data only. Keep NWC connection
strings, wallet secrets, and server-side wallet clients on the backend.

## Browser Helpers

`@openreceive/browser` provides framework-neutral helpers:

- `createLightningUri(invoice)`
- `createQrSvg(invoice)`
- `createQrPngDataUrl(invoice)`
- `copyInvoice({ invoice })`
- `openWallet({ invoice })`
- `createOpenReceiveCheckoutState(invoiceResponse)`
- `OpenReceiveCheckoutWatcher`
- `createOpenReceiveCheckoutController()` for a shared watcher/action
  controller used by framework adapters, including copy, open-wallet, manual
  reload, retry, refresh-expired-invoice, and cancel actions
- `createOpenReceiveLookupInvoiceFetcher({ lookupUrl })` for lower-level custom
  controller/watcher integrations
- `createOpenReceiveRefreshInvoiceFetcher({ refreshUrl, idempotencyKey })` for
  backend-owned, idempotent refresh-expired-invoice actions
- `applyOpenReceiveInvoiceEvent(state, event)`
- `parseOpenReceiveInvoiceEvent(event.data)`
- `OPENRECEIVE_INVOICE_EVENT_TYPES`
- `createOpenReceivePaymentWizardState(request)`
- `readOpenReceiveStoredCountryCode()` / `writeOpenReceiveStoredCountryCode()`
- `readOpenReceiveThemePreference()` / `writeOpenReceiveThemePreference()`
- `createOpenReceiveStoredThemeModel()` for storage-backed light/dark state
- `toggleOpenReceiveStoredThemePreference()`,
  `applyOpenReceiveThemeAttributes()`, and
  `applyOpenReceiveCheckoutThemeAttributes()` for no-framework/theme-button
  wiring
- `syncOpenReceiveStoredThemeControls()` and
  `toggleOpenReceiveStoredThemeControls()` for no-framework apps that want the
  package to update root, checkout, and toggle-button state together
- `createOpenReceiveTransientFeedbackController()` for shared copy-feedback
  timing across adapters
- `formatOpenReceiveCountdown(seconds)` / `formatOpenReceiveMsats(amount_msats)`
- `shouldOpenReceiveCheckoutShowWaiting(state)` for the shared waiting-spinner
  decision
- `createOpenReceiveCheckoutStatusModel()` for shared payment status title,
  detail, spinner visibility, countdown prefix, and countdown label display
- `createOpenReceiveCheckoutDisplayModel()`,
  `createOpenReceiveCheckoutSnapshotFromDisplayData()`,
  `createOpenReceiveCheckoutStateFromDisplayData()`,
  `formatOpenReceivePaymentHashLabel()`, and
  `assertOpenReceiveDisplayInvoice()` for shared Lightning URI, amount label,
  payment-hash label, transaction-state label, settled timestamp preservation,
  display-to-state conversion, and display-safe invoice checks
- `escapeOpenReceiveHtml()` for string-rendered adapters that need shared
  display escaping
- `openReceiveCheckoutLabels` and label helpers for payment status, provider
  badges, provider action links, route subtitles, country prompts, and wizard
  empty states
- `createOpenReceiveWizardRouteDisplays()` for route headings, provider preview
  rows, provider badges, recommended labels, copy labels, and provider links
- `createOpenReceiveWizardRouteAssetDisplays()` for Bitcoin/crypto route button
  ids, selected state, icons, and network subtitles
- `getOpenReceivePaymentMethodIcon()` and `getOpenReceiveRouteIcon()` for
  shared checkout method and asset icons
- `createOpenReceivePaymentWizardSelection()`,
  `updateOpenReceivePaymentWizardSelection()`, and
  `createOpenReceivePaymentWizardModel()`
- `OPENRECEIVE_PAYMENT_WIZARD_ATTRIBUTES`,
  `OPENRECEIVE_PAYMENT_WIZARD_SELECTORS`,
  `parseOpenReceivePaymentMethod()`, and `parseOpenReceiveRegion()` for shared
  wizard DOM binding contracts
- `parseOpenReceiveOptionalInteger()`,
  `parseOpenReceiveBooleanAttribute()`, `parseOpenReceiveResolvedTheme()`, and
  `parseOpenReceiveThemePreference()` for shared checkout/theme attribute
  parsing
- `OPENRECEIVE_CHECKOUT_DATA_ATTRIBUTES` and
  `OPENRECEIVE_CHECKOUT_DATA_SELECTORS` for shared default checkout data hooks
- `createOpenReceiveCountryPickerModel()` and
  `projectOpenReceiveCountryMapPoint()` for shared region tabs, country lists,
  country display labels, country map dimensions, land paths, region backdrop
  geometry, and map pins
- `createOpenReceiveCheckoutElementAttributes()` and
  `createOpenReceiveCheckoutElementListeners()` for Vue/Svelte/Angular and
  no-framework bindings around `<openreceive-checkout>`
- `OPENRECEIVE_CHECKOUT_ELEMENT_ATTRIBUTES` and
  `OPENRECEIVE_THEME_TOGGLE_ELEMENT_ATTRIBUTES` for shared custom-element
  attribute names
- `OPENRECEIVE_CHECKOUT_ELEMENT_PARTS`,
  `OPENRECEIVE_CHECKOUT_ELEMENT_PART_SELECTORS`,
  `OPENRECEIVE_THEME_TOGGLE_ELEMENT_PARTS`, and
  `OPENRECEIVE_THEME_TOGGLE_ELEMENT_PART_SELECTORS` for shared web-component
  shadow-part names and action selectors
- `createOpenReceiveProviderCopyEvent(providerId)` for the shared
  provider-copy custom event name and detail payload
- `createOpenReceiveCheckoutActionEvent()`,
  `createOpenReceiveCheckoutStateEvent()`, and
  `createOpenReceiveCheckoutErrorEvent()` for shared checkout custom event
  payloads
- `OPENRECEIVE_THEME_TOGGLE_ELEMENT_EVENTS` and
  `createOpenReceiveThemeChangeEvent(theme)` for the shared theme-toggle custom
  event name and detail payload
- `createOpenReceiveCheckoutElement()` for no-framework apps that want the
  package to create, attribute, and wire the checkout element in one call
- `createOpenReceiveThemeToggleElement()` and
  `createOpenReceiveCheckoutShell()` for no-framework apps that want the
  package to create the theme toggle, checkout element, or both in one call
- `createOpenReceiveThemeToggleElementAttributes()` and
  `OPENRECEIVE_THEME_TOGGLE_ELEMENT_TAG_NAME` for framework bindings around
  `<openreceive-theme-toggle>`
- `createOpenReceiveThemeModel()` for shared resolved theme, toggle label,
  next theme, container theme attributes, and checkout-element theme attributes
- `openReceiveCheckoutElementStyles` and
  `openReceiveThemeToggleElementStyles` for browser-owned web-component shadow
  styles consumed by `@openreceive/elements`

These helpers reject NWC connection strings and only work with BOLT11 invoice
strings.

The checkout state helpers are pure browser-side reducers for display state.
They update only matching `invoice_id` and `payment_hash` events, track
countdown/phase fields, and keep settlement as a UI hint. Your settlement
actions still require backend lookup and app-owned authorization.

```ts
let checkout = createOpenReceiveCheckoutState(invoiceResponse, {
  now: Math.floor(Date.now() / 1000)
});

for (const eventName of OPENRECEIVE_INVOICE_EVENT_TYPES) {
  events.addEventListener(eventName, (event) => {
    checkout = applyOpenReceiveInvoiceEvent(
      checkout,
      parseOpenReceiveInvoiceEvent(event.data),
      { eventName }
    );
  });
}
```

The browser package also owns the payment wizard state used by framework
adapters: first choice of credit card, bank transfer, Bitcoin, or crypto;
country storage; country/region metadata; provider-route lookup; and shared UI
defaults such as polling cadence, copy-feedback timing, and provider preview
count.

Use the wizard selection reducer/model for method selection, country switching,
country map pins, region tabs, Bitcoin/crypto route choices, and derived
visible country/route lists. That keeps React, web components,
Vue/Svelte/Angular bindings, and future native framework components aligned.

Framework adapters use `createOpenReceiveCheckoutController()` or the
lower-level `OpenReceiveCheckoutWatcher` for lookup polling, countdown timers,
lookup POST bodies, and lookup-response merging. The React
and web-component packages pass `lookupUrl` to the browser controller rather
than constructing lookup fetchers locally.
They emit display-safe checkout state only; backend lookup remains the
settlement authority. Checkout state creation computes `expiresInSeconds` with
the browser package's default clock when `expires_at` is present, so adapters
can render countdowns without their own clock helpers.
Manual reload and retry controls call the controller's `reloadState()` and
`retry()` actions so they use the same backend lookup shape and lookup-response
merge behavior as polling. Refresh controls call `refreshExpiredInvoice()` after
the app provides either `refreshInvoice` or `refreshUrl` plus
`refreshIdempotencyKey`; the action POSTs to your backend refresh route
and replaces browser state with the backend's new invoice snapshot. Cancel
controls call `cancel()` to stop the browser watcher without changing backend
invoice settlement.
Derive payment status UI from `createOpenReceiveCheckoutStatusModel()` so
adapters share expiry checks, settlement display, countdown labels, and
waiting/settled/expired status text.
For framework adapters that need a headless action surface,
`createOpenReceiveCheckoutController()` bundles the same watcher lifecycle with
package-owned `copyInvoice()`, `openWallet()`, `reloadState()`, `retry()`,
`refreshExpiredInvoice()`, and `cancel()` actions. Vue, Svelte, and Angular expose framework-named controller
helpers that delegate to this browser controller, and the React hook consumes
the same controller for watcher/copy/open-wallet/reload/retry/refresh/cancel
lifecycle behavior. The no-framework web component also consumes this
controller for live checkout state and primary copy/open-wallet actions.

Shared checkout labels also live in the browser package so React, web
components, Vue/Svelte/Angular bindings, future native framework components,
and demos do not drift on status messages, copy feedback, provider badges, or
wizard text. Adapter UI derives provider action labels, route subtitles,
country prompts, and payment status displays from these helpers.
Checkout display labels also live there: adapters derive Lightning URI, amount
labels, shortened payment hashes, transaction-state labels, and display invoice
safety from `createOpenReceiveCheckoutDisplayModel()`. When an adapter has
display invoice data and needs checkout state or a live-controller snapshot, use
`createOpenReceiveCheckoutStateFromDisplayData()` or
`createOpenReceiveCheckoutSnapshotFromDisplayData()` rather than duplicating the
snapshot shape. Those helpers preserve `settled_at` when the backend includes
it, so adapters do not drop settlement timestamps while rendering display state.
String-rendered adapters use `escapeOpenReceiveHtml()` for shared display
escaping.
Shared checkout icon assets also live in the browser package so default UIs and
future framework adapters render the same method, Bitcoin route, and crypto
asset icons without copying SVG ownership into each package.
Web-component shadow styles also live in the browser package so
`@openreceive/elements` can render its checkout and theme-toggle shadow DOM
without owning a parallel stylesheet.
Provider-copy custom event construction also lives in the browser package so
React, web components, and future adapters do not drift on event names or
payload shape.
Checkout copy/open/state/settled/payment/error custom event construction also
lives there, so web components and future adapters do not recompose checkout
event payloads locally.
Theme-toggle custom event construction also lives there, so web components and
future adapters dispatch the same theme-change event name and detail payload.
Transient copy-feedback timing also lives in the browser package so React, web
components, and future adapters reset "Copied" states consistently.
Country map viewport constants, region backdrop geometry, and projected pins
also live in the browser package so framework adapters can render different map
styles without re-owning the wizard's country geography. The
`@openreceive/browser/country-map` subpath also exports
`openReceiveCountryMapLandPaths`, so richer framework renderers can draw the
same world-map backdrop without copying D3/topojson/world-atlas setup into the
default browser helper entry. Country row labels, coverage labels, selected
country summaries, and map readout labels also come from the browser country
picker model, so adapters do not compose country display strings locally.
Wizard DOM attribute names, selectors, and interaction parsers also live in the
browser package so web components and future framework adapters bind method,
region, country, route, and provider-copy actions consistently.
Shared checkout/theme attribute parsers also live there so adapters interpret
numeric invoice fields, boolean flags, resolved themes, and stored theme
preferences consistently.
Default checkout data attribute names and selectors also live there so React,
web components, shared CSS, and future adapters agree on QR, state, actions,
theme, and theme-toggle hooks.
Custom-element attribute names also live there, so framework bindings and the
web-component implementation share the same `invoice-id`, `lookup-url`,
`payment-wizard`, `root-selector`, and theme-toggle attribute contract.
Web-component shadow action part names and selectors also live there, so the
web-component implementation and future wrappers share the same copy,
open-wallet, and theme-toggle button hooks.
Wizard route/provider display rows and route asset display rows live there too,
so adapters do not duplicate route id resolution, selected state, icon choice,
network subtitles, provider preview slicing, recommended labels, provider
badges, or action link copy.

## Browser Logs

The browser helpers accept an optional `logger(entry)` callback on checkout
state, event, copy, and open-wallet operations:

```ts
const logger = (entry) => console[entry.level]("[openreceive]", entry);

let checkout = createOpenReceiveCheckoutState(invoiceResponse, {
  logger,
  now: Math.floor(Date.now() / 1000)
});

checkout = applyOpenReceiveInvoiceEvent(checkout, eventPayload, {
  eventName: "invoice.settled",
  logger
});
```

Client log entries use display-safe fields such as `invoice_id`,
`payment_hash`, amount, transaction state, workflow state, and phase. They do
not log BOLT11 invoice strings, NWC connection strings, signed event URL
tokens, cookies, authorization headers, or request bodies.

## Web Components

`@openreceive/elements` provides a small no-framework checkout element:

```ts
import { defineOpenReceiveElements } from "@openreceive/elements";
import "@openreceive/elements/styles.css";

defineOpenReceiveElements({ logger });
```

```html
<openreceive-theme-toggle
  root-selector=".page"
  checkout-selector="openreceive-checkout"
  default-theme="light"
></openreceive-theme-toggle>

<openreceive-checkout
  invoice-id="or_inv_..."
  invoice="lnbc..."
  payment-hash="..."
  amount-msats="200000"
  transaction-state="pending"
  workflow-state="invoice_created"
  expires-at="1781943000"
  lookup-url="/openreceive/v1/invoices/lookup"
  theme="dark"
></openreceive-checkout>
```

The element renders QR, copy, and open-wallet controls from display-safe invoice
data. When `invoice-id`, `payment-hash`, `lookup-url`, and `expires-at` are
present, it also renders the package-owned waiting state,
countdown, BOLT11 copy feedback, and country-aware payment wizard. It dispatches:

- `openreceive-copy`
- `openreceive-open-wallet`
- `openreceive-error`

Settlement and app-owned settlement actions still belong to backend-verified
invoice state. Frontend events are UI hints, not payment authority.

`defineOpenReceiveElements()` also registers `<openreceive-theme-toggle>`.
That element owns the stored light/dark preference, toggle label, and theme
attribute syncing for a no-framework page and target checkout element.

## Vue, Svelte, And Angular

`@openreceive/vue`, `@openreceive/svelte`, and `@openreceive/angular` currently
provide thin typed bindings around the shared web component. They do not import
the frameworks at runtime; host apps can register the element once and bind the
package-owned checkout attributes, event listeners, and theme model in their
native template syntax.

```ts
import {
  createOpenReceiveVueCheckoutShellBinding,
  defineOpenReceiveElements
} from "@openreceive/vue";

defineOpenReceiveElements();

const shell = createOpenReceiveVueCheckoutShellBinding(invoiceResponse, {
  lookupUrl: "/openreceive/v1/invoices/lookup",
  rootSelector: ".page",
  onError: (event) => console.error(event)
});
```

The Svelte and Angular packages expose the same shared boundary with
`createOpenReceiveSvelteCheckoutBinding()` and
`createOpenReceiveAngularCheckoutBinding()`, plus storage-backed theme helpers
named `createOpenReceiveSvelteStoredThemeBinding()` and
`createOpenReceiveAngularStoredThemeBinding()`. These helpers keep framework
apps from copying checkout attribute names, event names, theme storage keys,
theme toggle labels, resolved theme attributes, theme-attribute application, or
display-safe invoice wiring while fuller native components remain future work.
They also re-export the no-framework theme-control helpers for apps that want
to wire a light/dark button through DOM refs, and expose framework-named
theme-toggle element binding helpers so apps do not copy
`openreceive-theme-toggle` attribute names. Their framework-named checkout
controller helpers expose the shared browser watcher/copy/open-wallet action
surface without reimplementing lifecycle logic.
For the common full checkout case, use
`createOpenReceiveVueCheckoutShellBinding()`,
`createOpenReceiveSvelteCheckoutShellBinding()`, or
`createOpenReceiveAngularCheckoutShellBinding()`. Those helpers return root
theme attributes, a checkout web-component binding with the resolved theme, and
a theme-toggle web-component binding from the same browser-owned model.
Each framework package also exposes
`createOpenReceive*CheckoutComponentModel()` for a one-call component-shaped
model that includes the shell binding plus the shared custom-element
registration hook. That is the current v0.1 bridge for package-owned
Vue/Svelte/Angular checkout components while native compiler-specific
components mature. The packages also ship thin component entry files:
`@openreceive/vue/checkout.vue`, `@openreceive/svelte/checkout.svelte`, and
`@openreceive/angular/checkout-component`. Each wraps the shared
`<openreceive-checkout>` and `<openreceive-theme-toggle>` elements rather than
reimplementing checkout behavior.

No-framework apps can use `createOpenReceiveCheckoutElement()`,
`createOpenReceiveThemeToggleElement()`, or
`createOpenReceiveCheckoutShell()` when rendering the shared custom elements,
or use the lower-level attribute/listener helpers when a framework template
owns element creation. That keeps `openreceive-*` custom event names, theme
toggle attributes, and checkout attribute names package-owned.

Default checkout CSS is shared from `@openreceive/browser/styles.css`. The
Elements, Vue, Svelte, Angular, and React packages each expose their own
`styles.css` wrapper that imports the browser-owned stylesheet, so app code can
use the package it already installed:

```ts
import "@openreceive/elements/styles.css";
import "@openreceive/vue/styles.css";
import "@openreceive/svelte/styles.css";
import "@openreceive/angular/styles.css";
```

## React

`@openreceive/react` provides a headless hook, small primitives, slot/component
overrides, and a default checkout component:

```tsx
import {
  CopyInvoiceButton,
  OpenWalletButton,
  OpenReceiveCheckout,
  OpenReceiveInvoiceSummary,
  OpenReceiveProvider,
  OpenReceiveQRCode,
  OpenReceiveThemeScope,
  useOpenReceiveCheckout,
  useOpenReceiveCheckoutContext
} from "@openreceive/react";
import "@openreceive/react/styles.css";

const checkout = useOpenReceiveCheckout({ invoice: "lnbc..." });
```

Apps that want one checkout model for a subtree can use
`OpenReceiveProvider`. Its context exposes the same controller-backed model as
the hook, including copy/open-wallet actions, waiting state, and countdown
labels:

```tsx
<OpenReceiveProvider invoice="lnbc..." amount_msats={200000}>
  <CheckoutButton />
</OpenReceiveProvider>
```

```tsx
function CheckoutButton() {
  const checkout = useOpenReceiveCheckoutContext();
  return <button onClick={checkout.copyInvoice}>Copy BOLT11</button>;
}
```

```tsx
<CopyInvoiceButton invoice={checkout.invoice}>Copy invoice</CopyInvoiceButton>
<OpenWalletButton invoice={checkout.invoice}>Open wallet</OpenWalletButton>
```

For the default themed shell, wrap the page or checkout area in
`OpenReceiveThemeScope`. It owns the shared theme attributes and can render the
package-owned light/dark toggle without local hook or button wiring:

```tsx
<OpenReceiveThemeScope as="main" className="page" themeToggle>
  <OpenReceiveCheckout
    invoice="lnbc..."
    amount_msats={200000}
    transaction_state="pending"
  />
</OpenReceiveThemeScope>
```

```tsx
<OpenReceiveCheckout
  invoice_id="or_inv_..."
  invoice="lnbc..."
  payment_hash="..."
  amount_msats={200000}
  transaction_state="pending"
  workflow_state="invoice_created"
  expires_at={1781943000}
  lookupUrl="/openreceive/v1/invoices/lookup"
  themeSwitcher
  logger={logger}
/>
```

React components follow the same boundary: they render invoice display data and
browser actions, while the backend remains the settlement authority. The default
checkout UI includes the QR code, waiting state, expiry countdown, BOLT11 copy
feedback, open-wallet action, and the country-aware payment wizard. The hook can
poll a server-owned lookup endpoint by passing `lookupUrl` into the browser
checkout controller, or a custom `lookupInvoice` callback when an app needs to
override the fetcher. The hook delegates watcher lifecycle, copy, lookup, and
open-wallet actions to the browser checkout
controller, and the default checkout passes those hook actions into its default
copy/open-wallet buttons. Copy feedback timing is
browser-owned and consumed by the hook, copy button, and provider buttons.
Frontend state is still only a display hint.

`OpenReceiveThemeScope` is the easiest React theme integration. For apps that
need lower-level control, `useOpenReceiveTheme()` returns the shared browser
theme model fields, including `attributes`, `checkoutElementAttributes`,
`toggleLabel`, and `nextTheme`. `attributes` includes both
`data-openreceive-theme` and the common `data-theme` hook so apps can keep
their own CSS selectors while still using the package-owned light/dark
behavior.

Apps with their own design system can replace the visible pieces without
forking payment logic:

```tsx
<OpenReceiveCheckout
  invoice="lnbc..."
  amount_msats={200000}
  transaction_state="pending"
  components={{
    Button: MyButton,
    InvoiceSummary: MySummary
  }}
  classNames={{
    root: "checkout",
    qr: "checkoutQr",
    actions: "checkoutActions",
    wizard: "checkoutWizard"
  }}
/>
```

React has three supported UI paths:

- Default UI: use `OpenReceiveCheckout` and package CSS for demos, quickstarts,
  and teams without a design system.
- Primitive/slot UI: use `OpenReceiveQRCode`, `CopyInvoiceButton`,
  `OpenWalletButton`, component overrides, class names, and render props while
  the package still owns checkout behavior.
- Fully headless UI: use `useOpenReceiveCheckout()` and app-owned markup/CSS;
  the hook still owns polling, countdown state, copy/open-wallet,
  refresh/retry/cancel, and display-safe state conversion.

```tsx
function CustomCheckout({ invoice }) {
  const checkout = useOpenReceiveCheckout({
    ...invoice,
    lookupUrl: "/openreceive/v1/invoices/lookup"
  });

  return (
    <section className="myCheckout">
      <OpenReceiveQRCode invoice={checkout.invoice} />
      <p>{checkout.amountLabel}</p>
      <button onClick={checkout.copyInvoice} type="button">
        Copy
      </button>
      <button onClick={checkout.openWallet} type="button">
        Open wallet
      </button>
      <span>{checkout.status.title}</span>
    </section>
  );
}
```

For full markup ownership, pass a render function as `children`. The render
function receives the display-safe checkout view model.

The Material UI recipe in `docs/recipes/react-material-ui.md` shows how to
compose the React primitives inside an app-owned design system.

## Static Demo

`examples/hello-fruit/server/static-html-small-api` shows the same flow without
React. It uses shared fruit assets, mounts the Express API inside Vite during
local development, and renders `<openreceive-checkout>` from display-safe
invoice JSON. Product selection and invoice creation stay in the demo; checkout
state, countdown, copy/open-wallet behavior, theme preference, and the payment
wizard stay in packages. The Hello Fruit demos also share product display
formatting helpers so prices and invoice descriptions do not drift between
frontend stacks, plus shared invoice creation labels so button and fallback
error copy stay consistent while each demo remains small. The static demo uses
browser-owned theme-toggle and checkout-shell creators instead of hand-writing
custom element attributes, event listeners, stored theme transitions, toggle
labels, or checkout theme attributes. The React demos use
`OpenReceiveThemeScope` for the same reason. Vue, Svelte, and Angular adapters
also expose framework-named checkout-shell creators for apps that mount the
web-component shell imperatively.
