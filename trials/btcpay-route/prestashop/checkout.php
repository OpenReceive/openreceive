<?php
// php checkout.php
// A guest's checkout up to "Pay with BTCPay Server": a product, the guest with
// an address, a cart with a carrier, and the payment option the module adds to
// the checkout. Then what the module's payment controller does with that cart
// (Factory::createPaymentRequest in module 6.3.3): it creates the BTCPay
// invoice and, in the default "before payment" order mode, the order, and
// sends the buyer to the invoice.
use BTCPay\Server\Factory;

require '/var/www/html/config/config.inc.php';
// The cart's totals come from services in the front office's Symfony
// container, which a request to the shop boots and a script must boot itself.
global $kernel;
$kernel = new FrontKernel('prod', false);
$kernel->boot();
$module = Module::getInstanceByName('btcpay');
$context = Context::getContext();
$language = (int) Configuration::get('PS_LANG_DEFAULT');
$context->language = new Language($language);
// The shop's default currency is EUR; the buyer pays in dollars, as on Magento.
$context->currency = new Currency((int) Currency::getIdByIsoCode('USD'));

$product = new Product();
$product->name = [$language => 'Bezel'];
$product->link_rewrite = [$language => 'bezel'];
$product->price = 12;
$product->id_tax_rules_group = 0;
$product->id_category_default = (int) Configuration::get('PS_HOME_CATEGORY');
$product->active = true;
$product->add();
$product->addToCategories([(int) Configuration::get('PS_HOME_CATEGORY')]);
StockAvailable::setQuantity($product->id, 0, 100);

$customer = new Customer();
$customer->firstname = 'Widget';
$customer->lastname = 'Buyer';
$customer->email = 'buyer-' . time() . '@widget-shop.test';
$customer->passwd = (new PrestaShop\PrestaShop\Core\Crypto\Hashing())->hash(Tools::passwdGen(16));
$customer->is_guest = true;
$customer->id_default_group = (int) Configuration::get('PS_GUEST_GROUP');
$customer->add();
$customer->updateGroup([(int) Configuration::get('PS_GUEST_GROUP')]);

$country = (int) Country::getByIso('US');
$address = new Address();
$address->id_customer = $customer->id;
$address->id_country = $country;
$address->id_state = (int) State::getIdByIso('TX', $country);
$address->alias = 'Home';
$address->firstname = 'Widget';
$address->lastname = 'Buyer';
$address->address1 = '1 Main St';
$address->city = 'Austin';
$address->postcode = '78701';
$address->phone = '5125550100';
$address->add();

$cart = new Cart();
$cart->id_customer = $customer->id;
$cart->id_address_delivery = $address->id;
$cart->id_address_invoice = $address->id;
$cart->id_currency = $context->currency->id;
$cart->id_lang = $language;
$cart->id_shop = $context->shop->id;
$cart->id_shop_group = $context->shop->id_shop_group;
$cart->secure_key = $customer->secure_key;
$cart->add();
$context->cart = $cart;
$context->customer = $customer;
$cart->updateQty(1, $product->id);
$options = $cart->getDeliveryOptionList();
$carrier = array_key_first($options[$address->id] ?? []);
$cart->setDeliveryOption([$address->id => $carrier]);
$cart->update();

// The checkout's payment step: the module offers its option only while BTCPay
// reports its node fully synced.
$offered = count($module->hookPaymentOptions());
$url = (new Factory($module, $context))->createPaymentRequest($customer, $cart);
$total = $cart->getOrderTotal(true);
$currency = $context->currency->iso_code;
echo 'RESULT url=' . ($url ?? '') . " cart={$cart->id} total={$total} currency={$currency}"
    . " offered={$offered}\n";
