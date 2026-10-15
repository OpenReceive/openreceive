<?php
// php install-webhook.php: what saving the BTCPay store in the admin does
// (Observer\CheckWebhooks): create the store's BTCPay webhook to this shop.
use Magento\Framework\App\Bootstrap;

require '/var/www/html/app/bootstrap.php';
$objects = Bootstrap::create(BP, $_SERVER)->getObjectManager();
$objects->get(Magento\Framework\App\State::class)->setAreaCode('adminhtml');
$installed = $objects->get(Storefront\BTCPay\Helper\Data::class)->installWebhookIfNeeded(1, true);
echo 'RESULT webhook=' . ($installed ? 1 : 0) . "\n";
