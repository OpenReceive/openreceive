<?php
declare(strict_types=1);
namespace OpenReceive\WP;

final class BlocksIntegration extends \Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType
{
    protected $name = 'openreceive';
    public function initialize() { $this->settings = get_option('woocommerce_openreceive_settings', []); }
    public function is_active()
    {
        // WooCommerce owns the gateway instance. Constructing one per Blocks
        // availability probe registers duplicate receipt and settings hooks.
        $gateway = WC()->payment_gateways()->payment_gateways()['openreceive'] ?? null;
        return $gateway instanceof Gateway && $gateway->is_available();
    }
    public function get_payment_method_script_handles()
    {
        wp_register_script('openreceive-blocks', plugin_dir_url(OPENRECEIVE_PLUGIN_FILE) . 'assets/blocks.js', ['wc-blocks-registry', 'wc-settings', 'wp-element', 'wp-html-entities'], OPENRECEIVE_PLUGIN_VERSION, true);
        return ['openreceive-blocks'];
    }
    public function get_payment_method_data()
    {
        return ['title' => $this->get_setting('title', 'Bitcoin Lightning (OpenReceive)'),
            'description' => $this->get_setting('description', ''), 'supports' => ['products']];
    }
}
