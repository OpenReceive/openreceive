<?php

declare(strict_types=1);

use PrestaShop\Module\OpenReceive\Runtime;

if (!defined('_PS_VERSION_')) {
    exit;
}

/**
 * Checkout's "Place order" with OpenReceive picked: PrestaShop creates the
 * order, unpaid, in the module's "Awaiting Bitcoin payment" state, and the
 * customer lands on its order confirmation page, where the checkout is.
 */
class OpenReceiveValidationModuleFrontController extends ModuleFrontController
{
    public function postProcess(): void
    {
        $cart = $this->context->cart;
        if (!Validate::isLoadedObject($cart) || !$cart->id_customer || !$cart->id_address_delivery || !$cart->id_address_invoice || !$this->module->active) {
            Tools::redirect('index.php?controller=order&step=1');
        }
        $offered = false;
        foreach (Module::getPaymentModules() as $module) {
            $offered = $offered || $module['name'] === $this->module->name;
        }
        $state = Runtime::awaitingState();
        if (!$offered || $state === 0 || !Runtime::ready()) {
            Tools::redirect('index.php?controller=order&step=1');
        }
        $customer = new Customer((int) $cart->id_customer);
        if (!Validate::isLoadedObject($customer)) {
            Tools::redirect('index.php?controller=order&step=1');
        }
        $this->module->validateOrder(
            (int) $cart->id,
            $state,
            (float) $cart->getOrderTotal(true, Cart::BOTH),
            Runtime::paymentName(),
            null,
            [],
            (int) $this->context->currency->id,
            false,
            $customer->secure_key,
        );
        Tools::redirect('index.php?controller=order-confirmation&id_cart=' . (int) $cart->id . '&id_module=' . (int) $this->module->id . '&id_order=' . (int) $this->module->currentOrder . '&key=' . $customer->secure_key);
    }
}
