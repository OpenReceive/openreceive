<?php
declare(strict_types=1);
namespace OpenReceive\WP;

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
     * : Enable the gateway after successful preflight.
     */
    public function configure(array $args, array $options): void
    {
        $value = '';
        try {
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
            if (Secrets::environment($settings)['NWC_URI'] === '' && !(defined('OPENRECEIVE_DEMO_WALLET') && OPENRECEIVE_DEMO_WALLET === 'testkit')) { throw new \RuntimeException('Configure the receive-only wallet first with --nwc-uri=-.'); }
            Configuration::save($settings);
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
     * Mint a Lightning invoice for an unpaid order through the checkout route its order-pay page uses.
     *
     * ## OPTIONS
     *
     * <order-id>
     * : An unpaid order whose payment method is openreceive.
     */
    public function test_invoice(array $args): void
    {
        $id = (string) ($args[0] ?? '');
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
        \WP_CLI::success(sprintf('Order #%s: %s sats for %s %s, expires %s UTC.', $order->get_order_number(),
            number_format(intdiv((int) $checkout['amount_msats'], 1000)), $order->get_total(), $order->get_currency(), gmdate('Y-m-d H:i', (int) $checkout['expires_at'])));
    }
}
