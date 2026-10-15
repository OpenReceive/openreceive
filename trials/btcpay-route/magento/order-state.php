<?php
// php order-state.php <order increment id>: the order as the webhook left it.
use Magento\Framework\App\Bootstrap;

require '/var/www/html/app/bootstrap.php';
$objects = Bootstrap::create(BP, $_SERVER)->getObjectManager();
$order = $objects->get(Magento\Sales\Model\OrderFactory::class)->create()->loadByIncrementId($argv[1]);
printf("RESULT state=%s status=%s invoiced=%d paid=%s\n", $order->getState(), $order->getStatus(),
    $order->hasInvoices() ? 1 : 0, $order->getTotalPaid() ?? '0');
