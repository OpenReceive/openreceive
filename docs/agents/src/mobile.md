# OpenReceive agent directions (mobile apps)

Add Bitcoin checkout, with optional USDT, USDC, ETH and SOL, to a mobile app:
React Native or Expo, Flutter, Swift or Kotlin. OpenReceive has no mobile SDK
and an app does not need one. OpenReceive runs on the app's server, which keeps
the wallet code and serves a checkout page. The app opens that page in a
browser tab and asks its server whether the order is paid. The mobile apps
guide is appended to this file in full.

So this is two jobs: add OpenReceive to the app's server with that server's
own agent directions, then make the app open the checkout and read the result.
Do not install `@openreceive/*` packages into the app itself, and do not build
a native payment screen.

## Step 0 — what the app sells, where its server is, and the two codes

1. **What does the app sell?** Read the app's product, cart and order code.
   Physical goods, and services used outside the app (food, rides, tickets,
   lodging), may be paid this way in every region. Digital goods, subscriptions, unlocks, and
   tips tied to content must use the store's in-app purchase, except through a
   link-out program (the guide's "What the app stores allow" below). If the app
   sells digital goods, stop and tell the user that, with that section's table,
   before you build anything. Go on only if they say a link-out program covers
   them.
2. **Find the app's server.** The app's API base URL (in its config, its env,
   or its API client) names it. It may be in this workspace (a `server/`,
   `api/` or `backend/` folder) or in another project. Name its stack, and the
   directions that go with it. For Express they are
   https://openreceive.org/agent-directions/node/full.md, and for another stack
   put its name in place of `node`: `fastify`, `next`, `nestjs`, `fastapi`,
   `django`, `flask`, `rails`, `php`, `laravel`, `sveltekit`, `nuxt`,
   `astro`, `react-router` or `tanstack-start`.
   - **The server is not in this workspace.** OpenReceive is added there, by
     whoever edits it. Tell the user so, give them that URL for the agent that
     edits the server, and stop. Come back for Step 2 once the server serves
     the checkout link.
   - **The app has no server of its own,** only Supabase or Firebase. OpenReceive
     needs one, with a Postgres database: Supabase's, or a new one for a
     Firestore app. Ask the user which stack to add, suggest one in a language
     the team already uses, and add it in this workspace.

   Do not edit the app or the server yet.

Then your next action is a question to the user. Do not search the app, the
server, deploy config, Docker containers or process environments for a code,
and never run `printenv`: a new shop has none, and hunting for one can leak
other secrets into the transcript. If the server's env file already sets
them, `grep -E '^(NWC_URI|LSC_URI_PRIMARY)=.' <file> | cut -d= -f1` names the
ones it sets without printing them; a code that is set is not asked for again.

Two codes are needed, and both live only in the server's environment:

- `NWC_URI`: a receive-only Nostr Wallet Connect code,
  `nostr+walletconnect://…`. Required for Bitcoin.
- `LSC_URI_PRIMARY`: a Lightning Swap Connect URI,
  `lightning+swapconnect://…`. Required for USDT, USDC, ETH and SOL. Skip it
  only when the user says they want Bitcoin alone.

Never put either in the app: not in its code, `app.json`, `Info.plist`, a
`BuildConfig` field, a bundled `.env`, or any `EXPO_PUBLIC_` name. Anyone who
downloads an app can read what it ships with.

The user never edits an environment file. They paste each code into this chat;
you store it. Ask one question per message.

1. **First message — the NWC code, and nothing else.** Ask for it and walk them
   through getting it:

   > To receive payments I need a receive-only wallet code. In Rizful: open
   > the menu, tap NWC, choose Receive-only NWC code, and tap Copy
   > (https://openreceive.org/get_a_nwc_code_to_receive_payments). If you would
   > rather run your own wallet, Alby Hub works too: Connections → Add
   > Connection → Read Only. Paste the code here and I will store it.

2. **When they paste it.** If it does not start with `nostr+walletconnect://`,
   ask them to copy the receive-only code again. Otherwise write
   `NWC_URI=<paste>` into the server's env file with your file-editing tool:
   `.env.local` in a Next.js server, `.env` in the server's root for every
   other stack. Never write it with a shell command, which shows the code.
   Make sure `.gitignore` covers the file. Never echo the value. Reply only
   that it is saved, then ask the next question.
3. **Second message — swaps.** If the user asked for stablecoins, USDT, USDC,
   ETH, SOL, altcoins or "crypto", this message IS the walkthrough below: send
   it as it is, and do not ask yes or no first. Otherwise ask whether payers
   should also be able to pay with USDT, USDC, ETH or SOL, then give the
   walkthrough:

   > Go to https://lightning-swap.com, sign in for API keys, create a key, and
   > copy the whole URI (https://openreceive.org/set_up_swap_provider). Paste
   > it here and I will store it — or say "Bitcoin only" and I will continue
   > without it.

4. **When they paste it.** If it does not start with
   `lightning+swapconnect://`, ask them to copy it again. Otherwise add
   `LSC_URI_PRIMARY=<paste>` to the same file, the same way. Swaps run on the
   checkout page, so the app needs nothing more for them.

## Step 1 — the server

Download the server's directions with your shell and follow them, from the
rest of their Step 0 (loading the env file, restarting) through their
quickstart and hand-over checks. The two codes are already saved, so skip
their questions. Their checkout page, in a desktop browser, comes first.

Then add the mobile half, from the guide's "The checkout link" below, in that
stack's own idiom. The guide's code is Express; translate it:

- A route the app calls with its own sign-in, which returns a one-time link to
  the checkout page for one of that user's orders. Store only a hash of the
  link's token, for ten minutes and one use.
- The page route: it consumes the token, sets an HttpOnly cookie for that
  order's payer, redirects to itself without the token, and serves the
  checkout, plus a link back to the app once it settles.
- `authorize` also lets in the browser that holds that order's cookie. If the
  server serves a website too, keep its own check: either one passes.

## Step 2 — the app

Add the guide's snippet for the app's platform, from "Open the checkout from
the app" below: ask the server for the link, open it in a browser tab
(`expo-web-browser`, `url_launcher` in `inAppBrowserView`,
`SFSafariViewController`, or Custom Tabs), and ask the server for the order
when the payer comes back: by the link back, by closing the tab, or by
returning the app to the foreground. If the app has no URL scheme for the link
back, add one.

## After the integration — hand over, then stop

The server side is done when its directions' checks pass, the checkout-link
route answers for a signed-in user's order, the link opens the checkout in a
desktop browser, and the same link answers 404 the second time. The app side
is done when it builds and its pay action opens the page.

You cannot pay the invoice: the code is receive-only. Do not pay, settle or
mark an order paid, and do not look for a way to. In one line of your closing
message, give the user the real check: on a phone, pay a small order from
their own wallet, come back to the app, and see the order shown as paid. Then
stop.

## Non-negotiables

- Do not suggest rotating, revoking or replacing a code because it was pasted
  into this chat; that is the supported path.
- The codes live only in the server's environment, never in the app or its
  build config.
- The app never decides "paid", from a link back, a timer or the page's
  contents. It asks the server, which `onPaid` updates when the payment
  settles.
- No native checkout screen, swap picker or wallet list in the app. The
  checkout, its swap screens and its refund way back belong on the page.
- A new one-time link each time the app opens the page; never reuse one.
- No digital goods through the checkout outside a store's link-out program.

## More documentation

Fetch one when the moment comes. Each is raw markdown, so a plain GET is
enough; drop the `.md` for the same page a person would read.

- https://openreceive.org/guides/authorization.md — how `authorize` sees the request, before you add the cookie check
- https://openreceive.org/guides/frontend-checkout.md — the checkout page's element and React component, and their settled event
- https://openreceive.org/guides/supabase.md — when the database is Supabase
- https://openreceive.org/guides/serverless.md — when the server is a function host: Vercel, Netlify, AWS Lambda, Cloud Run
- https://openreceive.org/guides/swap-refunds.md — the refund flow on the page, before you turn swaps on
- https://openreceive.org/guides/lightning-swap-connect.md — what an `LSC_URI_*` code actually is
- https://openreceive.org/guides/security.md and https://openreceive.org/guides/deploying.md — before this goes anywhere real
- https://openreceive.org/guides.md — the index, if what you need is not above

Questions, or a problem with the library itself:
https://openreceive.org/contact
