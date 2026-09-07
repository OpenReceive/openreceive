<?php
declare(strict_types=1);
namespace OpenReceive\WP;

final class Gateway extends \WC_Payment_Gateway
{
    public function __construct()
    {
        $this->id = 'openreceive';
        $this->method_title = 'OpenReceive';
        $this->method_description = __('Receive Bitcoin Lightning payments directly into your wallet.', 'openreceive');
        $this->has_fields = false;
        $this->supports = ['products'];
        $this->form_fields = [
            'enabled' => ['title' => __('Enable', 'openreceive'), 'type' => 'checkbox', 'label' => __('Enable OpenReceive', 'openreceive'), 'default' => 'no'],
            'title' => ['title' => __('Title', 'openreceive'), 'type' => 'text', 'default' => 'Bitcoin Lightning (OpenReceive)'],
            'description' => ['title' => __('Description', 'openreceive'), 'type' => 'textarea', 'default' => __('Pay directly with Lightning or a supported swap currency.', 'openreceive')],
            'allow_spend' => ['title' => __('Spend-capable wallet override', 'openreceive'), 'type' => 'checkbox', 'default' => 'no', 'description' => __('Danger: a spend-capable code can drain your wallet if this server is compromised. Use a receive-only code instead.', 'openreceive')],
            'rate_limiting' => ['title' => __('Rate limiting', 'openreceive'), 'type' => 'checkbox', 'default' => 'no', 'description' => __('Recommended for public shops. Limits invoice creation per client IP.', 'openreceive')],
            'remove_data' => ['title' => __('Remove data on uninstall', 'openreceive'), 'type' => 'checkbox', 'default' => 'no', 'description' => __('Delete OpenReceive payment attempts when deleting this plugin. WooCommerce orders are retained.', 'openreceive')],
        ];
        foreach (Secrets::FIELDS as $field => $name) {
            $constant = 'OPENRECEIVE_' . $name;
            $this->form_fields[$field] = ['title' => $name, 'type' => 'password', 'default' => '',
                'placeholder' => defined($constant) ? __('Set in wp-config.php', 'openreceive') : __('Enter a value to set or replace', 'openreceive'),
                'custom_attributes' => ['autocomplete' => 'new-password'] + (defined($constant) ? ['disabled' => 'disabled'] : []),
                'description' => $field === 'nwc_uri' ? __('Receive-only NWC code. Stored encrypted; never displayed.', 'openreceive') : __('Optional LSC code. Keep order-pay links available for payer swap refunds.', 'openreceive')];
        }
        $this->init_settings();
        $this->title = $this->get_option('title');
        $this->description = $this->get_option('description');
        $this->enabled = $this->get_option('enabled', 'no');
        add_action('woocommerce_update_options_payment_gateways_openreceive', [$this, 'process_admin_options']);
        add_action('woocommerce_receipt_openreceive', [$this, 'receipt_page']);
    }

    public function generate_password_html($key, $data)
    {
        $stored = $this->settings[$key] ?? '';
        $this->settings[$key] = '';
        if ($stored !== '') { $data['placeholder'] = __('Set — enter a new value to replace', 'openreceive'); }
        try { return parent::generate_password_html($key, $data); }
        finally { $this->settings[$key] = $stored; }
    }

    public function validate_password_field($key, $value)
    {
        $existing = (string) ($this->settings[$key] ?? '');
        if (defined('OPENRECEIVE_' . Secrets::FIELDS[$key]) || trim((string) $value) === '') { return $existing; }
        return Secrets::encrypt(trim((string) $value));
    }

    public function process_admin_options()
    {
        // WooCommerce verifies the settings form nonce before this callback.
        $original = $this->settings;
        $next = $original;
        try {
            foreach ($this->form_fields as $key => $field) { $next[$key] = $this->get_field_value($key, $field, $this->get_post_data()); }
            if (($next['enabled'] ?? 'no') === 'yes' || Secrets::environment($next)['NWC_URI'] !== '') { Plugin::service($next); }
        } catch (\Throwable) {
            \WC_Admin_Settings::add_error(__('OpenReceive settings were not saved. Check the receive-only NWC code, relay access and optional LSC codes. Spend-capable wallets require the explicit override.', 'openreceive'));
            return false;
        }
        $this->settings = $next;
        return update_option($this->get_option_key(), $next, false);
    }

    public function is_available()
    {
        if (!parent::is_available()) { return false; }
        try {
            Plugin::repository();
            Plugin::engine()->service()->listRates(['currencies' => [get_woocommerce_currency()]]);
            return true;
        } catch (\Throwable) { return false; }
    }

    public function process_payment($order_id)
    {
        $order = OrderHost::order((string) $order_id);
        if (!$order || !$order->needs_payment()) { return ['result' => 'failure']; }
        return ['result' => 'success', 'redirect' => $order->get_checkout_payment_url(true)];
    }

    public function process_refund($order_id, $amount = null, $reason = '')
    {
        return new \WP_Error('openreceive_manual_refund', __('A receive-only wallet cannot send refunds. Refund this order manually from your wallet.', 'openreceive'));
    }

    public static function prepareReceipt(): void
    {
        if (!is_checkout_pay_page()) { return; }
        $order = OrderHost::order((string) absint(get_query_var('order-pay')));
        // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- An order-pay link is authorized by the WooCommerce order key, verified with hash_equals below; guests do not have a user nonce.
        $key = isset($_GET['key']) && is_string($_GET['key']) ? sanitize_text_field(wp_unslash($_GET['key'])) : '';
        if (!$order || !hash_equals($order->get_order_key(), $key)) { return; }
        $expires = time() + HOUR_IN_SECONDS;
        setcookie('openreceive_pay_' . $order->get_id(), OrderHost::cookie($order, $expires), [
            'expires' => $expires, 'path' => '/', 'secure' => is_ssl(), 'httponly' => true, 'samesite' => 'Lax',
        ]);
        nocache_headers();
        $url = plugin_dir_url(OPENRECEIVE_PLUGIN_FILE);
        wp_enqueue_style('openreceive-checkout', $url . 'assets/openreceive-checkout.css', [], OPENRECEIVE_PLUGIN_VERSION);
        wp_enqueue_script_module('openreceive-checkout', $url . 'assets/openreceive-checkout.js', [], OPENRECEIVE_PLUGIN_VERSION);
        wp_enqueue_script('openreceive-receipt', $url . 'assets/receipt.js', [], OPENRECEIVE_PLUGIN_VERSION, true);
    }

    public function receipt_page($order_id): void
    {
        $order = OrderHost::order((string) $order_id);
        if (!$order) { return; }
        $hash = '';
        try {
            $attempts = Plugin::repository()->listForReference((string) $order_id);
            $hash = $attempts[0]->paymentHash ?? '';
        } catch (\Throwable) { /* The checkout displays the service error. */ }
        echo '<meta name="csrf-token" content="' . esc_attr(wp_create_nonce('wp_rest')) . '">';
        echo '<openreceive-checkout resumable="true" reference="' . esc_attr((string) $order_id) . '" prefix="' . esc_url(untrailingslashit(rest_url('openreceive/v1'))) . '" csrf-header="X-WP-Nonce"';
        if ($hash !== '') { echo ' resume-payment-hash="' . esc_attr($hash) . '"'; }
        echo ' data-thank-you="' . esc_url($order->get_checkout_order_received_url()) . '"></openreceive-checkout>';
    }

    public function admin_options()
    {
        parent::admin_options();
        echo '<h3>' . esc_html__('OpenReceive Doctor', 'openreceive') . '</h3><ul>';
        foreach (Plugin::diagnostics() as $line) { echo '<li>' . esc_html($line) . '</li>'; }
        echo '</ul>';
        try {
            global $wpdb;
            $rows = Plugin::repository()->connection()->query("SELECT DISTINCT reference FROM {$wpdb->prefix}openreceive_payments WHERE status = ? LIMIT 50", ['attention']);
            if ($rows !== []) {
                echo '<h3>' . esc_html__('Attention orders', 'openreceive') . '</h3><ul>';
                foreach ($rows as $row) {
                    $order = OrderHost::order((string) $row['reference']);
                    if ($order) { echo '<li><a href="' . esc_url($order->get_edit_order_url()) . '">' . esc_html($order->get_order_number()) . '</a></li>'; }
                }
                echo '</ul>';
            }
        } catch (\Throwable) { /* Doctor reports the configuration failure above. */ }
        echo '<p><a href="https://openreceive.org/guides/swap-refunds">' . esc_html__('Swap refunds and recovery links', 'openreceive') . '</a></p>';
    }
}
