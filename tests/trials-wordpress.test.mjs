import assert from "node:assert/strict";
import test from "node:test";
import {
  attributes,
  buyerAnswerChecks,
  CookieJar,
  checkoutElement,
  decodeHtml,
  eddCheckoutUrl,
  eddGateways,
  findForm,
  formFields,
  linkHref,
  orderNumber,
  routeOf,
  storeApiNonce,
  submitButton,
  swapMethods,
  textOf,
  wcSettings,
  wooCheckoutMethods,
  wooCheckoutUrl,
} from "../trials/harness/wordpress.ts";

// What the 0.4.32 plugin prints on WooCommerce's order-pay page (Gateway::receipt_page).
const ORDER_PAY = `<meta name="csrf-token" content="63a3f4c662">
<openreceive-checkout resumable="true" reference="18" prefix="http://127.0.0.1:46337/wp-json/openreceive/v1" csrf-header="X-WP-Nonce" resume-payment-hash="${"a".repeat(64)}" resume-payment-rail="lightning" data-thank-you="http://127.0.0.1:46337/checkout/order-received/18/?key=wc_order_Dvv7b&#038;x=1"></openreceive-checkout>`;

// The shape of a block page's settings: URL-encoded JSON inside JSON.parse(decodeURIComponent('…')).
function blockPage(settings) {
  return `<div class="wp-block-woocommerce-checkout"></div><script>
var wcSettings = JSON.parse( decodeURIComponent( '${encodeURIComponent(JSON.stringify(settings))}' ) );
</script>`;
}

test("decodeHtml reads the entities WordPress escapes", () => {
  assert.equal(decodeHtml("a&#038;b&amp;c&#x27;d&quot;e"), "a&b&c'd\"e");
  assert.equal(
    decodeHtml("&#036;7.00&nbsp;&ndash;&nbsp;Purchase"),
    "$7.00\u00a0\u2013\u00a0Purchase",
  );
  assert.equal(decodeHtml("&unknown; stays"), "&unknown; stays");
});

test("attributes lowercases names, decodes values and keeps bare ones", () => {
  const found = attributes(
    `<input TYPE="radio" name='payment-mode' value=openreceive checked data-x="a&#038;b" />`,
  );
  assert.equal(found.get("type"), "radio");
  assert.equal(found.get("name"), "payment-mode");
  assert.equal(found.get("value"), "openreceive");
  assert.equal(found.get("checked"), "");
  assert.equal(found.get("data-x"), "a&b");
  assert.equal(found.has("input"), false);
});

test("checkoutElement reads the order page's checkout as the element does", () => {
  const element = checkoutElement(ORDER_PAY);
  assert.deepEqual(element, {
    reference: "18",
    prefix: "http://127.0.0.1:46337/wp-json/openreceive/v1",
    csrfHeader: "X-WP-Nonce",
    resumePaymentHash: "a".repeat(64),
    resumePaymentRail: "lightning",
    thankYou: "http://127.0.0.1:46337/checkout/order-received/18/?key=wc_order_Dvv7b&x=1",
  });
  // EDD's confirmation page before any invoice: no resume attributes.
  const edd = checkoutElement(
    `<div class="openreceive-edd-checkout"><openreceive-checkout resumable="true" reference="edd-2" prefix="http://shop/?rest_route=/openreceive/v1" csrf-header="X-WP-Nonce"></openreceive-checkout></div>`,
  );
  assert.equal(edd?.reference, "edd-2");
  assert.equal(edd?.prefix, "http://shop/?rest_route=/openreceive/v1");
  assert.equal(edd?.resumePaymentHash, undefined);
  assert.equal(checkoutElement("<p>Thank you.</p>"), undefined);
  assert.equal(
    checkoutElement(`<openreceive-checkout reference=""></openreceive-checkout>`),
    undefined,
  );
});

test("findForm and formFields send what a browser sends without a click", () => {
  const page = `<form role="search" action="/"><input name="s"></form>
<form id="edd_purchase_form" class="edd_form" action="http://shop/checkout/?payment-mode=openreceive&#038;a=1" method="POST">
  <input type="text" name="edd_email" id="edd-email" value="" required />
  <input
    type="hidden" name="edd_action" value="purchase"/>
  <input type="hidden" name="edd-gateway" value="openreceive" />
  <input type="checkbox" name="edd_agree_to_terms" value="1" />
  <input type="checkbox" name="newsletter" checked />
  <input type="text" name="locked" value="x" disabled />
  <input type="submit" id="edd-purchase-button" name="edd-purchase" value="Purchase"/>
</form>`;
  const form = findForm(page, /id="edd_purchase_form"/);
  assert.equal(form?.action, "http://shop/checkout/?payment-mode=openreceive&a=1");
  assert.deepEqual(
    [...(form?.fields ?? [])],
    [
      ["edd_email", ""],
      ["edd_action", "purchase"],
      ["edd-gateway", "openreceive"],
      ["newsletter", "on"],
    ],
  );
  assert.deepEqual(submitButton(form?.html ?? "", "edd-purchase"), {
    name: "edd-purchase",
    value: "Purchase",
  });
  assert.equal(findForm(page, /id="nothing"/), undefined);
  assert.deepEqual([...formFields(`<input name="q" value="a&amp;b">`)], [["q", "a&b"]]);
});

test("submitButton finds WooCommerce's Add to cart button and its product id", () => {
  const form = `<form class="cart" action="http://shop/product/facet/" method="post">
<input type="number" name="quantity" value="1" />
<button type="submit" name="add-to-cart" value="10" class="single_add_to_cart_button">Add to cart</button>
</form>`;
  assert.deepEqual(submitButton(form, "add-to-cart"), { name: "add-to-cart", value: "10" });
  assert.equal(
    submitButton(`<button type="button" name="add-to-cart" value="10">`, "add-to-cart"),
    undefined,
  );
  assert.equal(findForm(form, /\bclass="[^"]*\bcart\b/i)?.fields.get("quantity"), "1");
});

test("wooCheckoutMethods reads a block checkout's methods from wcSettings", () => {
  const page = blockPage({
    paymentMethodData: {
      openreceive: { title: "Bitcoin & stablecoins (OpenReceive)", supports: ["products"] },
      cod: { title: "Cash" },
    },
    storePages: { checkout: { permalink: "http://shop/checkout/" } },
  });
  assert.deepEqual(wooCheckoutMethods(page), {
    checkout: "block",
    methods: ["openreceive", "cod"],
    title: "Bitcoin & stablecoins (OpenReceive)",
  });
  assert.equal(wcSettings(page)?.storePages?.checkout?.permalink, "http://shop/checkout/");
  assert.equal(wooCheckoutUrl(page), "http://shop/checkout/");
  assert.deepEqual(wooCheckoutMethods(blockPage({ paymentMethodData: {} })), {
    checkout: "block",
    methods: [],
  });
  assert.deepEqual(wooCheckoutMethods("<p>no settings</p>"), { checkout: "none", methods: [] });
  assert.equal(
    wcSettings("var wcSettings = JSON.parse( decodeURIComponent( '%7Bbroken' ) );"),
    undefined,
  );
});

test("wooCheckoutMethods reads a classic checkout's payment_method radios", () => {
  const page = `<form name="checkout" class="checkout woocommerce-checkout">
<input type="hidden" id="woocommerce-process-checkout-nonce" name="woocommerce-process-checkout-nonce" value="abc" />
<ul class="wc_payment_methods">
<li><input id="payment_method_bacs" type="radio" class="input-radio" name="payment_method" value="bacs" />
<label for="payment_method_bacs">Bank transfer</label></li>
<li><input id="payment_method_openreceive" type="radio" class="input-radio" name="payment_method" value="openreceive" checked='checked' />
<label for="payment_method_openreceive">Bitcoin &amp; stablecoins (OpenReceive) </label></li>
</ul></form>`;
  assert.deepEqual(wooCheckoutMethods(page), {
    checkout: "classic",
    methods: ["bacs", "openreceive"],
    title: "Bitcoin & stablecoins (OpenReceive)",
  });
  assert.equal(
    wooCheckoutUrl(
      `<a href="http://shop/checkout/" class="checkout-button button alt wc-forward">`,
    ),
    "http://shop/checkout/",
  );
});

test("storeApiNonce reads the block middleware's nonce", () => {
  assert.equal(
    storeApiNonce(
      `var wcBlocksMiddlewareConfig = {\n\tstoreApiNonce: '008fc2096a',\n\twcStoreApiNonceTimestamp: '1794097424'\n};`,
    ),
    "008fc2096a",
  );
  assert.equal(storeApiNonce(`{"storeApiNonce":"0a1b2c"}`), "0a1b2c");
  assert.equal(storeApiNonce("<p></p>"), undefined);
});

test("eddGateways lists the radios and the purchase form's selected gateway", () => {
  const one = `<form id="edd_purchase_form" action="/checkout/"><input type="hidden" name="edd-gateway" value="openreceive" /></form>`;
  assert.deepEqual(eddGateways(one), { selected: "openreceive", offered: ["openreceive"] });
  const several = `<div id="edd_payment_mode_select">
<input type="radio" name="payment-mode" class="edd-gateway" id="edd-gateway-manual" value="manual" checked="checked">
<input type="radio" name="payment-mode" class="edd-gateway" id="edd-gateway-openreceive" value="openreceive">
</div><form id="edd_purchase_form"><input type="hidden" name="edd-gateway" value="manual" /></form>`;
  assert.deepEqual(eddGateways(several), {
    selected: "manual",
    offered: ["manual", "openreceive"],
  });
  assert.deepEqual(eddGateways("<p>Your cart is empty.</p>"), { selected: undefined, offered: [] });
});

test("eddCheckoutUrl follows the Checkout button, else EDD's globals", () => {
  assert.equal(
    eddCheckoutUrl(
      `<a href="http://shop/checkout/" class="edd_go_to_checkout button blue edd-submit" >`,
    ),
    "http://shop/checkout/",
  );
  assert.equal(
    eddCheckoutUrl(
      `var edd_scripts = {"checkout_page":"http:\\/\\/shop\\/checkout\\/","permalinks":"1"};`,
    ),
    "http://shop/checkout/",
  );
  assert.equal(eddCheckoutUrl("<p></p>"), undefined);
  assert.equal(
    linkHref(`<a class="x" href="/a"><a class="wc-forward" href="/cart/">`, /wc-forward/),
    "/cart/",
  );
});

test("CookieJar keeps, replaces and drops cookies as a browser does", () => {
  const jar = new CookieJar();
  const now = Date.parse("2026-11-07T12:00:00Z");
  jar.store(
    [
      "wp_woocommerce_session_abc=1%7C%7C2; expires=Sun, 08-Nov-2026 12:00:00 GMT; path=/; HttpOnly",
      "openreceive_pay_18=1794101053.abc; Max-Age=3600; path=/; HttpOnly; SameSite=Lax",
      "woocommerce_items_in_cart=1; path=/",
    ],
    now,
  );
  assert.deepEqual(jar.names(), [
    "wp_woocommerce_session_abc",
    "openreceive_pay_18",
    "woocommerce_items_in_cart",
  ]);
  jar.store(
    [
      "woocommerce_items_in_cart=deleted; expires=Thu, 01-Jan-1970 00:00:01 GMT; Max-Age=0; path=/",
      "openreceive_pay_18=1794104653.def; path=/",
      "edd_items_in_cart= ; expires=Fri, 07-Nov-2025 12:00:00 GMT; path=/",
    ],
    now,
  );
  assert.equal(jar.get("woocommerce_items_in_cart"), undefined);
  assert.equal(jar.get("openreceive_pay_18"), "1794104653.def");
  assert.deepEqual(jar.header(), {
    cookie: "wp_woocommerce_session_abc=1%7C%7C2; openreceive_pay_18=1794104653.def",
  });
  assert.deepEqual(new CookieJar().header(), {});
});

test("routeOf names a request by method, path and plain-permalink REST route", () => {
  assert.equal(
    routeOf("POST", "http://shop/wp-json/openreceive/v1/payments/check"),
    "POST /wp-json/openreceive/v1/payments/check",
  );
  assert.equal(
    routeOf("GET", "http://shop/?rest_route=%2Fwc%2Fstore%2Fv1%2Fcart&x=1"),
    "GET /?rest_route=/wc/store/v1/cart",
  );
  assert.equal(
    routeOf("GET", "http://shop/checkout/order-pay/18/?key=wc_order_x"),
    "GET /checkout/order-pay/18/",
  );
});

test("orderNumber reads WooCommerce and EDD references and nothing else", () => {
  assert.equal(orderNumber("18", ""), 18);
  assert.equal(orderNumber("edd-7", "edd-"), 7);
  assert.equal(orderNumber("edd-7", ""), undefined);
  assert.equal(orderNumber("7", "edd-"), undefined);
  assert.equal(orderNumber("07", ""), undefined);
  assert.equal(orderNumber("1; drop", ""), undefined);
});

test("textOf drops tags and scripts for evidence", () => {
  assert.equal(
    textOf(
      `<p><strong>Error</strong>: You must enter an email&nbsp;address.</p><script>x()</script>`,
    ),
    "Error : You must enter an email\u00a0address.",
  );
});

test("buyerAnswerChecks fails a retried 503 and any other 5xx or unanswered request", () => {
  const answer = (route, status, body = "") => ({ route, status, body, ms: 10, at: 0 });
  const clean = buyerAnswerChecks([
    answer("GET /checkout/order-pay/18/", 200),
    answer("POST /wp-json/openreceive/v1/checkouts", 201),
    answer("POST /wp-json/openreceive/v1/checkouts", 403, '{"code":"FORBIDDEN"}'),
  ]);
  assert.deepEqual(
    clean.map((item) => [item.id, item.pass, item.evidence]),
    [
      ["live_no_buyer_503", true, "3 answers"],
      ["live_no_server_error", true, "3 answers"],
    ],
  );
  const retried = buyerAnswerChecks([
    answer(
      "POST /wp-json/openreceive/v1/checkouts",
      503,
      '{"code":"WALLET_UNAVAILABLE","retryable":true}',
    ),
    answer("POST /wp-json/openreceive/v1/checkouts", 201),
  ]);
  assert.equal(retried[0]?.pass, false);
  assert.match(
    retried[0]?.evidence ?? "",
    /1 of 2 answers were 503\nPOST \/wp-json\/openreceive\/v1\/checkouts 503/,
  );
  assert.equal(retried[1]?.pass, true);
  const broken = buyerAnswerChecks([
    answer("POST /wp-json/openreceive/v1/swaps", 500, "Internal server error."),
    answer("GET /checkout/", 502),
    answer("POST /wp-json/openreceive/v1/payments/check", 0, "TimeoutError"),
    answer("GET /", 404),
  ]);
  assert.equal(broken[0]?.pass, true);
  assert.equal(broken[1]?.pass, false);
  assert.match(broken[1]?.evidence ?? "", /^3 of 4 answers\n/);
  assert.ok(broken.every((item) => item.severity === "blocker"));
});

test("swapMethods lists the pay-in assets a prepare answer marks available", () => {
  const body = JSON.stringify({
    amount_msats: 9245000,
    payment_methods: [
      { pay_in_asset: "SOL_SOL", available: false, unavailable_reason: "amount_too_small" },
      { pay_in_asset: "USDT_SOL", available: true },
      { pay_in_asset: "USDC_ETH", available: true },
    ],
  });
  assert.deepEqual(swapMethods(body), ["USDT_SOL", "USDC_ETH"]);
  assert.deepEqual(swapMethods(JSON.stringify({ amount_msats: 1, payment_methods: [] })), []);
  assert.deepEqual(swapMethods("<html>503</html>"), []);
});
