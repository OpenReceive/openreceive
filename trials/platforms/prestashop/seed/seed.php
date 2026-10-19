<?php

// Fills the stock PrestaShop with a small widget shop: a customer the live
// checks sign in as and a second customer, each with an address, and five
// downloadable widgets at the trial's five prices, with no tax, so checkout
// needs no carrier. Its owner is the employee the installer made. The
// harness runs it once, after the installer and before the agent sees the
// shop; the agent does not. SHOP_URL is the shop's published address.

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    exit;
}

$root = '/var/www/html';
chdir($root);
require_once $root . '/config/config.inc.php';

$url = getenv('SHOP_URL');
if (!is_string($url) || $url === '') {
    throw new RuntimeException('SHOP_URL is not set.');
}

$context = Context::getContext();
$context->shop = new Shop((int) Configuration::get('PS_SHOP_DEFAULT'));
Shop::setContext(Shop::CONTEXT_SHOP, (int) $context->shop->id);
$context->language = new Language((int) Configuration::get('PS_LANG_DEFAULT'));
$languages = array_map('intval', array_column(Language::getLanguages(false), 'id_lang'));

Configuration::updateValue('PS_SHOP_NAME', 'Widget Shop');

$country = new Country((int) Configuration::get('PS_COUNTRY_DEFAULT'));
$states = $country->contains_states ? State::getStatesByIdCountry((int) $country->id, true) : [];
foreach ([
    ['buyer@example.test', 'Demo', 'Buyer'],
    ['stranger@example.test', 'Other', 'Customer'],
] as [$email, $first, $last]) {
    if (Customer::getCustomersByEmail($email) !== []) {
        continue;
    }
    $customer = new Customer();
    $customer->email = $email;
    $customer->firstname = $first;
    $customer->lastname = $last;
    $customer->passwd = password_hash('widget-shop-local', PASSWORD_BCRYPT);
    $customer->id_default_group = (int) Configuration::get('PS_CUSTOMER_GROUP');
    $customer->active = true;
    $customer->add();
    $customer->updateGroup([(int) Configuration::get('PS_CUSTOMER_GROUP')]);

    $address = new Address();
    $address->id_customer = (int) $customer->id;
    $address->alias = 'Home';
    $address->firstname = $first;
    $address->lastname = $last;
    $address->address1 = '1 Widget Street';
    $address->city = 'Springfield';
    $address->postcode = strtr((string) $country->zip_code_format, ['N' => '1', 'L' => 'A', 'C' => (string) $country->iso_code]);
    $address->id_country = (int) $country->id;
    $address->id_state = (int) ($states[0]['id_state'] ?? 0);
    $address->phone = '5555550100';
    $address->add();
}

$home = (int) Configuration::get('PS_HOME_CATEGORY');
foreach ([
    ['Widget Nano', 'widget-nano', '7.00'],
    ['Widget Micro', 'widget-micro', '12.50'],
    ['Widget Small', 'widget-small', '20.00'],
    ['Widget Medium', 'widget-medium', '35.00'],
    ['Widget Large', 'widget-large', '50.00'],
] as [$name, $slug, $price]) {
    $id = (int) Product::getIdByReference($slug);
    $product = new Product($id > 0 ? $id : null);
    $product->reference = $slug;
    $product->name = array_fill_keys($languages, $name);
    $product->link_rewrite = array_fill_keys($languages, $slug);
    $product->description_short = array_fill_keys($languages, 'A downloadable widget.');
    $product->price = (float) $price;
    $product->id_tax_rules_group = 0;
    $product->is_virtual = true;
    $product->active = true;
    $product->visibility = 'both';
    $product->available_for_order = true;
    $product->show_price = true;
    $product->id_category_default = $home;
    $id > 0 ? $product->update() : $product->add();
    $product->addToCategories([$home]);
    StockAvailable::setQuantity((int) $product->id, 0, 1000);
}

echo "Seeded the shop at {$url}\n";
