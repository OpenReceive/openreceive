# iOS Safari lab findings, 2026-11-23

Real Safari on the iOS simulator, touched through WebDriverAgent and watched
through the Web Inspector (see README.md), on master at 68f86869 (the
2026-11-23 checkout fixes). The shop is the Buy a Button demo in testkit mode;
the bad-network cases use the browser lab's fault pages. Screenshots cited
below are in `findings/`; every run's full screenshots and `report.json` are
in `results/` (git-ignored).

| Device | iOS / Safari | What ran |
| --- | --- | --- |
| iPhone SE (3rd generation), 375 x 667 pt | 27.2 | every journey, React tab and Vue tab (the packaged element) |
| iPhone 16 Pro, 402 x 874 pt | 27.2 | lightning, swap (no rotation), refund-typing, tutorial, reload, layout; all twelve fault cases (element and React) |
| iPhone SE (3rd generation) | 18.4 | lightning, swap, refund-typing, tutorial, reload |

iOS 17.x is not installed on this Mac; 18.4 is the older runtime. Desktop
WebKit for comparison: `OPENRECEIVE_BROWSERS=webkit node --import tsx --test
tests/real-browser-*.test.mjs` passed 144 of 144 (Playwright WebKit 27.2).

## Status

Fixed for the next release and re-checked in the lab on the iPhone SE (iOS
27.2, React and Vue): **1** (the refund field turns off auto-capitalization,
autocorrect and spellcheck; the typed address now arrives as typed), **2**
(the warning moved above the field; Review now sits at y 207–253 with the
keyboard up, and the payer's first tap opens the review), and **7** (copy
fields 44 pt on touch screens). **3** is a design question about the host page's
history; see "Finding 3: the strategy" at the end. **4** to
**6** are left as they are.

## Product problems, most severe first

### 1. The phone keyboard capitalizes a Solana refund address, and the checkout accepts the different address

- **What the payer sees:** they tap the refund address field and type their
  Solana address, which starts with a lowercase letter. The keyboard starts in
  Shift for an empty field, so the first letter comes out uppercase
  (`v2Ua…` becomes `V2Ua…`). The checkout says nothing, and Review asks them
  to "Confirm refund to V2Ua6NdL3Z6Rvb2jfj8p7oPGUGdco4SqJd3yR5AEmhW". That is a
  different Solana account: Solana addresses carry no checksum, and the
  capitalized string still decodes to a 32-byte key, so
  `isValidSolanaAddress` (packages/js/core/src/swap/address.ts) passes it. A
  refund sent there is lost.
- **Journey step:** `refund-typing`, refund address field, then Review.
- **Screenshots:** `findings/1a-autocap-first-key-se-ios27.png` (Shift on, the
  `v` key tapped), `findings/1b-autocap-review-se-ios27.png` (the review),
  `findings/1c-autocap-review-se-ios18.png` (iOS 18.4).
- **Repro:** order a button, USDT on Solana, Continue, step the swap to
  `refund_required`, tap the refund field, tap `v` on the software keyboard,
  type the rest of `v2Ua6NdL3Z6Rvb2jfj8p7oPGUGdco4SqJd3yR5AEmhW`, tap Review.
  `IOS_UDID=<udid> JOURNEYS=refund-typing node tests/ios/run-journeys.mjs`.
- **Seen on:** iOS 27.2 and 18.4, iPhone SE and 16 Pro, React tab and Vue tab
  (the element). Every run.
- **Confidence:** high. The first letter is a real tap on the keyboard key;
  the rendered field has `autocomplete="off"` and no `autocapitalize`,
  `autocorrect` or `spellcheck` attribute.
- **Product bug or lab artifact:** product bug.
- **iOS only?** It needs a software keyboard, so desktop WebKit cannot show
  it. Android's Gboard also capitalizes the start of a text field by default;
  the Android lab types with `input text`, which skips that, so Android is
  untested, not cleared. A pasted address is not affected.
- **Fix direction:** `autocapitalize="none" autocorrect="off"
  spellcheck="false"` on every field that takes an address or an invoice
  (the refund address in React's checkout and in the element's swap panel).
  Worth checking the other address inputs the same way.

### 2. With the keyboard up on the iPhone SE (iOS 27), a tap on "Review refund address" goes to Safari

- **What the payer sees:** with the address typed and the keyboard up, Safari
  scrolls the field into view, which puts "Review refund address" just above
  Safari's minimized address pill. The payer taps the middle of the button.
  The page never gets the touch: Safari closes the keyboard and brings back its
  full address bar. Nothing else happens, and they must tap Review again.
- **Journey step:** `refund-typing`, Review with the keyboard up. The journey
  sweeps the button row by row, with the page's click held back.
- **Measured (iPhone SE, iOS 27.2):** the button sits at y 295–341 pt, and the
  minimized pill is drawn from y 334 (x 143–232). Rows 299–315 reach the page.
  Every row from 319 down goes to Safari, across the full width (at x 113
  too, away from the pill). So the pill's touch area starts about 16 pt
  above the drawn pill and spans the width. React: the lower half of the button,
  the middle included. Vue tab (the element): the same rows. On the first
  focus Safari scrolled the element's button to y 327–372, behind the pill and
  wholly inside the band; on later focuses it sat at 295–341, like React's.
- **Screenshots:** `findings/2a-dead-band-keyboard-up-react-se.png`,
  `findings/2b-dead-band-after-tap-react-se.png` (keyboard closed, full bar
  back, no review), `findings/2c-dead-band-keyboard-up-vue-se.png`.
- **Not seen on:** the iPhone 16 Pro on iOS 27.2 (the button lands at y
  385–430, every row reached the page), and the iPhone SE on iOS 18.4, whose
  bar does not float over the page (every row reached it, and the middle tap
  opened the review).
- **Repro:** as in 1, on the iPhone SE (iOS 27.2).
- **Confidence:** high for the observation (repeated on React and Vue; the
  same tap 15 pt higher works). The touch area belongs to Safari, so the
  product can only keep the button out of it.
- **Product bug or lab artifact:** a product problem on one phone size: the
  first tap is lost, and nothing on screen says why.
- **iOS only?** Yes: Safari 27's floating minimized bar. Desktop WebKit has no
  keyboard and no such bar.
- **Fix direction:** keep the submit button out of the band above the
  keyboard. Put the warning text above the field so Review follows it
  closely, or give the form enough room below the button that the focused
  field and the button sit higher. Separately: in the one run that checked it
  (16 Pro, React), the keyboard's Return key did not submit the refund form,
  though a tap on Review does. Unconfirmed, but if Return reliably submitted
  (`enterkeyhint="go"`), it would give a way around the band.

### 3. The edge-swipe Back with the wallet walkthrough open leaves the checkout

- **What the payer sees:** they open "How To Pay" (the walkthrough opens on
  screen, y 133–457 of 589 pt), then swipe from the left edge to close it, as
  iOS teaches. Safari goes back a page instead. In the demo that is the shop's
  grid, because its router keeps the same document. A swipe from the right
  edge brings the checkout back, on the method grid rather than the open
  invoice (Bitcoin again gives the same invoice, see 4). On a host whose
  checkout page is a real navigation, Back leaves the page.
- **Journey step:** `tutorial`, edge swipe with the walkthrough open.
- **Screenshots:** `findings/3a-walkthrough-open-se.png`,
  `findings/3b-walkthrough-after-edge-swipe-se.png`.
- **Seen on:** iOS 27.2 and 18.4, iPhone SE and 16 Pro, React and Vue.
- **Confidence:** high. `typeof CloseWatcher` is `"undefined"` in Safari, and
  the Android fix (5ea39d6e, openCheckoutModal) closes the walkthrough on Back
  through a CloseWatcher, so it cannot apply here.
- **Product bug or lab artifact:** product, the iOS half of the Android BACK
  finding.
- **iOS only?** Yes. Chromium now has CloseWatcher, and desktop has no edge
  swipe.
- **Fix direction:** where `CloseWatcher` is missing, have openCheckoutModal
  push a history entry when it opens and close the walkthrough on
  `popstate`, removing the entry when it closes another way. It must not
  leave an extra entry behind after a normal close.

### 4. A reload right after paying can show the method grid for about 2 s before the receipt

- **What the payer sees:** they pay, then press Safari's reload button before
  the page has noticed. For 1.8 s the checkout shows "Pay this invoice /
  Choose how you want to pay" with the coin tiles, then the receipt. It never
  showed a deposit address or a second invoice.
- **Journey step:** `reload`, step 3 (settle, then Safari's reload button at
  once).
- **Screenshot:** `findings/4-grid-after-paid-reload-16pro.png`.
- **Seen on:** iPhone 16 Pro, iOS 27.2, React (once). On the SE (iOS 27.2
  React and Vue, iOS 18.4 React) the receipt was the first screen. The same
  journey's swap version (`swap-paid`: completed, settled, reload) reached the
  receipt without a deposit screen on every device.
- **Confidence:** medium. This is timing: it shows when the reload lands
  before the shop's next wallet scan (the 3 s reconcile gate), so it depends
  on the clock, not on iOS.
- **Product bug or lab artifact:** product behaviour, low. A payer who taps a
  coin in those two seconds is the "paid, then a coin" interruption case,
  which the real-browser suite covers.
- **iOS only?** No. Any browser can show it with the same timing.
- **Fix direction:** if it matters, the order page could show a neutral
  "Checking payment" state until the first status check answers for a
  reference that already has an attempt, instead of the grid.

### 5. Safari offers "AutoFill Contact" on the refund address field

- **What the payer sees:** the bar above the keyboard offers "AutoFill
  Contact", and the field's edit menu offers AutoFill. A tap fills in a
  contact's details. The address validation rejects those, so this is
  clutter, not a wrong refund.
- **Screenshot:** `findings/5-autofill-contact-bar-se.png`.
- **Seen on:** iOS 27.2, React and Vue. **Confidence:** high.
  **Product or lab:** product, polish. **iOS only:** yes (Safari's AutoFill
  heuristics; `autocomplete="off"` does not stop them).
- **Fix direction:** low priority. Safari decides by the field's label and
  surroundings; try a field `name`/`id` with no contact meaning. Otherwise
  accept it.

### 6. The Lightning QR is 102 pt wide on a 375 pt phone

- **What the payer sees:** the invoice puts the QR beside the details: 102 pt
  on the SE, 112 pt on the 16 Pro, with the details squeezed into a narrow
  column ("Keep this page open while we / confirm your / payment").
- **Screenshot:** `findings/6-small-qr-se.png`. **Seen on:** every device,
  React and Vue.
- **Confidence:** high. **Product or lab:** product, polish (the Android
  lab's QR check). It is the container-query layout from f600d33b
  (`qr: w-[min(148px,38cqw)]` in packages/js/browser/src/ui-classes.ts) in the
  demo's 270 pt checkout column.
- **iOS only?** No. Any browser at this width.
- **Fix direction:** stack the QR above the details below about 360 pt of
  container width, and let it grow to at least 160 pt. A payer on the same
  phone mostly copies, but a payer scanning from a second phone needs the size.

### 7. The checkout's copy fields are 32 pt tall

- **What the payer sees:** the read-only copy fields are 32 pt tall:
  "Address" and "Amount" on the deposit screen (183 x 32), "This page" on the
  refund screen (113 x 32), and "Order id" and "Checkout link" in "Keep this
  order ID" (157 x 32). The copy buttons beside them are 44 pt. The demo's own
  tabs ("Buy a button", "React / Vue / …") are 23 pt; that is the demo's
  chrome, not the checkout's.
- **Screenshot:** `findings/7-deposit-copy-fields-se.png`. **Seen on:** every
  device. **Confidence:** high. **Product or lab:** product, polish. **iOS
  only:** no.
- **Fix direction:** `pointer-coarse:min-h-11` on the copy fields, as
  5ea39d6e did for the buttons.

## Not problems, or not the checkout's

- **Dynamic Type is ignored.** At the largest size
  (`accessibility-extra-extra-extra-large`), Safari's own bar grows to a fifth
  of the screen, but the page stays at 16 px (`-apple-system-body` would be
  53 px). Ordinary web text in Safari behaves this way, so this is a choice,
  not a bug: payers who need larger text use Safari's page zoom.
  `findings/8-largest-dynamic-type-se.png`.
- **Dark appearance.** The page sees `prefers-color-scheme: dark`, but the
  demo has no dark mode by design (examples/buttons/shared/client/theme.ts),
  so it stays light. The checkout's own dark theme is covered by desktop
  WebKit's accessibility tests, which pass. No text under 3:1 was measured.
- **The app switch.** With the invoice open, Photos came to the front, the
  invoice was paid 3 to 5 s later, and Safari came back after 60 s (React and
  Vue) and after 6 minutes (React). Each time the receipt was already on
  screen when Safari came back. The page saw `visibilitychange` to hidden,
  kept its document (no reload, no back/forward-cache restore), and painted
  the receipt while hidden, 8 to 14 s after leaving. A 1 s timer got about one
  tick in two while hidden. This is the simulator: it does not suspend a
  backgrounded page the way an iPhone does (exrails found the same), so the
  verdict on a real phone's suspension needs a real iPhone.
- **Reloads.** Safari's reload button and pull-to-refresh on the open invoice
  bring back the method grid, and Bitcoin again returns the same invoice (the
  same payment hash, every device, React and Vue). Reloading a paid swap
  order lands on the receipt.
- **Bad network** (fault pages, iPhone 16 Pro, element and React's checkout,
  all twelve cases passed):
  - A POST /checkouts that never answers: Try again after 25 s, which leads
    to the invoice, with one invoice in all.
  - A proxy's 502 on it: Try again.
  - A 10 s wallet scan while the invoice is paid: no error panel, and the
    receipt 1.2 s after the scan.
  - A 502, a 504 and a captive portal answering the status poll: no error
    panel, no proxy words, and the receipt 4.5 s after the shop answers.
  - A status poll that never answers: the receipt in 18 s.
  - Safari's reload button during "Preparing payment": back to the grid, the
    same single provider order, and paid.

  `findings/9a-fault-hung-create-try-again-16pro.png`,
  `findings/9b-fault-poll-strangers-receipt-16pro.png`.
- **Lightning:** Copy invoice put the BOLT11 on the iOS pasteboard
  (`simctl pbpaste`), and showed "Copied". The receipt appeared 2.2 to 2.8 s
  after the payment. Nothing moved while the countdown ticked (sampled every
  100 ms for 5 s). Nothing scrolled sideways or was cut off at 375 pt.
- **Swap:** one amount on the deposit screen (the $5.00 total was not on
  screen). The 44-character address typed on the software keyboard came out
  exact, focusing the 16 px field did not zoom the page, and the address
  survived landscape and back. Review and confirm both worked. Copy put the
  deposit address on the pasteboard. On the React tab Review is above the
  keyboard; on the Vue tab one finger drag brings it there.
- **Safari's bar while scrolling:** it shrinks rather than hides (innerHeight
  549 to 589 pt on the SE). Mid-page it floats over whatever scrolls under it
  (a "How To Pay" button in one sample), which the payer scrolls past. The
  lab did not measure the very bottom of the page.
- **Console and network:** no console error from the checkout. The
  "Failed to load resource" lines were the injected 502/504s. A status poll
  in flight during a reload is reported by Safari as "The network connection
  was lost", which is an aborted request, not a failure.

## Lab artifacts (found and worked around, not product problems)

- **Probe listeners need page script.** Listeners the Inspector adds after
  load do not receive touches on a page with no listeners of its own: a plain
  page got no `pointerdown` or `touchstart` at all. The demo has React's root
  listeners. The fault pages carry the probe inline in `<head>`.
- **Viewport numbers lag the keyboard.** While the keyboard opens, Safari's
  `visualViewport` numbers are mid-animation (an `offsetTop` 188 pt off), so
  the lab aims and judges "above the keyboard" with Safari's accessibility
  rects.
- **The status bar takes clamped taps.** A tap on the status bar is iOS's
  "scroll to top" and never reaches the page, so calibration scrolls its
  target into view first.
- **Rotation breaks the 16 Pro.** On the iPhone 16 Pro simulator, after a
  rotation to landscape and back, the lab's touches stopped reaching the page
  for the rest of the run. A new Appium session and a new Inspector did not
  help; a new run did. Landscape is measured on the SE; the 16 Pro runs with
  `SKIP_ROTATE=1`.
- **Pull-to-refresh on the 16 Pro.** The finger pull did not reload the page
  on the 16 Pro (it did on the SE, iOS 27.2 and 18.4). Probably where the
  drag starts relative to the Dynamic Island. Not investigated.
- **Shared testkit wallet.** Two runs on one demo share its testkit wallet,
  whose invoices carry no order reference. The reload check therefore
  compares payment hashes, not invoice counts.

## What could not be automated

- **safaridriver.** It needs Simulator.app, which this Xcode 27.2 does not
  include. WebDriverAgent did every touch instead; the Web Inspector
  observed.
- **Low Power Mode.** The simulator has no switch for it.
- **iOS 17.x.** No runtime is installed; 18.4 stood in as the older iOS.
- **A real phone's suspension** of a backgrounded tab: see the app switch
  above.
- **The 16 Pro in landscape:** see the lab artifacts.

## Finding 3: the strategy

The Android fix closes the walkthrough on Back through a CloseWatcher and
never touches the host page's history. That cannot cover iOS:

- **CloseWatcher on iOS.** Safari 27.2 has no CloseWatcher. WebKit turned it
  on in July 2026 (WebKit bug 316977), and the Safari 27.3 beta notes list
  "close watchers and the `closedby` attribute". But the HTML spec's close
  requests are Esc, Android's Back, VoiceOver's scrub and a gamepad's back
  button. Safari's edge swipe is history navigation, not a close request, so
  27.3 will very likely still leave the page (unconfirmed until a 27.3
  simulator runtime exists). Feature-detecting CloseWatcher cannot tell
  whether the swipe is covered.
- **The only lever is a history entry:** a same-URL `pushState` when the
  walkthrough opens, closing it on `popstate`, and `history.back()` when it
  closes another way (✕, Escape, a tap outside).

**Measured in real Safari** (`JOURNEYS=back-history-A,back-history-B,back-history-C`,
iPhone SE, iOS 27.2 and 18.4). The demo shop is the host, and it routes on
every `popstate` (ShopStore.startRouting re-resolves the order):

| Case | Result |
| --- | --- |
| A: entry pushed in the tap on How To Pay; edge swipe | one `popstate`, same URL, same document; the walkthrough closed; the open invoice stayed; the next swipe left for the shop as before |
| B: entry pushed 6 s after the tap (no fresh user activation); edge swipe | the same as A: Safari did not skip the entry (the page had seen touches before) |
| C: entry pushed in the tap; ✕, then `history.back()` | one `popstate`; the walkthrough closed; the invoice stayed; the entry was gone (the next Back went to the shop) |

**What a host's router does with a same-URL entry** (from the routers'
source; see the research notes):

- **Angular** (`onSameUrlNavigation: 'ignore'`, the default): nothing.
- **Next.js App Router 14.1 and later:** nothing, if the entry keeps
  `history.state` (it copies its own keys). Older App Routers reload on a
  Forward to an entry without `__NA`.
- **React Router 6.4+ / 7 data routers:** a same-URL pop re-runs the page's
  loaders once. An active `useBlocker` can turn the pop into a page reload.
- **Vue Router 4:** the pop runs the global guards and `afterEach` again (for
  example, a second analytics page view). It warns if its state keys are lost,
  so the entry must spread `history.state`.
- **Plain multi-page sites:** nothing.
- **Hosts that route on `popstate` themselves**, like the demo: whatever their
  handler does on a same-URL pop. The demo's was harmless.

**The options:**

| Option | Payer on iOS | Host risk | API |
| --- | --- | --- | --- |
| (a) Keep the limitation | edge swipe leaves the checkout mid-payment | none | none |
| (b) Opt-in entry (`close-on-back` / `closeOnBack`) | fixed only where the host turns it on, so mostly not fixed | only for hosts that choose it | one prop |
| (c) Entry by default where Back is not a close request (iOS/iPadOS WebKit), opt-out prop | fixed | the router effects above, once per walkthrough closed by Back or ✕ | one opt-out prop |
| (d) The walkthrough inline on phones (expands in place, no overlay) | no modal, so no expectation that Back closes it; Back leaves the page as on any page | none | none; a design change |

**Recommendation: (c).** The edge swipe is in the payment funnel, and losing
the checkout mid-payment costs more than an extra loader run or page view on
some routers. The measured behaviour in Safari is clean, and hosts with a
router that minds have a switch.

How to build it:
- Push `{ ...history.state, openreceiveWalkthrough: id }`, the same URL,
  synchronously in the click that opens the walkthrough.
- On a `popstate` that leaves the entry, close the walkthrough. Skip the close
  animation when `event.hasUAVisualTransition` is true.
- When the walkthrough closes another way, call `history.back()` only if the
  current entry is still ours.
- Clean up on unmount.
- Only where Back is not a close request: iOS/iPadOS WebKit (touch plus
  `GestureEvent`). Chromium keeps its CloseWatcher and never gets an entry.
- (d) is the alternative if no history entry is acceptable at all.
