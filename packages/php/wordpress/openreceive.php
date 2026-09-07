<?php
/**
 * Plugin Name: OpenReceive – Bitcoin Lightning payments for WooCommerce
 * Description: Receive Lightning payments directly into your wallet. Optional swap payments through your configured provider.
 * Version: 0.4.5
 * Requires at least: 6.6
 * Requires PHP: 8.2
 * Requires Plugins: woocommerce
 * WC requires at least: 9.0
 * Author: OpenReceive
 * Plugin URI: https://openreceive.org/wordpress
 * License: GPL-2.0-or-later
 * Text Domain: openreceive
 * Domain Path: /languages
 */

defined('ABSPATH') || exit;
define('OPENRECEIVE_PLUGIN_FILE', __FILE__);
define('OPENRECEIVE_PLUGIN_VERSION', '0.4.5');
require_once __DIR__ . '/autoload.php';

register_activation_hook(__FILE__, [OpenReceive\WP\Plugin::class, 'activate']);
register_deactivation_hook(__FILE__, [OpenReceive\WP\Plugin::class, 'deactivate']);
add_action('before_woocommerce_init', static function (): void {
    if (class_exists(Automattic\WooCommerce\Utilities\FeaturesUtil::class)) {
        foreach (['custom_order_tables', 'cart_checkout_blocks'] as $feature) {
            Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility($feature, __FILE__, true);
        }
    }
});
add_action('plugins_loaded', [OpenReceive\WP\Plugin::class, 'boot']);
