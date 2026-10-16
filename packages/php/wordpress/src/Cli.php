<?php
declare(strict_types=1);
namespace OpenReceive\WP;
defined('ABSPATH') || exit;

final class Cli
{
    /**
     * Save encrypted credentials from stdin, then optionally enable checkout.
     *
     * ## OPTIONS
     *
     * [--nwc-uri=<source>]
     * : Use - to read a receive-only wallet code from stdin.
     * [--lsc-uri-primary=<source>]
     * : Use - to read the primary swap-provider code from stdin.
     * [--lsc-uri-backup=<source>]
     * : Use - to read the backup swap-provider code from stdin.
     * [--enable]
     * : Turn the payment method on after a successful preflight: in WooCommerce, and in Easy Digital Downloads' active gateways.
     */
    public function configure(array $args, array $options): void
    {
        $value = '';
        try {
            $missing = Plugin::missingRequirements();
            if ($missing !== []) { throw new \RuntimeException(Plugin::requirementsMessage($missing) . ' Run wp openreceive doctor.'); }
            $fields = [];
            foreach (Secrets::FIELDS as $field => $_name) {
                $flag = str_replace('_', '-', $field);
                if (array_key_exists($flag, $options)) {
                    if ($options[$flag] !== '-') { throw new \InvalidArgumentException('Credential options accept only - (stdin). Never pass a code as a command argument.'); }
                    $fields[] = $field;
                }
            }
            if (count($fields) > 1) { throw new \InvalidArgumentException('Read one credential per invocation; save the wallet first, then each swap provider.'); }
            if ($fields === [] && !isset($options['enable'])) { throw new \InvalidArgumentException('Specify a credential option with - or --enable.'); }
            $settings = get_option('woocommerce_openreceive_settings', []);
            if ($fields !== []) {
                $value = (string) stream_get_contents(STDIN);
                $settings = Configuration::withSecret($settings, $fields[0], $value);
            }
            if (isset($options['enable'])) { $settings['enabled'] = 'yes'; }
            if (Secrets::environment($settings)['NWC_URI'] === '' && !Plugin::testkit()) { throw new \RuntimeException('Configure the receive-only wallet first with --nwc-uri=-.'); }
            Configuration::save($settings);
            if (isset($options['enable']) && StoreHost::edd()) {
                $gateways = edd_get_option('gateways', []);
                edd_update_option('gateways', (is_array($gateways) ? $gateways : []) + [EddGateway::ID => '1']);
            }
            \WP_CLI::success('Settings saved; wallet preflight passed.');
        } catch (\Throwable $error) {
            \WP_CLI::error(Configuration::errorMessage($error, [$value, trim($value)]));
        }
    }

    /** Report configuration health; exit nonzero when any required check fails. */
    public function doctor(): void
    {
        $report = Plugin::diagnosticReport();
        foreach ($report['lines'] as $line) { \WP_CLI::line($line); }
        if (!$report['ok']) { \WP_CLI::halt(1); }
    }

    /**
     * Mint a Lightning invoice for an unpaid order through the checkout route its payment page uses.
     *
     * ## OPTIONS
     *
     * [<order-id>]
     * : An unpaid WooCommerce order whose payment method is openreceive, or edd-<id> for an Easy Digital Downloads order.
     * [--new]
     * : Easy Digital Downloads: first create a pending test order for the first download, billed to the first administrator.
     */
    public function test_invoice(array $args, array $options = []): void
    {
        $id = isset($options['new']) ? self::newEddOrder() : (string) ($args[0] ?? '');
        if (str_starts_with($id, EddOrderHost::PREFIX)) { self::eddInvoice($id); return; }
        $order = OrderHost::order($id);
        if (!$order || !$order->needs_payment()) {
            \WP_CLI::error("Order {$id} is not an unpaid order with payment method openreceive. Create one with: wp wc shop_order create --user=<admin user id> --payment_method=openreceive --line_items='[{\"product_id\":<product id>,\"quantity\":1}]' --porcelain");
        }
        // The order-pay page issues this cookie once it has verified the order key; the CLI reads that key itself.
        $_COOKIE['openreceive_pay_' . $order->get_id()] = OrderHost::cookie($order, time() + HOUR_IN_SECONDS);
        $request = new \WP_REST_Request('POST', '/openreceive/v1/checkouts');
        $request->set_header('Content-Type', 'application/json');
        $request->set_body((string) wp_json_encode(['reference' => (string) $order->get_id()]));
        $response = Plugin::dispatch($request);
        $body = (array) $response->get_data();
        if ($response->get_status() !== 201) {
            \WP_CLI::error(sprintf('%s (HTTP %d, request_id %s)', $body['message'] ?? 'Checkout failed.', $response->get_status(), $body['request_id'] ?? 'none'));
        }
        $checkout = $body['checkout'];
        \WP_CLI::line('Invoice: ' . $checkout['bolt11']);
        \WP_CLI::line('Payment hash: ' . $checkout['payment_hash']);
        \WP_CLI::line('Order-pay link (opens the checkout on this invoice): ' . $order->get_checkout_payment_url());
        foreach (self::methodLines($body['payment_methods'] ?? [], 'order-pay page') as $line) { \WP_CLI::line($line); }
        \WP_CLI::success(sprintf('Order #%s: %s sats for %s %s, expires %s UTC.', $order->get_order_number(),
            number_format(intdiv((int) $checkout['amount_msats'], 1000)), $order->get_total(), $order->get_currency(), gmdate('Y-m-d H:i', (int) $checkout['expires_at'])));
    }

    /** A pending Easy Digital Downloads order for the first published download, billed to the first administrator. */
    private static function newEddOrder(): string
    {
        if (!StoreHost::edd()) { \WP_CLI::error('--new creates an Easy Digital Downloads order, and Easy Digital Downloads is not active. For WooCommerce, pass an order id.'); }
        $download = get_posts(['post_type' => 'download', 'post_status' => 'publish', 'numberposts' => 1, 'orderby' => 'ID', 'order' => 'ASC']);
        $admin = get_users(['role' => 'administrator', 'number' => 1, 'orderby' => 'ID']);
        if ($download === [] || $admin === []) { \WP_CLI::error('Easy Digital Downloads has no published download, or the site has no administrator, to make a test order with.'); }
        $id = (int) $download[0]->ID;
        $price = (float) edd_get_download_price($id);
        $user = $admin[0];
        $item = ['id' => $id, 'quantity' => 1, 'options' => []];
        $order = edd_insert_payment([
            'price' => $price,
            'user_email' => $user->user_email,
            'purchase_key' => strtolower(md5($user->user_email . wp_generate_password(16, false))),
            'currency' => edd_get_currency(),
            'downloads' => [$item],
            'user_info' => ['id' => $user->ID, 'email' => $user->user_email, 'first_name' => $user->first_name, 'last_name' => $user->last_name, 'discount' => 'none'],
            'cart_details' => [['name' => get_the_title($id), 'id' => $id, 'item_number' => $item, 'item_price' => $price, 'quantity' => 1, 'discount' => 0, 'subtotal' => $price, 'tax' => 0, 'fees' => [], 'price' => $price]],
            'gateway' => EddGateway::ID,
            'status' => 'pending',
        ]);
        if (!$order) { \WP_CLI::error('Easy Digital Downloads did not create the test order.'); }
        \WP_CLI::line(sprintf('Created test order #%s (id %d) for %s %s, billed to %s. Delete it in Downloads → Orders when you are done.', edd_get_order((int) $order)?->get_number(), (int) $order, number_format($price, 2, '.', ''), edd_get_currency(), $user->user_email));
        return EddOrderHost::reference((int) $order);
    }

    private static function eddInvoice(string $reference): void
    {
        $order = EddOrderHost::order($reference);
        if (!$order || $order->status !== 'pending') {
            \WP_CLI::error("{$reference} is not a pending Easy Digital Downloads order with payment method openreceive. Pass --new to create a test order.");
        }
        // The receipt page issues this cookie once EDD has let the visitor see the order; the CLI reads the order itself.
        $_COOKIE['openreceive_pay_edd_' . $order->id] = EddOrderHost::cookie($order, time() + HOUR_IN_SECONDS);
        $request = new \WP_REST_Request('POST', '/openreceive/v1/checkouts');
        $request->set_header('Content-Type', 'application/json');
        $request->set_body((string) wp_json_encode(['reference' => $reference]));
        $response = Plugin::dispatch($request);
        $body = (array) $response->get_data();
        if ($response->get_status() !== 201) {
            \WP_CLI::error(sprintf('%s (HTTP %d, request_id %s)', $body['message'] ?? 'Checkout failed.', $response->get_status(), $body['request_id'] ?? 'none'));
        }
        $checkout = $body['checkout'];
        \WP_CLI::line('Invoice: ' . $checkout['bolt11']);
        \WP_CLI::line('Payment hash: ' . $checkout['payment_hash']);
        \WP_CLI::line('Receipt page (shows the checkout for this order to its customer, or to a signed-in shop manager): ' . edd_get_receipt_page_uri((int) $order->id));
        foreach (self::methodLines($body['payment_methods'] ?? [], 'receipt page') as $line) { \WP_CLI::line($line); }
        \WP_CLI::success(sprintf('Order #%s: %s sats for %s %s, expires %s UTC.', $order->get_number(),
            number_format(intdiv((int) $checkout['amount_msats'], 1000)), number_format((float) $order->total, 2, '.', ''), $order->currency, gmdate('Y-m-d H:i', (int) $checkout['expires_at'])));
    }

    /**
     * The methods the payment page offers for this invoice, from the same create response.
     *
     * @param list<array<string, mixed>> $methods
     * @return list<string>
     */
    public static function methodLines(array $methods, string $page = 'order-pay page'): array
    {
        if ($methods === []) { return ['Checkout methods: Bitcoin Lightning only (no swap provider configured).']; }
        $lines = ['Checkout methods on the ' . $page . ':', '  Bitcoin Lightning: available'];
        foreach ($methods as $method) {
            $lines[] = sprintf('  %s on %s: %s', $method['label'], $method['network_label'],
                $method['available'] ? 'available' : 'unavailable — ' . ($method['unavailable_message'] ?? $method['unavailable_reason']));
        }
        return $lines;
    }
}
