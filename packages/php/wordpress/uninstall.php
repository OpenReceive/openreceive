<?php
defined('WP_UNINSTALL_PLUGIN') || exit;
require_once __DIR__ . '/autoload.php';
$openreceive_remove_data = static function (): void {
    global $wpdb;
    if ((get_option('woocommerce_openreceive_settings', [])['remove_data'] ?? 'no') !== 'yes') { return; }
    $db = new OpenReceive\WP\WpdbConnection($wpdb);
    foreach (['openreceive_payments', 'openreceive_meta'] as $suffix) {
        $table = $wpdb->prefix . $suffix;
        if (!preg_match('/\A[A-Za-z_][A-Za-z0-9_]*\z/', $table)) { throw new RuntimeException('Invalid table name.'); }
        $db->execute("DROP TABLE IF EXISTS {$table}");
    }
    delete_option('woocommerce_openreceive_settings');
};
if (is_multisite()) {
    foreach (get_sites(['fields' => 'ids', 'number' => 0]) as $id) {
        switch_to_blog($id);
        try { $openreceive_remove_data(); } finally { restore_current_blog(); }
    }
} else { $openreceive_remove_data(); }
