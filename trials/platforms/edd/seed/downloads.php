<?php

if (!function_exists('EDD')) {
    fwrite(STDERR, "Easy Digital Downloads is not active\n");
    exit(1);
}

// EDD creates its tables on the first admin page; WP-CLI has none.
foreach (EDD()->components as $component) {
    foreach (['table', 'meta'] as $interface) {
        $object = $component->get_interface($interface);
        if ($object && method_exists($object, 'maybe_upgrade')) {
            $object->maybe_upgrade();
        }
    }
}

$catalog = [
    ['Widget Pack Nano', '7.00', 'widget-pack-nano'],
    ['Widget Pack Micro', '12.50', 'widget-pack-micro'],
    ['Widget Pack Small', '20.00', 'widget-pack-small'],
    ['Widget Pack Medium', '35.00', 'widget-pack-medium'],
    ['Widget Pack Large', '50.00', 'widget-pack-large'],
];

foreach ($catalog as [$name, $price, $slug]) {
    if (get_page_by_path($slug, OBJECT, 'download') !== null) {
        continue;
    }
    $id = wp_insert_post([
        'post_type' => 'download',
        'post_title' => $name,
        'post_name' => $slug,
        'post_status' => 'publish',
        'post_content' => 'A pack of digital widgets.',
    ]);
    update_post_meta($id, 'edd_price', $price);
}

foreach ([['buyer', 'buyer@example.test', 'Demo', 'Buyer'], ['stranger', 'stranger@example.test', 'Other', 'Client']] as [$login, $email, $first, $last]) {
    if (get_user_by('email', $email) === false) {
        wp_insert_user(['user_login' => $login, 'user_email' => $email, 'user_pass' => 'widget-shop-local', 'first_name' => $first, 'last_name' => $last, 'role' => 'subscriber']);
    }
}
echo "Seeded five downloads.\n";
