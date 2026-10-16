<?php
// Run with wp eval-file inside the disposable Docker testkit shop, which runs
// WooCommerce and Easy Digital Downloads side by side.
use OpenReceive\WP\EddGateway;
use OpenReceive\WP\EddOrderHost;
use OpenReceive\WP\Plugin;
use OpenReceive\WP\StoreHost;
use OpenReceive\WP\Vendor\OpenReceive\Server\AuthorizeContext;

if (!defined('OPENRECEIVE_DEMO_WALLET') || OPENRECEIVE_DEMO_WALLET !== 'testkit') { throw new RuntimeException('Requires a disposable testkit shop.'); }
$checks = 0;
$check = static function ($condition, string $message) use (&$checks): void {
    if (!$condition) { throw new RuntimeException($message); }
    $checks++;
};
// See integration.php: a scan issued in the same second as a route is refused as gate_busy.
$scan = static function () use ($check): void {
    $reconciler = Plugin::engine()->reconciler();
    $scanned = false;
    for ($spin = 0; $spin < 50 && !$scanned; $spin++) {
        if ($spin > 0) { usleep(200000); }
        $scanned = ($reconciler->gatedReconcile()['reason'] ?? '') !== 'gate_busy';
    }
    $check($scanned, 'reconcile gate opened for a settlement scan');
};
$download = get_page_by_path('safety-orange-download', OBJECT, 'download');
$check($download instanceof WP_Post, 'the demo seeded an Easy Digital Downloads download');
$makeOrder = static function (int $userId = 0) use ($download): int {
    $email = 'edd-' . wp_generate_uuid4() . '@example.test';
    $item = ['id' => $download->ID, 'quantity' => 1, 'options' => []];
    return (int) edd_insert_payment([
        'price' => 7.0, 'user_email' => $email, 'purchase_key' => strtolower(md5($email)), 'currency' => 'USD',
        'downloads' => [$item], 'gateway' => EddGateway::ID, 'status' => 'pending',
        'user_info' => ['id' => $userId, 'email' => $email, 'first_name' => 'Demo', 'last_name' => 'Payer', 'discount' => 'none'],
        'cart_details' => [['name' => $download->post_title, 'id' => $download->ID, 'item_number' => $item, 'item_price' => 7.0, 'quantity' => 1, 'discount' => 0, 'subtotal' => 7.0, 'tax' => 0, 'fees' => [], 'price' => 7.0]],
    ]);
};
$dispatch = static function (string $route, array $body) {
    $request = new WP_REST_Request('POST', '/openreceive/v1' . $route);
    $request->set_header('content-type', 'application/json');
    $request->set_body(wp_json_encode($body));
    return Plugin::dispatch($request);
};

$check(StoreHost::woocommerce() && StoreHost::edd(), 'both stores are active');
$check(in_array('OpenReceive', array_map(static fn ($gateway) => $gateway['admin_label'] === 'OpenReceive (Bitcoin Lightning)' ? 'OpenReceive' : '', edd_get_payment_gateways()), true), 'Easy Digital Downloads lists the gateway');
$check(isset(edd_get_enabled_payment_gateways()[EddGateway::ID]), 'checkout offers the gateway once the wallet answers');
$check(str_contains(implode("\n", Plugin::diagnostics()), 'Store: WooCommerce and Easy Digital Downloads active'), 'doctor names both stores');

$orderId = $makeOrder();
$otherId = $makeOrder();
$reference = EddOrderHost::reference($orderId);
$check(EddOrderHost::order($reference)?->id == $orderId, 'edd-<id> resolves the EDD order');
$check(EddOrderHost::order((string) $orderId) === null, 'a bare id is never an EDD order');
$host = new StoreHost();
$context = new AuthorizeContext('checkout.create', null, ['reference' => $reference]);
wp_set_current_user(0);
$check(!$host->authorize($context), 'a visitor with no cookie is refused');
$order = edd_get_order($orderId);
$_COOKIE['openreceive_pay_edd_' . $orderId] = EddOrderHost::cookie($order, time() + 3600);
$check($host->authorize($context), 'the receipt page cookie authorizes its order');
$check(!$host->authorize(new AuthorizeContext('checkout.create', null, ['reference' => EddOrderHost::reference($otherId)])), 'the cookie cannot authorize another order');
$valid = $_COOKIE['openreceive_pay_edd_' . $orderId];
$_COOKIE['openreceive_pay_edd_' . $orderId] = EddOrderHost::cookie($order, time() - 1);
$check(!$host->authorize($context), 'an expired cookie is refused');
$_COOKIE['openreceive_pay_edd_' . $orderId] = $valid;
$customer = wp_create_user('or-edd-' . wp_generate_uuid4(), wp_generate_password(), 'or-edd-' . wp_generate_uuid4() . '@example.test');
$owned = $makeOrder($customer);
wp_set_current_user($customer);
$check($host->authorize(new AuthorizeContext('checkout.create', null, ['reference' => EddOrderHost::reference($owned)])), 'the signed-in customer is authorized for their order');
$check(!$host->authorize(new AuthorizeContext('checkout.create', null, ['reference' => EddOrderHost::reference($otherId)])), 'the signed-in customer is refused for another order');
wp_set_current_user(0);
$check($host->amountFor($reference) === ['currency' => 'USD', 'value' => '7.00', 'description' => 'Order #' . $order->get_number()], 'EDD owns the price: ' . wp_json_encode($host->amountFor($reference)));

$created = $dispatch('/checkouts', ['reference' => $reference]);
$check($created->get_status() === 201, 'create route: ' . wp_json_encode($created->get_data()));
$hash = $created->get_data()['checkout']['payment_hash'];
$check($dispatch('/checkouts', ['reference' => $reference])->get_data()['checkout']['payment_hash'] === $hash, 'retry reuses the attempt');
ob_start(); EddGateway::receipt(edd_get_order($orderId)); $markup = ob_get_clean();
$check(str_contains($markup, 'reference="' . $reference . '"') && str_contains($markup, 'csrf-header="X-WP-Nonce"') && str_contains($markup, 'resume-payment-rail="lightning"'), 'the receipt page renders the checkout and resumes it');

Plugin::engine()->service()->nwcClient()->settleInvoice($hash);
$scan();
$paid = edd_get_order($orderId);
$check($paid->status === 'complete', 'the EDD order completed: ' . $paid->status);
$check(edd_get_payment_transaction_id($orderId) === $hash, 'the payment hash is the transaction id');
$check(edd_get_order_meta($orderId, '_openreceive_completion_pending', true) === '', 'the completion marker is gone');
ob_start(); EddGateway::receipt($paid); $after = ob_get_clean();
$check($after === '', 'a completed order shows no checkout');

// COMMIT, then the process dies before afterPaid: repair completes the order.
$recoveryId = $makeOrder();
$recoveryRef = EddOrderHost::reference($recoveryId);
$checkout = Plugin::engine()->service()->createCheckout(['reference' => $recoveryRef, 'amount' => $host->amountFor($recoveryRef)]);
$repo = Plugin::repository();
$repo->commitAttempt($recoveryRef, $checkout['payment_hash'], $checkout);
$repo->markPaidOnce($checkout['payment_hash'], time(), null, [$host, 'onPaid']);
$check(edd_get_order($recoveryId)->status === 'pending', 'interrupted completion setup');
StoreHost::repair();
$check(edd_get_order($recoveryId)->status === 'complete', 'interrupted completion repaired');

foreach ([$otherId, $owned] as $id) { edd_destroy_order($id); }
echo "Easy Digital Downloads integration: {$checks} checks passed.\n";
