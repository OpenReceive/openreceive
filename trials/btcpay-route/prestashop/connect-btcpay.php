<?php
// php connect-btcpay.php <BTCPay URL> <API key> <BTCPay store id>
// What the module's configuration page does once BTCPay's "authorize" step
// hands it a key (ConfigureController::validate in module 6.3.3): it checks
// BTCPay's version and that the store has a payment method, saves the server,
// the key and the store, and creates BTCPay's webhook to the shop.
use BTCPay\Constants;
use BTCPay\Server\Client;
use PrestaShop\PrestaShop\Adapter\Configuration;

require '/var/www/html/config/config.inc.php';
Module::getInstanceByName('btcpay');

[, $url, $apiKey, $storeId] = $argv;
$configuration = new Configuration();
$client = new Client($url, $apiKey);
$version = $client->server()->getInfo()->getVersion();
$methods = count($client->payment()->getPaymentMethods($storeId));
$configuration->set(Constants::CONFIGURATION_BTCPAY_HOST, $url);
$configuration->set(Constants::CONFIGURATION_BTCPAY_API_KEY, $apiKey);
$configuration->set(Constants::CONFIGURATION_BTCPAY_STORE_ID, $storeId);
$client->webhook()->ensureWebhook($storeId);
$webhook = (string) $configuration->get(Constants::CONFIGURATION_BTCPAY_WEBHOOK_ID);
$target = $client->webhook()->getCurrent($storeId, $webhook)?->getUrl() ?? '';
echo "RESULT version={$version} methods={$methods} webhook={$webhook} url={$target}\n";
