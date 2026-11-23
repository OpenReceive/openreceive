# Android Chrome lab

Payer journeys on a real Chrome for Android, in an emulator, against the Buy a
Button shop in testkit wallet mode. No real wallet is involved: the demo runs
with `DEMO_WALLET=testkit`, and the journeys settle invoices and step swaps
through its `/__testkit` control routes.

Desktop Playwright and the trial harness's emulated phones cannot show what
these journeys show: Android's own touch and keyboard input, Gboard covering
half the screen, the system clipboard and its overlay, Chrome's toolbar
hiding as the page scrolls, Android BACK, an app switch to a wallet and back,
rotation, the system font size, and dark theme.

## How it works

- `Dockerfile` builds an image with the Android SDK, the emulator, and a
  `google_apis` x86_64 system image, all from dl.google.com through
  `sdkmanager`. `google_apis` is a userdebug build with Chrome preinstalled and
  reads `/data/local/tmp/chrome-command-line`, which is how the lab names
  Chrome's DevTools socket. The Play Store images do not read it.
- `start.sh` boots the emulator headless (`-no-window`, SwiftShader) in a
  container on the host network, with `/dev/kvm`. On the device,
  `http://localhost:4173` is the host's demo (`adb reverse`), so the page is a
  secure context like an https shop.
- `run-journeys.mjs` starts Chrome by an intent, as a payer's Chrome runs, and
  attaches Playwright over Chrome's DevTools socket. Playwright only observes:
  locators, rects, requests, the console. Every touch goes through Android's
  input pipeline: `input tap` and long-press at the element's screen position,
  `input text` into the focused field with Gboard up, BACK and HOME key events,
  `cmd window user-rotation`, the font scale and dark theme settings. A probe
  in the page reads back each `pointerdown`, so a tap that lands on the wrong
  element is reported, never replaced with a synthetic click.
- While the payer is "in their wallet app", the script detaches from Chrome.
  With a DevTools client attached, Chrome keeps a backgrounded tab visible and
  its timers at full speed, which a payer's phone does not do. This is also
  why the lab does not use Playwright's `_android.launchBrowser()`: it stays
  attached the whole time.
- Playwright emulates `prefers-color-scheme: light` on every page it attaches
  to. The script clears that (`page.emulateMedia({ colorScheme: null })`) so
  the page sees the phone's dark theme.
- Finger drags are `input motionevent` DOWN, MOVEs, a rest, UP. A fast
  `input swipe` flings (the page keeps scrolling after the measurement) and
  does not trigger pull-to-refresh.

## Run it

```sh
npm ci && npm run build:packages     # a stale dist fails the demo boot

# 1. The testkit demo on the host (as tests/e2e/playwright.config.ts boots it).
cd examples/buttons/server/node-express
DEMO_WALLET=testkit OPENRECEIVE_DEMO_DB="$(mktemp -d)" \
  npx vite --host 127.0.0.1 --port 4273 --strictPort --configLoader runner &
cd -

# 2. The emulator. The first run builds the image (about 2.5 minutes, 5.4 GB).
tests/android/start.sh                 # API 35, Chrome 124
API_LEVEL=36 tests/android/start.sh    # or API 36, Chrome 133, in its place

# 3. The journeys. Screenshots and report.json land in
#    tests/android/results/<time>-adb<port>-<tab>/.
node tests/android/run-journeys.mjs
JOURNEYS=lightning,phone node tests/android/run-journeys.mjs
FRAMEWORK=Vue node tests/android/run-journeys.mjs
IN_WALLET_MS=360000 JOURNEYS=wallet-late node tests/android/run-journeys.mjs
# The API 36 device, started with its own ports:
#   API_LEVEL=36 ANDROID_LAB_CONTAINER=openreceive-android-lab-36 \
#     ADB_PORT=15038 EMU_PORT=5656 CDP_PORT=15223 tests/android/start.sh
ADB_PORT=15038 CDP_PORT=15223 node tests/android/run-journeys.mjs

tests/android/start.sh stop
```

Port 4273 keeps the demo off 4173, where `tests/e2e` reuses any server it
finds. Every port is an environment variable (see `start.sh`). Two
emulators (API 35 and 36) run side by side on different ports.

Timings on a 24-core host with KVM: the image builds in about 2.5 minutes
(once), the emulator boots in 35 to 50 s, and the whole run takes about 5
minutes, two of them in the wallet journeys' 60 s trips to the home screen
(`IN_WALLET_MS` sets the trip). The script prints every problem it finds and
writes them to report.json; it exits 0 either way, because it is a lab for
looking, not a gate.

## Journeys

| Journey | What the payer does |
| --- | --- |
| `lightning` | Buys a button, picks Bitcoin, taps Copy invoice, and pastes it back with long-press and Paste. Checks the QR, the amount, sideways scroll, and layout shifts. |
| `wallet` | Presses HOME on the invoice, pays at once, comes back 60 s later from the launcher icon. |
| `wallet-late` | The same, paying just before coming back. |
| `swap` | USDT on Solana, then a refund address typed with Gboard: is the button above the keyboard, and does the address survive landscape and back? Then review and confirm the refund by touch. |
| `swap-paid` | USDT on Solana stepped to confirming, completed and settled. |
| `big-text-dark` | Font size 1.3 and dark theme set before Chrome opens: the grid, the invoice and the deposit screen, with a contrast check. |
| `back-reload` | Pull-to-refresh and Android BACK on the invoice, then Chrome's own Forward: the same invoice, and no second one. |
| `phone` | Tap sizes, cut-off text, the How To Pay walkthrough, and Android BACK with it open. |

## Limits

- The images' Chrome does not update (no Play Store): API 35 has Chrome 124,
  API 36 has Chrome 133. A payer's phone usually runs a newer Chrome. A
  finding seen only on the older Chrome is still real for phones that do not
  update and for browsers built on that Chromium, but it is worth checking
  on API 36 first.
- SwiftShader draws slowly. The screen trails the DOM by a few hundred ms, so
  every screenshot waits for the frame to settle.
- `pm clear` gives each run a clean Chrome profile.
