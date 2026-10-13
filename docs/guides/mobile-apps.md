# Bitcoin checkout in mobile apps

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

## How it works

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

## What the app stores allow

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

### Digital goods: the link-out programs

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

## Your server

The checkout page and the payment routes run on your server, from any
OpenReceive quickstart: [Express](quickstart-node.md),
[Fastify](quickstart-fastify.md), [Next.js](quickstart-next.md),
[Rails](quickstart-rails.md), [FastAPI](quickstart-fastapi.md),
[Django](quickstart-django.md), [Flask](../recipes/flask.md),
[PHP](quickstart-php.md) or [Laravel](quickstart-laravel.md).

An app built on a backend-as-a-service has functions instead of a server.
On Supabase, see [Bitcoin checkout with Supabase](supabase.md). For function
hosts such as Vercel, Netlify, AWS Lambda and Cloud Run, see
[Bitcoin checkout on serverless hosts](serverless.md). An app whose only
database is Firestore needs a Postgres database for its payment records
(Supabase or Neon both have free plans), because OpenReceive stores them in
SQL.

## The checkout link

The app is signed in to your API, usually with a token. The browser tab the app
opens is not: it has no access to the app's token. So the server hands the app
a one-time link, and the page turns it into a cookie that only this order's
payer holds. OpenReceive mints no tokens. This code is yours.

With Express, after the [Express quickstart](quickstart-node.md), and
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

The page is the [standalone checkout](frontend-checkout.md#without-a-bundler)
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
See [Frontend checkout](frontend-checkout.md).

## Open the checkout from the app

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

## What not to do

- Do not build the payment into a native screen with a swap picker. The swap
  flow, its refund screens and its way back belong on the checkout page.
- Do not decide "paid" in the app, from a link back, a timer or the page's
  contents. Ask your server.
- Do not reuse a checkout link. Make a new one each time the app opens the
  page; the cookie keeps a payer who reloads the page in.
- Do not sell digital goods through the checkout outside the link-out
  programs. A build that does is likely to be rejected.

To test the server side before you ship the app, see
[Testing your OpenReceive integration](host-testing.md).
