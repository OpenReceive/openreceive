<?php

// Fills the stock FOSSBilling with a small hosting shop: a client the live
// checks sign in as, a second client, and five VPS products at the trial's
// five prices. Its owner is the admin the installer made. The harness runs
// it once, after the installer and before the agent sees the shop; the agent
// does not. SHOP_URL is the shop's published address.

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    exit;
}

$root = '/var/www/html';
chdir($root);
require_once $root . '/load.php';
$di = include $root . '/di.php';
$di['translate']();

$url = getenv('SHOP_URL');
if (!is_string($url) || $url === '') {
    throw new RuntimeException('SHOP_URL is not set.');
}

$system = $di['mod_service']('system');
$system->setParamValue('company_name', 'Widget Hosting');

$clients = $di['mod_service']('client');
foreach ([
    ['buyer@example.test', 'Demo', 'Buyer'],
    ['stranger@example.test', 'Other', 'Client'],
] as [$email, $first, $last]) {
    if ($di['db']->findOne('Client', 'email = :email', [':email' => $email]) !== null) {
        continue;
    }
    $clients->adminCreateClient([
        'email' => $email,
        'first_name' => $first,
        'last_name' => $last,
        'password' => 'widget-shop-local',
        'currency' => 'USD',
        'send_welcome_email' => false,
    ]);
}

$products = $di['mod_service']('product');
$category = $di['dbal']->fetchOne('SELECT id FROM product_category WHERE title = ?', ['VPS'])
    ?: $products->createCategory('VPS', 'Virtual private servers');
foreach ([
    ['Widget VPS Nano', '7.00'],
    ['Widget VPS Micro', '12.50'],
    ['Widget VPS Small', '20.00'],
    ['Widget VPS Medium', '35.00'],
    ['Widget VPS Large', '50.00'],
] as [$title, $price]) {
    $id = $di['dbal']->fetchOne('SELECT id FROM product WHERE title = ?', [$title])
        ?: $products->createProduct($title, 'custom', (int) $category);
    // A new product's pricing has every period on at 0.00: keep only monthly.
    $periods = array_fill_keys(['1W', '3M', '6M', '1Y', '2Y', '3Y'], ['price' => '0', 'setup' => '0', 'enabled' => false]);
    $products->updateProduct($products->findProductById((int) $id), [
        'status' => 'enabled',
        'description' => 'A virtual private server, billed monthly.',
        'pricing' => ['type' => 'recurrent', 'recurrent' => ['1M' => ['price' => $price, 'setup' => '0', 'enabled' => true]] + $periods],
    ]);
}

echo "Seeded the shop at {$url}\n";
