<?php
// php forward-to-payment.php <order increment id>
// What the buyer's browser does after Place Order: the module's
// ForwardToPayment controller, with the checkout session on that order,
// creates the BTCPay invoice, binds it to the order and redirects to it.
use Magento\Framework\App\Bootstrap;

require '/var/www/html/app/bootstrap.php';
$objects = Bootstrap::create(BP, $_SERVER)->getObjectManager();
$objects->get(Magento\Framework\App\State::class)->setAreaCode('frontend');
$order = $objects->get(Magento\Sales\Model\OrderFactory::class)->create()->loadByIncrementId($argv[1]);
$objects->get(Magento\Checkout\Model\Session::class)->setLastRealOrderId($order->getIncrementId());
$result = $objects->create(Storefront\BTCPay\Controller\Redirect\ForwardToPayment::class)->execute();
$response = $objects->get(Magento\Framework\App\Response\Http::class);
$result->renderResult($response);
$location = $response->getHeader('Location');
echo 'RESULT url=' . ($location ? $location->getFieldValue() : '') . "\n";
