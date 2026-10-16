<?php
declare(strict_types=1);
namespace OpenReceive\WP;
defined('ABSPATH') || exit;

/**
 * The Easy Digital Downloads payment gateway. The buyer picks it at checkout;
 * EDD records a pending order, and its purchase confirmation page shows the
 * checkout until the order is paid. The codes are the ones the WooCommerce
 * gateway uses, saved encrypted from EDD's settings or with WP-CLI.
 */
final class EddGateway
{
    public const ID = 'openreceive';

    public static function register(): void
    {
        add_filter('edd_payment_gateways', [self::class, 'gateways']);
        add_filter('edd_enabled_payment_gateways', [self::class, 'available']);
        add_action('edd_' . self::ID . '_cc_form', '__return_false');
        add_action('edd_gateway_' . self::ID, [self::class, 'process']);
        add_action('template_redirect', [self::class, 'prepareReceipt']);
        add_action('edd_order_receipt_before_table', [self::class, 'receipt'], 10, 1);
        add_filter('edd_settings_sections_gateways', static fn (array $sections): array => $sections + [self::ID => 'OpenReceive']);
        add_filter('edd_settings_gateways', static fn (array $settings): array => $settings + [self::ID => [
            'openreceive_settings' => ['id' => 'openreceive_settings', 'name' => 'OpenReceive', 'type' => 'hook'],
        ]]);
        add_action('edd_openreceive_settings', [self::class, 'settings']);
        add_filter('edd_settings_gateways-' . self::ID . '_sanitize', [self::class, 'save']);
    }

    /** @param array<string, array<string, mixed>> $gateways */
    public static function gateways(array $gateways): array
    {
        $gateways[self::ID] = [
            'admin_label' => 'OpenReceive (Bitcoin Lightning)',
            'checkout_label' => Configuration::title(get_option('woocommerce_openreceive_settings', [])),
            'supports' => [],
        ];
        return $gateways;
    }

    /**
     * Checkout offers the method only once the wallet code is saved and the
     * price feed answers for the store currency, as the WooCommerce gateway does.
     *
     * @param array<string, mixed> $gateways
     */
    public static function available(array $gateways): array
    {
        if (!isset($gateways[self::ID]) || is_admin()) { return $gateways; }
        try {
            if (Secrets::environment()['NWC_URI'] === '' && !Plugin::testkit()) { throw new \RuntimeException('No wallet code.'); }
            Plugin::repository();
            Plugin::engine()->service()->listRates(['currencies' => [strtoupper((string) edd_get_currency())]]);
        } catch (\Throwable) { unset($gateways[self::ID]); }
        return $gateways;
    }

    /** @param array<string, mixed> $purchase EDD's purchase data */
    public static function process(array $purchase): void
    {
        if (!wp_verify_nonce($purchase['gateway_nonce'] ?? '', 'edd-gateway')) {
            wp_die(esc_html__('Nonce verification has failed', 'openreceive'), esc_html__('Error', 'openreceive'), ['response' => 403]);
        }
        $order = edd_insert_payment([
            'price' => $purchase['price'],
            'date' => $purchase['date'],
            'user_email' => $purchase['user_email'],
            'purchase_key' => $purchase['purchase_key'],
            'currency' => edd_get_currency(),
            'downloads' => $purchase['downloads'],
            'user_info' => $purchase['user_info'],
            'cart_details' => $purchase['cart_details'],
            'gateway' => self::ID,
            'status' => 'pending',
        ]);
        $refusal = $order && class_exists(\EDD\Discounts\OrderValidation::class) ? \EDD\Discounts\OrderValidation::refuse_unclaimed($order) : '';
        if (!$order || $refusal) {
            if (!$order) { edd_record_gateway_error(__('Payment Error', 'openreceive'), __('OpenReceive could not record the pending order.', 'openreceive')); }
            edd_send_back_to_checkout('?payment-mode=' . self::ID);
            return;
        }
        edd_empty_cart();
        // The purchase confirmation page shows the checkout for this pending order.
        edd_send_to_success_page();
    }

    /** EDD's purchase confirmation page, or its receipt page: both show the order's receipt. */
    private static function onReceiptPage(): bool
    {
        if (!function_exists('edd_get_option')) { return false; }
        $pages = array_filter([absint(edd_get_option('confirmation_page', 0)), absint(edd_get_option('success_page', 0))]);
        return $pages !== [] && is_page($pages);
    }

    /**
     * The order on the receipt, found as EDD's own receipt blocks find it (the
     * payment key in the link, the order id with its receipt hash, or the
     * purchase session), when EDD lets this visitor see that receipt.
     */
    private static function receiptOrder(): ?\EDD\Orders\Order
    {
        // phpcs:disable WordPress.Security.NonceVerification.Recommended -- EDD's receipt links carry a payment key or a receipt hash; edd_can_view_receipt() authorizes the order below.
        $key = isset($_GET['payment_key']) && is_string($_GET['payment_key']) ? sanitize_text_field(wp_unslash($_GET['payment_key'])) : '';
        $id = isset($_GET['id']) && is_string($_GET['id']) ? absint($_GET['id']) : 0;
        $hash = isset($_GET['order']) && is_string($_GET['order']) ? sanitize_text_field(wp_unslash($_GET['order'])) : '';
        // phpcs:enable WordPress.Security.NonceVerification.Recommended
        if ($key === '' && $id > 0 && $hash !== '') {
            $linked = edd_get_order($id);
            $valid = $linked instanceof \EDD\Orders\Order
                && (method_exists($linked, 'is_receipt_hash_valid') ? $linked->is_receipt_hash_valid($hash) : hash_equals($linked->get_receipt_hash(), $hash));
            if ($valid) { $key = (string) $linked->payment_key; }
        }
        if ($key === '') { $key = (string) (edd_get_purchase_session()['purchase_key'] ?? ''); }
        if ($key === '') { return null; }
        $order = edd_get_order_by('payment_key', $key);
        if (!$order instanceof \EDD\Orders\Order || !edd_can_view_receipt($order)) { return null; }
        return EddOrderHost::order(EddOrderHost::reference((int) $order->id));
    }

    /** Before the page renders: the signed cookie the checkout's routes authorize, and the checkout's files. */
    public static function prepareReceipt(): void
    {
        if (!self::onReceiptPage()) { return; }
        $order = self::receiptOrder();
        if ($order === null || $order->status !== 'pending') { return; }
        $expires = time() + HOUR_IN_SECONDS;
        setcookie('openreceive_pay_edd_' . $order->id, EddOrderHost::cookie($order, $expires), [
            'expires' => $expires, 'path' => '/', 'secure' => is_ssl(), 'httponly' => true, 'samesite' => 'Lax',
        ]);
        nocache_headers();
        $url = plugin_dir_url(OPENRECEIVE_PLUGIN_FILE);
        wp_enqueue_style('openreceive-checkout', $url . 'assets/openreceive-checkout.css', [], OPENRECEIVE_PLUGIN_VERSION);
        wp_enqueue_script_module('openreceive-checkout', $url . 'assets/openreceive-checkout.js', [], OPENRECEIVE_PLUGIN_VERSION);
        wp_enqueue_script('openreceive-receipt', $url . 'assets/receipt.js', [], OPENRECEIVE_PLUGIN_VERSION, true);
    }

    /** Above the receipt of a pending order: the checkout, which reloads the receipt once the order is paid. */
    public static function receipt($order): void
    {
        if (!$order instanceof \EDD\Orders\Order || $order->gateway !== self::ID || $order->status !== 'pending') { return; }
        $reference = EddOrderHost::reference((int) $order->id);
        $hash = '';
        $rail = 'swap';
        try {
            $attempt = Plugin::repository()->listForReference($reference)[0] ?? null;
            if ($attempt !== null && ($attempt->isSwap() || ($attempt->status === 'pending' && $attempt->expiresAt > time()))) {
                $hash = $attempt->paymentHash;
                $rail = $attempt->isSwap() ? 'swap' : 'lightning';
            }
        } catch (\Throwable) { /* The checkout displays the service error. */ }
        $receipt = edd_get_receipt_page_uri((int) $order->id);
        echo '<meta name="csrf-token" content="' . esc_attr(wp_create_nonce('wp_rest')) . '">';
        echo '<div class="openreceive-edd-checkout" style="margin-bottom:2em">';
        echo '<openreceive-checkout resumable="true" reference="' . esc_attr($reference) . '" prefix="' . esc_url(untrailingslashit(rest_url('openreceive/v1'))) . '" csrf-header="X-WP-Nonce"';
        if ($hash !== '') { echo ' resume-payment-hash="' . esc_attr($hash) . '" resume-payment-rail="' . esc_attr($rail) . '"'; }
        echo ' data-thank-you="' . esc_url($receipt) . '"></openreceive-checkout></div>';
    }

    /** EDD → Settings → Payments → OpenReceive. Codes are never printed back: each field says only whether it is set. */
    public static function settings(): void
    {
        $settings = get_option('woocommerce_openreceive_settings', []);
        try { $env = Secrets::environment($settings); } catch (\Throwable) { $env = []; }
        $fields = [
            'nwc_uri' => [__('NWC code', 'openreceive'), __('Receive-only code from your Lightning wallet. Stored encrypted; never displayed.', 'openreceive'), 'https://openreceive.org/get_a_nwc_code_to_receive_payments'],
            'lsc_uri_primary' => [__('Lightning Swap Connect code', 'openreceive'), __('Optional. Lets customers pay with USDT, USDC, SOL or ETH, converted to BTC over Lightning into your wallet; assets depend on the provider. Swap refunds go through the order\'s receipt page, so keep it available.', 'openreceive'), 'https://openreceive.org/set_up_swap_provider'],
        ];
        wp_nonce_field('openreceive_edd_settings', 'openreceive_edd_nonce');
        echo '<p>' . esc_html__('Bitcoin Lightning payments straight into your own wallet. Turn the method on under Payments → General → Active gateways.', 'openreceive') . '</p>';
        echo '<table class="form-table" role="presentation"><tbody>';
        foreach ($fields as $field => [$title, $description, $guide]) {
            $name = Secrets::FIELDS[$field];
            $set = ($env[$name] ?? '') !== '';
            $constant = defined('OPENRECEIVE_' . $name);
            echo '<tr><th scope="row"><label for="openreceive_' . esc_attr($field) . '">' . esc_html($title) . '</label></th><td>';
            echo '<input type="password" class="regular-text" id="openreceive_' . esc_attr($field) . '" name="openreceive[' . esc_attr($field) . ']" value="" autocomplete="new-password" spellcheck="false"'
                . ($constant ? ' disabled placeholder="' . esc_attr__('Set in wp-config.php', 'openreceive') . '"' : ($set ? ' placeholder="' . esc_attr__('Set — enter a new value to replace', 'openreceive') . '"' : '')) . '>';
            echo '<p class="description">' . esc_html($description) . ' <a href="' . esc_url($guide) . '" target="_blank" rel="noopener">' . esc_html__('How to get one', 'openreceive') . '</a></p></td></tr>';
        }
        echo '<tr><th scope="row"><label for="openreceive_title">' . esc_html__('Title', 'openreceive') . '</label></th><td>';
        echo '<input type="text" class="regular-text" id="openreceive_title" name="openreceive[title]" value="' . esc_attr(Configuration::customTitle($settings)) . '" placeholder="' . esc_attr(Configuration::title($settings)) . '">';
        echo '<p class="description">' . esc_html__('Leave empty for the default, which names stablecoins once a swap code is saved.', 'openreceive') . '</p></td></tr>';
        echo '</tbody></table>';
        echo '<h3>' . esc_html__('OpenReceive Doctor', 'openreceive') . '</h3><ul>';
        foreach (Plugin::diagnostics() as $line) { echo '<li>' . esc_html($line) . '</li>'; }
        echo '</ul><p><a href="https://openreceive.org/guides/swap-refunds">' . esc_html__('Swap refunds and recovery links', 'openreceive') . '</a></p>';
    }

    /**
     * Runs while EDD saves this settings section. The codes are not EDD
     * settings: they are checked with the wallet, then saved encrypted with
     * the WooCommerce gateway's, so EDD's own option never holds them.
     *
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public static function save(array $input): array
    {
        if (!isset($_POST['openreceive_edd_nonce']) || !wp_verify_nonce(sanitize_text_field(wp_unslash($_POST['openreceive_edd_nonce'])), 'openreceive_edd_settings') || !current_user_can('manage_shop_settings')) {
            return $input;
        }
        // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- Each value is trimmed and encrypted by Configuration; a code is not text to sanitize.
        $posted = isset($_POST['openreceive']) && is_array($_POST['openreceive']) ? wp_unslash($_POST['openreceive']) : [];
        $settings = get_option('woocommerce_openreceive_settings', []);
        $values = [];
        try {
            foreach (['nwc_uri', 'lsc_uri_primary'] as $field) {
                $value = is_string($posted[$field] ?? null) ? trim($posted[$field]) : '';
                if ($value === '' || defined('OPENRECEIVE_' . Secrets::FIELDS[$field])) { continue; }
                $values[] = $value;
                $settings = Configuration::withSecret($settings, $field, $value);
            }
            if (isset($posted['title']) && is_string($posted['title'])) { $settings['title'] = sanitize_text_field($posted['title']); }
            Configuration::save($settings);
        } catch (\Throwable $error) {
            add_settings_error('edd-notices', 'openreceive', __('OpenReceive settings were not saved:', 'openreceive') . ' ' . Configuration::errorMessage($error, $values));
        }
        return $input;
    }
}
