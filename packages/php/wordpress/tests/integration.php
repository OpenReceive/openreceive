<?php
// Run with wp eval-file inside the disposable Docker testkit shop.
use OpenReceive\WP\Gateway;
use OpenReceive\WP\OrderHost;
use OpenReceive\WP\Plugin;
use OpenReceive\WP\Secrets;
use OpenReceive\WP\Vendor\OpenReceive\Server\AuthorizeContext;

if (!defined('OPENRECEIVE_DEMO_WALLET') || OPENRECEIVE_DEMO_WALLET !== 'testkit') { throw new RuntimeException('Requires a disposable testkit shop.'); }
$checks = 0;
$check = static function ($condition, string $message) use (&$checks): void {
    if (!$condition) { throw new RuntimeException($message); }
    $checks++;
};
$makeOrder = static function () {
    $product = wc_get_product(wc_get_product_id_by_sku('safety-orange'));
    $order = wc_create_order();
    $order->add_product($product, 1);
    $order->set_payment_method('openreceive');
    $order->set_billing_email('payer@example.test');
    $order->calculate_totals();
    $order->save();
    return $order;
};
$dispatch = static function (string $route, array $body, string $method = 'POST') {
    $request = new WP_REST_Request($method, '/openreceive/v1' . $route);
    $request->set_header('content-type', 'application/json');
    $request->set_body(wp_json_encode($body));
    return Plugin::dispatch($request);
};
Plugin::activate();
$repo = Plugin::repository();
$check($repo->meta()->storedSchemaVersion() === 1, 'activation schema marker');
$order = $makeOrder();
$other = $makeOrder();
$reference = (string) $order->get_id();
$host = new OrderHost();
$context = new AuthorizeContext('checkout.create', null, ['reference' => $reference]);
$check(!$host->authorize($context), 'anonymous foreign order must be refused');
$customer = wp_create_user('or-test-' . wp_generate_uuid4(), wp_generate_password(), 'or-' . wp_generate_uuid4() . '@example.test');
$order->set_customer_id($customer); $order->save();
wp_set_current_user($customer);
$check($host->authorize($context), 'logged-in owner authorized');
$check(!$host->authorize(new AuthorizeContext('checkout.create', null, ['reference' => (string) $other->get_id()])), 'logged-in foreign owner denied');
wp_set_current_user(0);
WC()->initialize_session();
WC()->session->set('order_awaiting_payment', $order->get_id());
$check($host->authorize($context), 'checkout session owner authorized');
WC()->session->set('order_awaiting_payment', null);
$_COOKIE['openreceive_pay_' . $order->get_id()] = OrderHost::cookie($order, time() + 3600);
$check($host->authorize($context), 'signed guest return cookie');
$check(!$host->authorize(new AuthorizeContext('checkout.create', null, ['reference' => (string) $other->get_id()])), 'cookie cannot authorize a different order');
$valid = $_COOKIE['openreceive_pay_' . $order->get_id()];
$_COOKIE['openreceive_pay_' . $order->get_id()] = OrderHost::cookie($order, time() - 1);
$check(!$host->authorize($context), 'expired cookie rejected server-side');
$_COOKIE['openreceive_pay_' . $order->get_id()] = $valid;
$check($host->amountFor($reference)['value'] === $order->get_total(), 'host-owned decimal price');
$check($dispatch('/checkouts', ['reference' => $reference, 'amount' => ['sats' => 1]])->get_status() === 400, 'payer cannot set price');
$prepared = $dispatch('/checkouts/prepare', ['reference' => $reference]);
$check($prepared->get_status() === 200, 'prepare route: ' . wp_json_encode($prepared->get_data()));
$created = $dispatch('/checkouts', ['reference' => $reference]);
$check($created->get_status() === 201, 'create route: ' . wp_json_encode($created->get_data()));
$hash = $created->get_data()['checkout']['payment_hash'];
$check(count($repo->listForReference($reference)) === 1, 'attempt persisted before response');
$retry = $dispatch('/checkouts', ['reference' => $reference]);
$check($retry->get_data()['checkout']['payment_hash'] === $hash, 'retry reuses attempt');
$check($dispatch('/payments/check', ['reference' => $reference, 'payment_hash' => $hash])->get_status() === 200, 'check route');
$_COOKIE['openreceive_pay_' . $other->get_id()] = OrderHost::cookie($other, time() + 3600);
$check($dispatch('/payments/check', ['reference' => (string) $other->get_id(), 'payment_hash' => $hash])->get_status() === 404, 'foreign hash rejected even for an authorized order');
$quote = $dispatch('/swaps/quote', ['reference' => $reference, 'pay_in_asset' => 'USDT_TRON']);
$check($quote->get_status() === 200, 'swap quote');
$swap = $dispatch('/swaps', ['reference' => $reference, 'pay_in_asset' => 'USDT_TRON']);
$check($swap->get_status() === 201, 'swap create: ' . wp_json_encode($swap->get_data()));
$swapHash = $swap->get_data()['swap']['checkout']['payment_hash'];
$check(!str_contains(wp_json_encode($swap->get_data()), 'provider_token'), 'no provider credentials in response');
$check($dispatch('/swaps/status', ['reference' => $reference, 'payment_hash' => $swapHash])->get_status() === 200, 'swap status');
$provider = Plugin::engine()->service()->swapProviders()[0];
$provider->forceRefundRequired(['pay_in_asset' => 'USDT_TRON']);
$refund = $dispatch('/swaps/refunds', ['reference' => $reference, 'payment_hash' => $swapHash,
    'refund_address' => $provider::NETWORK_DEPOSIT_ADDRESS['TRX']]);
$check($refund->get_status() === 200, 'provider-refreshed refund route');
$check($dispatch('/rates', [], 'GET')->get_status() === 200, 'rates route');
$gateway = new Gateway();
$check($gateway->is_available(), 'gateway available for USD');
ob_start(); $gateway->receipt_page($order->get_id()); $markup = ob_get_clean();
$check(str_contains($markup, 'csrf-header="X-WP-Nonce"') && str_contains($markup, 'resume-payment-hash='), 'receipt nonce and resume attributes');
$cipher = Secrets::encrypt('opaque-test-value');
$gateway->settings['nwc_uri'] = $cipher;
$html = $gateway->generate_password_html('nwc_uri', $gateway->form_fields['nwc_uri']);
$check(!str_contains($html, $cipher) && !str_contains($html, 'opaque-test-value'), 'settings do not render credential or ciphertext');
$productId = wc_get_product_id_by_sku('safety-orange');
$stock = wc_get_product($productId)->get_stock_quantity();
$wallet = Plugin::engine()->service()->nwcClient();
$wallet->settleInvoice($hash);
Plugin::engine()->reconcile();
$paid = wc_get_order($order->get_id());
$check($paid->is_paid(), 'WooCommerce order paid');
$check($paid->get_transaction_id() === $hash, 'transaction id recorded');
$check(wc_get_product($productId)->get_stock_quantity() === $stock - 1, 'stock reduced exactly once');
Plugin::engine()->reconcile(); OrderHost::repair();
$check(wc_get_product($productId)->get_stock_quantity() === $stock - 1, 'settlement replay does not reduce stock again');

// Simulate COMMIT followed by process death before afterPaid. No wallet scan is
// needed to recover the host's already committed order-completion marker.
$recovery = $makeOrder();
$recoveryRef = (string) $recovery->get_id();
$checkout = Plugin::engine()->service()->createCheckout(['reference' => $recoveryRef, 'amount' => $host->amountFor($recoveryRef)]);
$repo->commitAttempt($recoveryRef, $checkout['payment_hash'], $checkout);
$repo->markPaidOnce($checkout['payment_hash'], time(), null, [$host, 'onPaid']);
$check(wc_get_order($recovery->get_id())->needs_payment(), 'interrupted completion setup');
OrderHost::repair();
$check(wc_get_order($recovery->get_id())->is_paid(), 'interrupted completion repaired');
$check(is_wp_error($gateway->process_refund($order->get_id())), 'merchant refunds are manual');
echo "WordPress integration: {$checks} checks passed.\n";
