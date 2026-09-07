<?php
// WooCommerce owns this catalog and all prices. Seed from the shared demo data.
update_option('woocommerce_currency', 'USD');
update_option('woocommerce_enable_guest_checkout', 'yes');
update_option('woocommerce_coming_soon', 'no');
update_option('woocommerce_store_address', '1 Demo Street');
update_option('woocommerce_store_city', 'Example');
update_option('woocommerce_default_country', 'US:CA');
update_option('woocommerce_store_postcode', '90001');
update_option('woocommerce_custom_orders_table_enabled', 'yes');
WC_Install::create_pages();
update_option('permalink_structure', '/%postname%/');
flush_rewrite_rules();
$settings = get_option('woocommerce_openreceive_settings', []);
$settings = array_replace(['enabled' => 'yes', 'title' => 'Bitcoin Lightning (OpenReceive)', 'description' => 'Pay directly with Lightning or a supported swap currency.'], $settings);
update_option('woocommerce_openreceive_settings', $settings, false);
foreach (json_decode(file_get_contents('/opt/demo/shop-catalog.json'), true, 512, JSON_THROW_ON_ERROR) as $item) {
    if (wc_get_product_id_by_sku($item['sku'])) { continue; }
    $product = new WC_Product_Simple();
    $product->set_name($item['name']);
    $product->set_sku($item['sku']);
    $product->set_regular_price(intdiv($item['price_cents'], 100) . '.' . str_pad((string) ($item['price_cents'] % 100), 2, '0', STR_PAD_LEFT));
    $product->set_virtual(true);
    $product->set_manage_stock(true);
    $product->set_stock_quantity(1000);
    $product->set_status('publish');
    $product->set_catalog_visibility('visible');
    $product->save();
    require_once ABSPATH . 'wp-admin/includes/image.php';
    $upload = wp_upload_bits($item['image_name'], null, file_get_contents('/opt/demo/images/' . $item['image_name']));
    if (!$upload['error']) {
        $attachment = wp_insert_attachment(['post_mime_type' => 'image/webp', 'post_title' => $item['name'], 'post_status' => 'inherit'], $upload['file']);
        wp_update_attachment_metadata($attachment, wp_generate_attachment_metadata($attachment, $upload['file']));
        $product->set_image_id($attachment);
        $product->save();
    }
}
$shop = wc_get_page_id('shop');
update_option('show_on_front', 'page');
update_option('page_on_front', $shop);
echo "WooCommerce demo ready.\n";
