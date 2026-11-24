# iOS Safari lab

Payer journeys in real Safari on the iOS simulator, against the Buy a Button
shop in testkit wallet mode, and against the browser lab's fault pages. No
real wallet is involved: the demo runs with `DEMO_WALLET=testkit`, and the
journeys settle invoices and step swaps through its `/__testkit` control
routes. The iOS twin of `tests/android/`.

Desktop Playwright WebKit cannot show what these journeys show: iOS's
software keyboard covering the page and Safari scrolling the focused field
above it, the keyboard's auto-capitalization, Safari's floating address bar
(full and minimized) over the page and its touch area, the edge-swipe Back,
Safari's reload button and pull-to-refresh, an app switch with Safari
suspended behind another app, rotation, Dynamic Type and dark appearance, and
the iOS pasteboard.

## How it works

- **Touch: Appium's XCUITest driver.** WebDriverAgent sends every touch a
  payer makes through XCTest: taps, long presses, finger drags, the edge
  swipe, Safari's reload button, keys on the software keyboard, app switches,
  rotation. The page receives them as `pointerType: "touch"`. The Appium
  session is native, on Safari's bundle id; it never attaches to the web
  content.
- **Observing: Safari's Web Inspector socket**, through
  `appium-remote-debugger`, as exrails' `script/offline-tests/run-ios-sim.mjs`
  does. It reads the DOM, rects, the console and the network, and never
  clicks. A probe in the page (`page-probes.mjs`) reads back every
  `pointerdown`, so a tap that lands on the wrong element is reported, never
  replaced with a scripted click. The Inspector has no init scripts, so the
  probe goes in after each page load.
- **Aiming.** Taps aim at Safari's accessibility rect for the element when
  Safari names it (`webElements` in `ios-device.mjs`), else at the page's own
  geometry mapped to the screen by a calibration tap. While the keyboard
  opens, Safari reports `visualViewport` numbers mid-animation (an
  `offsetTop` of 188 for a button that is on screen at y 207); the
  accessibility rects stay right.
- **Scrolling** is real finger drags. Safari keeps scrolling after a drag
  even when the finger rests before lifting (a 200 pt drag moves the page
  300 to 500 pt), so `swipeIntoView` learns the ratio as it goes. A
  remaining nudge under 12 pt is a scripted `scrollBy`.
- **The probe needs the page's own listeners.** Listeners the Inspector
  adds after load get no touches on a page that has none of its own (a
  plain page received no `pointerdown` or `touchstart` at all). The demo has
  React's root listeners; the fault pages carry the probe inline in `<head>`.
- **Typing.** XCTest's `typeText` types exact characters into the field and
  skips the keyboard's shift state, so it cannot show auto-capitalization.
  The `refund-typing` journey taps the first letter on the keyboard itself.
- **Away in another app**, the Inspector disconnects (as the Android lab
  detaches DevTools), Photos comes to the front (`mobile: activateApp`), and
  Safari comes back the same way. A 1 s timer in the page counts the ticks
  it got while hidden.
- `simctl` does the rest: screenshots, `pbcopy`/`pbpaste` (the pasteboard
  check), `ui appearance`, `ui content_size`, `openurl`.
- **No safaridriver.** `safaridriver` with `safari:useSimulator` insists on
  launching Simulator.app, and Xcode 27.2 on this Mac ships without it
  (`Contents/Developer/Applications` is absent); the simulators run headless.
  Where Simulator.app exists, WebDriver through safaridriver would put Safari
  in its automation mode, which a payer's Safari never is.

## Run it

```sh
npm ci && npm run build:packages             # a stale dist fails the demo boot
(cd tests/ios && npm install)                # appium, appium-remote-debugger (local, not global)
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
(cd tests/ios && APPIUM_HOME=$PWD/.appium npx appium driver install xcuitest)   # once

# 1. The testkit demo (as tests/e2e/playwright.config.ts boots it).
cd examples/buttons/server/node-express
DEMO_WALLET=testkit OPENRECEIVE_DEMO_DB="$(mktemp -d)" \
  npx vite --host 127.0.0.1 --port 4273 --strictPort --configLoader runner &
cd -

# 2. A simulator with the software keyboard (no hardware keyboard), booted.
xcrun simctl create "OR Lab SE" com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation \
  com.apple.CoreSimulator.SimRuntime.iOS-27-2
defaults write com.apple.iphonesimulator DevicePreferences -dict-add <udid> \
  '{ConnectHardwareKeyboard = 0; ConnectHardwareKeyboardInitial = 0;}'
xcrun simctl boot <udid>

# 3. Appium (its own home inside tests/ios), then the journeys. The first
#    session builds WebDriverAgent (a few minutes).
(cd tests/ios && APPIUM_HOME=$PWD/.appium npx appium --address 127.0.0.1 --port 4723) &
IOS_UDID=<udid> node tests/ios/run-journeys.mjs
IOS_UDID=<udid> JOURNEYS=lightning,refund-typing node tests/ios/run-journeys.mjs
IOS_UDID=<udid> FRAMEWORK=Vue node tests/ios/run-journeys.mjs
IOS_UDID=<udid> node --import tsx tests/ios/run-faults.mjs
# A second simulator at the same time needs its own WebDriverAgent port:
WDA_PORT=8110 IOS_UDID=<udid2> SKIP_ROTATE=1 node tests/ios/run-journeys.mjs
```

Screenshots and `report.json` land in
`tests/ios/results/<time>-<device>-ios<version>-<tab>/` (git-ignored). The
scripts print every problem they find and exit 0 either way: a lab for
looking, not a gate. Port 4273 keeps the demo off 4173, where `tests/e2e`
reuses any server it finds.

## Journeys

| Journey | What the payer does |
| --- | --- |
| `lightning` | Buys a button, picks Bitcoin, taps Copy invoice (checked with `simctl pbpaste`), and is paid. QR, amount, sideways scroll, controls moving as the countdown ticks. |
| `swap` | USDT on Solana, Continue, one amount on the deposit screen, then the refund address typed on the software keyboard: is Review above the keyboard, does the address survive landscape and back, review and confirm by touch. |
| `swap-paid` | USDT on Solana stepped to confirming and completed, settled, and Safari's reload button pressed at once: the receipt, never the deposit address. |
| `refund-typing` | A Solana refund address starting with a lowercase letter, its first letter tapped on the keyboard; which rows of "Review refund address" take a tap with the keyboard up; the payer's tap on its middle. |
| `tutorial` | Tap sizes, cut-off text, "How To Pay", and the edge-swipe Back with the walkthrough open, then a swipe from the right edge. |
| `reload` | Safari's reload button and pull-to-refresh on the invoice (the same invoice, no second one), then reload right after paying. |
| `wallet` / `wallet-long` | Photos in front with the invoice open, paid 3 s later, Safari back after 60 s / 6 minutes (`IN_WALLET_MS`, `LONG_WALLET_MS`). |
| `layout` | Safari's bar shrinking and coming back while scrolling, what sits under it at the bottom of the page, landscape. |
| `big-text-dark` | The largest Dynamic Type size and dark appearance before the shop opens: the grid, the invoice, the deposit screen, contrast. |

`run-faults.mjs` serves the checkout from `createLab()` and, for the element
and React's checkout: a POST /checkouts that never answers, a proxy's 502 on
it, a 10 s wallet scan while the invoice is paid, a 502, a 504 and a captive
portal on the status poll, a status poll that never answers, and Safari's
reload button while Continue says "Preparing payment".

## Limits

- The simulator does not suspend or discard a page the way an iPhone does
  after hours, and has no radio; it shares the Mac's network.
- It offers no Low Power Mode switch.
- On the iPhone 16 Pro simulator, a rotation to landscape and back left the
  lab's touches missing the page for the rest of the run (a new Appium
  session and a new Inspector did not help; a new run did). `SKIP_ROTATE=1`
  leaves the landscape steps out; landscape is measured on the SE.
- Only the runtimes Xcode has installed: iOS 27.2 and 18.4 here (no 17.x).
- A simulator process that crashes on first boot can put a macOS crash
  dialog on the Mac's screen (seen with PosterBoard in exrails).
