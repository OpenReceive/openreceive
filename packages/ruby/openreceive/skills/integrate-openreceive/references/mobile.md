This is the full file; follow it from Step 0.

# OpenReceive agent directions (mobile apps)

```sh
# READ THIS FIRST: this file is 26 KB and a summary drops required steps. Download it whole:
curl -fsSL https://openreceive.org/agent-directions/mobile/full.md
# Skip the download only if you already have all of it: pasted, read from disk or fetched raw.
```

**Step 0 in brief** (Step 0 below has the details):

- Find the app's server first: OpenReceive runs there, and the app only opens its checkout page.
- Before installing or editing anything, ask the user for a receive-only NWC code. One question per message.
- Next ask for the LSC code. If the user wants stablecoins, USDT, USDC, ETH, SOL or crypto, do not ask yes/no first.
- Write each code into the server's env file yourself. Never into the app, its config or an EXPO_PUBLIC_ name.
- The app never decides paid: it asks the server. A link back to the app is navigation only.
- Do not suggest rotating or revoking a code because it was pasted here.

These directions describe OpenReceive 0.4.26.

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

---

## The quickstart, in full

Inlined verbatim so this file needs no network access. Steps 1 and 2 above say when to use each part: its server code is an example in Express, for the server's own stack.
The page it comes from is https://openreceive.org/guides/mobile-apps.

## Bitcoin checkout in mobile apps

OpenReceive has no mobile SDK, and an app does not need one. Your server keeps
the wallet code and creates each Lightning invoice. The app opens a checkout
page that your server serves, and the payer pays from their own wallet app. The
payment goes straight to your wallet. There is no OpenReceive account, no API
key and no processor in between.

Optional swaps let customers pay with **USDT, USDC, SOL, and ETH**. A swap
provider you configure converts the payment to **BTC over Lightning**, and it
settles into the same wallet. Available assets and networks depend on the
provider. Swaps run on the checkout page, so the app needs nothing extra for
them.

This guide covers React Native and Expo, Flutter, Swift and Kotlin apps. Before
you build, read [What the app stores allow](#what-the-app-stores-allow): what
you sell decides whether the app may take the payment at all.

### How it works

1. The app asks your server for a checkout link for one order, with the app's
   own sign-in.
2. Your server makes a one-time link to its checkout page for that order.
3. The app opens the link in a browser tab: Safari View Controller on iOS,
   Custom Tabs on Android.
4. The page swaps the one-time link for a cookie that lets this browser pay
   this order, and shows the checkout. The payer pays with Lightning, or with a
   swap.
5. Your server's `onPaid` hook marks the order paid when the wallet confirms the
   payment.
6. The payer comes back to the app, by closing the tab or with a link back. The
   app asks your server whether the order is paid.

Two rules hold throughout:

- **The wallet code never ships in the app.** `NWC_URI` and `LSC_URI_PRIMARY`
  live only in your server's environment. Anything inside an app package can be
  read by anyone who downloads it.
- **The app trusts only your server.** A link back to the app says the payer
  is done looking at the page, not that they paid. The order's paid state comes
  from your server, which `onPaid` updates inside the settlement transaction.

### What the app stores allow

Both stores make digital purchases go through their own billing, and both
exempt physical goods and real-world services. Bitcoin is no exception: Apple's
guideline 3.1.1 names "cryptocurrencies and cryptocurrency wallets" among the
mechanisms an app may not use to unlock content or features.

| What the payment is for | Apple (iOS) | Google Play | Checkout in the app |
| --- | --- | --- | --- |
| Physical goods, and services used outside the app (food, rides, tickets, lodging, bill pay) | Must not use in-app purchase (3.1.3(e)) | Must not use Play billing | Yes, every region |
| Real-time one-to-one services (tutoring, consultations, fitness training) | Other payment methods allowed (3.1.3(d)). One-to-few and one-to-many services must use in-app purchase | Not on Google's list of exceptions; check the policy | iOS yes; check Google first |
| A gift from one person to another | Allowed without in-app purchase if it is optional and 100% goes to the receiver. A gift tied to digital content must use in-app purchase (3.2.1(vii)) | Peer-to-peer payments must not use Play billing | Yes, with care |
| Donations | In the app only for Apple-approved nonprofits that also offer Apple Pay (3.2.1(vi)). Otherwise collect outside the app, such as in Safari (3.2.2(iv)) | Tax-exempt donations must not use Play billing | Android yes; iOS in Safari |
| Digital goods, subscriptions, unlocks, tips tied to content | In-app purchase, except through a link-out program below | Play billing, except through a program below | Only through a link-out program |

Sources: [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/),
[Google Play Payments policy](https://support.google.com/googleplay/android-developer/answer/9858738).

#### Digital goods: the link-out programs

Some storefronts let an app send the buyer to a website to pay for digital
goods. The store still takes a commission on those sales, and that commission
applies when the buyer pays in bitcoin too.

| Storefront | Apple | Google Play |
| --- | --- | --- |
| United States | No entitlement needed for buttons and links to the web (3.1.1(a)). A court barred Apple from charging a commission on these purchases in 2025. The appeals court has since said Apple may charge some commission, and the case is still before the courts ([Apple's 10-Q, June 2026](https://www.sec.gov/Archives/edgar/data/0000320193/000032019326000020/aapl-20260627.htm)) | [External content links program](https://support.google.com/googleplay/android-developer/answer/16470497): enroll first, then pay service fees; reporting and fees start October 1, 2026 |
| European Union | [Out-of-app offers](https://developer.apple.com/support/communication-and-promotion-of-offers-on-the-app-store-in-the-eu/): 15% commission (10% for small businesses and for subscriptions after their first year) from October 1, 2026 | [External offers program](https://support.google.com/googleplay/android-developer/answer/14372887): enroll first, then pay service fees |
| Japan | [Out-of-app offers](https://developer.apple.com/support/payment-options-on-the-app-store-in-japan/), iOS 26.2 or later: 15% (10%) | Not covered here |
| Brazil | [Out-of-app offers](https://developer.apple.com/support/payment-options-on-the-app-store-in-brazil), iOS 26.5 or later, buyers 18 or older: 15% (10%) | Not covered here |
| Everywhere else | In-app purchase only | Play billing only |

In the EU, Japan and Brazil, Apple's commission covers sales made within 7 days
of the link tap. The app must also offer in-app purchase on the same screen, at
least as prominently as the link, and show Apple's disclosure sheet before it
opens the browser. Open the link in the browser app, not a tab inside the app:
the Japan and Brazil terms say so. Kids-category apps may not link out to a
website at all.

The table is a summary of the stores' pages as of October 2026, and both
stores change these terms often. It is not legal advice. Read the linked pages
before you submit a build. We have not seen an App Store or Google Play review
decision about a Lightning checkout for physical goods, either way.

### Your server

The checkout page and the payment routes run on your server, from any
OpenReceive quickstart: [Express](https://openreceive.org/guides/quickstart-node.md),
[Fastify](https://openreceive.org/guides/quickstart-fastify.md), [Next.js](https://openreceive.org/guides/quickstart-next.md),
[NestJS](https://openreceive.org/guides/quickstart-nestjs.md), [Rails](https://openreceive.org/guides/quickstart-rails.md),
[FastAPI](https://openreceive.org/guides/quickstart-fastapi.md), [Django](https://openreceive.org/guides/quickstart-django.md),
[Flask](https://openreceive.org/guides/quickstart-flask.md), [PHP](https://openreceive.org/guides/quickstart-php.md) or
[Laravel](https://openreceive.org/guides/quickstart-laravel.md).

An app built on a backend-as-a-service has functions instead of a server.
On Supabase, see [Bitcoin checkout with Supabase](https://openreceive.org/guides/supabase.md). For function
hosts such as Vercel, Netlify, AWS Lambda and Cloud Run, see
[Bitcoin checkout on serverless hosts](https://openreceive.org/guides/serverless.md). An app whose only
database is Firestore needs a Postgres database for its payment records
(Supabase or Neon both have free plans), because OpenReceive stores them in
SQL.

### The checkout link

The app is signed in to your API, usually with a token. The browser tab the app
opens is not: it has no access to the app's token. So the server hands the app
a one-time link, and the page turns it into a cookie that only this order's
payer holds. OpenReceive mints no tokens. This code is yours.

With Express, after the [Express quickstart](https://openreceive.org/guides/quickstart-node.md), and
`cookie-parser` mounted:

```ts
import { createHash, randomBytes } from "node:crypto";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

// The app asks for a link to pay one of its user's orders.
app.post("/api/orders/:id/checkout-link", requireAppUser, async (req, res) => {
  const order = await orders.find(req.params.id);
  if (!order || order.userId !== req.user.id) return res.sendStatus(404);
  const once = randomBytes(32).toString("base64url");
  // Store only a hash, valid for ten minutes and for one use.
  await orders.saveLinkToken(order.id, hash(once), Date.now() + 10 * 60_000);
  res.json({ url: `https://shop.example.com/pay/${order.id}?t=${once}` });
});

// The browser tab opens the link. The one-time token becomes a cookie.
app.get("/pay/:id", async (req, res) => {
  const order = await orders.find(req.params.id);
  if (!order) return res.sendStatus(404);
  if (typeof req.query.t === "string") {
    // Consumes the token: a second visit with the same link gets nothing.
    if (!(await orders.useLinkToken(order.id, hash(req.query.t)))) return res.sendStatus(404);
    const buyer = randomBytes(32).toString("base64url");
    await orders.saveBuyer(order.id, hash(buyer));
    res.cookie(`pay_${order.id}`, buyer, { httpOnly: true, secure: true, sameSite: "lax" });
    return res.redirect(303, `/pay/${order.id}`); // the token leaves the address bar
  }
  res.send(checkoutPage(order.id)); // the HTML below
});
```

Then `authorize`, in the options you pass `openReceiveExpress`, lets in only
the browser that holds that order's cookie:

```ts
authorize: async ({ native, resource }) => {
  const buyer = native.cookies[`pay_${resource.reference}`];
  return typeof buyer === "string" && (await orders.buyerMatches(resource.reference, hash(buyer)));
},
```

The page is the [standalone checkout](https://openreceive.org/guides/frontend-checkout.md#without-a-bundler)
plus a way back to the app once the order is paid:

```html
<link rel="stylesheet" href="/static/openreceive/openreceive-checkout.css" />
<script type="module" src="/static/openreceive/openreceive-checkout.js"></script>

<openreceive-checkout id="checkout" reference="ord_123" prefix="/openreceive">
</openreceive-checkout>
<p id="done" hidden>Paid. <a href="myshop://orders/ord_123">Back to the app</a></p>
<script>
  document.getElementById("checkout").addEventListener("openreceive-settled", () => {
    document.getElementById("done").hidden = false;
  });
</script>
```

`myshop://` is the app's own URL scheme. A universal link (iOS) or App Link
(Android) works too, but only on a different domain from the checkout page:
iOS keeps a link to the page's own domain in the browser.

A React page works the same way with `<Checkout>` and its `onSettled` prop.
See [Frontend checkout](https://openreceive.org/guides/frontend-checkout.md).

### Open the checkout from the app

Each snippet asks the server for the link, opens it, and checks the order with
the server when the payer comes back. `api`, `token` and `fetchOrder` stand for
the app's own client code.

React Native with Expo (`expo-web-browser`):

```ts
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";

export async function pay(orderId: string) {
  const res = await fetch(`${api}/api/orders/${orderId}/checkout-link`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const { url } = await res.json();
  // Safari View Controller on iOS, Custom Tabs on Android. On iOS this
  // resolves when the payer closes it; on Android, as soon as it opens.
  await WebBrowser.openBrowserAsync(url);
}

// The "Back to the app" link: close the tab (iOS) and check the order.
Linking.addEventListener("url", ({ url }) => {
  const { path } = Linking.parse(url);
  if (path?.startsWith("orders/")) {
    WebBrowser.dismissBrowser();
    fetchOrder(path.slice("orders/".length));
  }
});
// Also check the order when the app returns to the foreground
// (AppState "active"), for a payer who closed the tab instead.
```

Flutter (`url_launcher`):

```dart
import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:url_launcher/url_launcher.dart';

Future<void> pay(String orderId) async {
  final res = await http.post(
    Uri.parse('$api/api/orders/$orderId/checkout-link'),
    headers: {'Authorization': 'Bearer $token'},
  );
  final url = Uri.parse(jsonDecode(res.body)['url'] as String);
  // Custom Tabs on Android, Safari View Controller on iOS.
  await launchUrl(url, mode: LaunchMode.inAppBrowserView);
}
// Check the order when the app resumes (a WidgetsBindingObserver's
// didChangeAppLifecycleState) and when myshop://orders/<id> arrives.
```

Swift (`SafariServices`):

```swift
import SafariServices

final class PayController: NSObject, SFSafariViewControllerDelegate {
  func pay(orderId: String, from presenter: UIViewController) async throws {
    var request = URLRequest(url: api.appending(path: "api/orders/\(orderId)/checkout-link"))
    request.httpMethod = "POST"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    let (data, _) = try await URLSession.shared.data(for: request)
    let link = try JSONDecoder().decode(CheckoutLink.self, from: data)
    let safari = SFSafariViewController(url: link.url)
    safari.delegate = self
    presenter.present(safari, animated: true)
  }

  // The payer closed the tab: ask the server whether the order is paid.
  func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
    Task { await fetchOrder() }
  }
}

struct CheckoutLink: Decodable { let url: URL }
```

Kotlin (`androidx.browser`):

```kotlin
import androidx.browser.customtabs.CustomTabsIntent

suspend fun pay(activity: Activity, orderId: String) {
  val url = api.checkoutLink(orderId) // POST /api/orders/{id}/checkout-link with the app's token
  CustomTabsIntent.Builder().build().launchUrl(activity, Uri.parse(url))
}

// In the activity: the payer is back, so ask the server.
override fun onResume() {
  super.onResume()
  viewModel.refreshOrder()
}
```

For a digital purchase in a link-out program, open the link in the browser app
instead, through the store's own API: Apple's `ExternalPurchaseCustomLink` in the
EU, Japan and Brazil, a plain link in the US storefront, and Google's external
links APIs once enrolled. See the links in
[the program table](#digital-goods-the-link-out-programs).

### What not to do

- Do not build the payment into a native screen with a swap picker. The swap
  flow, its refund screens and its way back belong on the checkout page.
- Do not decide "paid" in the app, from a link back, a timer or the page's
  contents. Ask your server.
- Do not reuse a checkout link. Make a new one each time the app opens the
  page; the cookie keeps a payer who reloads the page in.
- Do not sell digital goods through the checkout outside the link-out
  programs. A build that does is likely to be rejected.

To test the server side before you ship the app, see
[Testing your OpenReceive integration](https://openreceive.org/guides/host-testing.md).
