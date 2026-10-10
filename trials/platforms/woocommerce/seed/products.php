<?php

if (!class_exists('WooCommerce')) {
    fwrite(STDERR, "WooCommerce is not active\n");
    exit(1);
}

if (class_exists('WC_Install')) {
    WC_Install::create_pages();
}

$catalog = [
    ['Facet', '7', 'facet'],
    ['Bezel', '12', 'bezel'],
    ['Hinge', '4', 'hinge'],
    ['Latch', '9', 'latch'],
    ['Knob', '3', 'knob'],
];

foreach ($catalog as [$name, $price, $sku]) {
    if (function_exists('wc_get_product_id_by_sku') && wc_get_product_id_by_sku($sku)) {
        continue;
    }
    $product = new WC_Product_Simple();
    $product->set_name($name);
    $product->set_regular_price($price);
    $product->set_sku($sku);
    $product->set_status('publish');
    $product->set_catalog_visibility('visible');
    $product->save();
}

echo (int) wp_count_posts('product')->publish, "\n";
