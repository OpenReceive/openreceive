<?php

declare(strict_types=1);

use PrestaShop\Module\OpenReceive\Host;
use PrestaShop\Module\OpenReceive\Requirements;
use PrestaShop\Module\OpenReceive\Runtime;
use PrestaShop\PrestaShop\Core\Payment\PaymentOption;

if (!defined('_PS_VERSION_')) {
    exit;
}

require_once __DIR__ . '/autoload.php';

/**
 * OpenReceive's payment module. The customer picks it at checkout;
 * PrestaShop creates the order in the module's "Awaiting Bitcoin payment"
 * state and shows the checkout on its order confirmation page, and on the
 * order's page in the customer's account or guest order tracking. A settled
 * payment is recorded on the order and moves it to "Payment accepted".
 */
class OpenReceive extends PaymentModule
{
    public function __construct()
    {
        $this->name = 'openreceive';
        $this->tab = 'payments_gateways';
        $this->version = '0.4.29';
        $this->author = 'OpenReceive';
        $this->need_instance = 0;
        $this->ps_versions_compliancy = ['min' => '9.0.0', 'max' => _PS_VERSION_];
        $this->controllers = ['validation', 'api'];
        $this->currencies = true;
        $this->currencies_mode = 'checkbox';
        $this->bootstrap = true;

        parent::__construct();

        $this->displayName = 'OpenReceive';
        $this->description = 'Accept Bitcoin over Lightning straight into your own wallet. Optional USDT, USDC, SOL and ETH swaps settle as BTC over Lightning.';
        $this->confirmUninstall = 'Uninstalling removes the saved wallet and swap codes. Payment records stay in the database. Keep the module installed while a swap payment may still need a refund.';
    }

    /**
     * Creates the engine's two tables in PrestaShop's database and the order
     * state an unpaid order waits in. The payment option stays hidden until a
     * wallet code is saved.
     */
    public function install(): bool
    {
        $missing = Requirements::missing();
        if ($missing !== []) {
            $this->_errors[] = 'OpenReceive needs ' . implode(', ', $missing) . '. The web server\'s PHP and the command-line PHP both need them.';
            return false;
        }
        if (!parent::install() || !$this->registerHook(['paymentOptions', 'displayPaymentReturn', 'displayOrderDetail'])) {
            return false;
        }
        try {
            Runtime::migrate();
            Runtime::ensureAwaitingState();
        } catch (\Throwable $error) {
            $this->_errors[] = Runtime::errorMessage($error);
            return false;
        }
        return true;
    }

    /**
     * Forgets the codes. The payment tables stay, a record of payments
     * received, and so does the order state, which orders refer to.
     */
    public function uninstall(): bool
    {
        Runtime::forgetCodes();
        \Configuration::deleteByName(Runtime::NAME_SETTING);
        return parent::uninstall();
    }

    /** @param array{cart: Cart} $params */
    public function hookPaymentOptions(array $params): array
    {
        if (!$this->active || !Runtime::ready() || Runtime::awaitingState() === 0 || !$this->offersCurrency((int) $params['cart']->id_currency)) {
            return [];
        }
        $option = new PaymentOption();
        $option->setModuleName($this->name)
            ->setCallToActionText(Runtime::paymentName())
            ->setAction($this->context->link->getModuleLink($this->name, 'validation', [], true))
            ->setAdditionalInformation('<p>' . htmlspecialchars(self::methods(), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . ' You pay on the next page, after placing the order.</p>');
        return [$option];
    }

    /** The order confirmation page: the checkout, for an order this module made. */
    public function hookDisplayPaymentReturn(array $params): string
    {
        return $this->checkoutFor($params['order'] ?? null);
    }

    /** The order's page in the customer's account, and guest order tracking. */
    public function hookDisplayOrderDetail(array $params): string
    {
        return $this->checkoutFor($params['order'] ?? null);
    }

    public function getContent(): string
    {
        $html = '';
        if (Tools::isSubmit('submitOpenreceive')) {
            // The name field comes back filled in; only a changed name is the merchant's own.
            $name = trim((string) Tools::getValue('OPENRECEIVE_NAME'));
            try {
                Runtime::saveCodes([
                    'nwc_uri' => (string) Tools::getValue('OPENRECEIVE_NWC_URI'),
                    'lsc_uri_primary' => (string) Tools::getValue('OPENRECEIVE_LSC_URI_PRIMARY'),
                ], $name === Runtime::paymentName() ? null : $name);
                $html .= $this->displayConfirmation('Saved. A wallet code is saved only after the wallet answered as receive-only.');
            } catch (\Throwable $error) {
                $html .= $this->displayError('Nothing was saved: ' . Runtime::errorMessage($error));
            }
        }
        try {
            $codes = Runtime::codes();
        } catch (\Throwable $error) {
            $codes = ['nwc_uri' => '', 'lsc_uri_primary' => ''];
            $html .= $this->displayError(Runtime::errorMessage($error));
        }
        $status = static fn (string $code): string => $code === '' ? 'not set' : 'set';
        $html .= $this->displayInformation(sprintf(
            'Receive-only NWC code: %s. Swap provider code: %s. The codes are stored encrypted and never shown again; paste a new one to replace it. Check everything with: php bin/console openreceive:doctor',
            $status($codes['nwc_uri']),
            $status($codes['lsc_uri_primary']),
        ));
        return $html . $this->settingsForm();
    }

    private function settingsForm(): string
    {
        $form = [
            'form' => [
                'legend' => ['title' => 'OpenReceive', 'icon' => 'icon-cogs'],
                'input' => [
                    [
                        'type' => 'password',
                        'label' => 'Receive-only NWC code',
                        'name' => 'OPENRECEIVE_NWC_URI',
                        'desc' => 'nostr+walletconnect://… from your wallet, receive-only. Leave empty to keep the saved code.',
                    ],
                    [
                        'type' => 'password',
                        'label' => 'Swap provider code',
                        'name' => 'OPENRECEIVE_LSC_URI_PRIMARY',
                        'desc' => 'Optional: lightning+swapconnect://… to also accept USDT, USDC, SOL and ETH. Leave empty to keep the saved code.',
                    ],
                    [
                        'type' => 'text',
                        'label' => 'Payment option name',
                        'name' => 'OPENRECEIVE_NAME',
                        'desc' => 'What checkout and the order call this payment method.',
                    ],
                ],
                'submit' => ['title' => 'Save'],
            ],
        ];
        $helper = new HelperForm();
        $helper->module = $this;
        $helper->name_controller = $this->name;
        $helper->token = Tools::getAdminTokenLite('AdminModules');
        $helper->currentIndex = AdminController::$currentIndex . '&configure=' . $this->name;
        $helper->default_form_language = (int) Configuration::get('PS_LANG_DEFAULT');
        $helper->submit_action = 'submitOpenreceive';
        $helper->fields_value = [
            'OPENRECEIVE_NWC_URI' => '',
            'OPENRECEIVE_LSC_URI_PRIMARY' => '',
            'OPENRECEIVE_NAME' => Runtime::paymentName(),
        ];
        return $helper->generateForm([$form]);
    }

    private function checkoutFor(mixed $order): string
    {
        if (!$order instanceof Order || $order->module !== $this->name || !$this->active) {
            return '';
        }
        if ((int) $order->current_state === Runtime::awaitingState()) {
            $primary = Host::primaryId($order);
            return Runtime::checkoutHtml($primary === (int) $order->id ? $order : new Order($primary), $this->_path);
        }
        return $order->hasBeenPaid() ? '<p class="openreceive-paid">Payment received. Thank you.</p>' : '';
    }

    private function offersCurrency(int $currencyId): bool
    {
        $currencies = $this->getCurrency($currencyId);
        foreach (is_array($currencies) ? $currencies : [] as $currency) {
            if ((int) $currency['id_currency'] === $currencyId) {
                return true;
            }
        }
        return false;
    }

    private static function methods(): string
    {
        try {
            return Runtime::codes()['lsc_uri_primary'] === ''
                ? 'Pay with Bitcoin over Lightning.'
                : 'Pay with Bitcoin over Lightning, or with USDT, USDC, SOL or ETH.';
        } catch (\Throwable) {
            return 'Pay with Bitcoin over Lightning.';
        }
    }
}
