<?php

declare(strict_types=1);

use Box\Mod\Openreceive\Support\Runtime;

/**
 * The FOSSBilling payment gateway. FOSSBilling owns clients, invoices and
 * prices; the OpenReceive module (modules/Openreceive) holds the codes, the
 * routes and the engine, which keeps payment attempts in FOSSBilling's own
 * database. The buyer pays on the invoice's payment page; a settled payment
 * is recorded by the module itself, never through ipn.php.
 */
class Payment_Adapter_OpenReceive
{
    protected ?Pimple\Container $di = null;

    public function __construct(private readonly array $config = [])
    {
    }

    public function setDi(Pimple\Container $di): void
    {
        $this->di = $di;
        self::loadModule();
        Runtime::setDi($di);
    }

    public static function getConfig(): array
    {
        return [
            'can_load_in_iframe' => false,
            'supports_one_time_payments' => true,
            'supports_subscriptions' => false,
            'description' => 'Bitcoin Lightning payments straight into your own wallet, with optional USDT, USDC, SOL and ETH swaps. Save the codes under Extensions → OpenReceive, or with php console.php openreceive:configure.',
            'logo' => [
                'logo' => 'OpenReceive/logo.svg',
                'height' => '30px',
                'width' => '30px',
            ],
            'form' => [],
        ];
    }

    /** The checkout, on the page FOSSBilling opens after it checked that this visitor may pay the invoice. */
    public function getHtml($api_admin, int $invoice_id, bool $subscription): string
    {
        $invoice = $this->di['db']->getExistingModelById('Invoice', $invoice_id, 'Invoice not found');
        if (Runtime::environment()['NWC_URI'] === '') {
            return '<p>This payment method is not set up yet. Choose another one, or contact us.</p>';
        }
        return Runtime::checkoutHtml($invoice);
    }

    /** OpenReceive records its own payments; a transaction sent to ipn.php for it is refused. */
    public function processTransaction($api_admin, int $id, array $data, int $gateway_id): bool
    {
        throw new Payment_Exception('OpenReceive records its payments itself. This transaction did not come from it.');
    }

    private static function loadModule(): void
    {
        if (!class_exists(Runtime::class)) {
            throw new Payment_Exception('The OpenReceive module is missing: unzip the whole release into FOSSBilling\'s folder, so modules/Openreceive exists too.');
        }
    }
}
