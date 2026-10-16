<?php

declare(strict_types=1);

namespace Paymenter\Extensions\Gateways\OpenReceive;

require_once __DIR__ . '/autoload.php';

use App\Attributes\ExtensionMeta;
use App\Classes\Extension\Gateway;
use App\Models\Invoice;
use Paymenter\Extensions\Gateways\OpenReceive\Support\Runtime;

/**
 * The Paymenter gateway. Paymenter owns clients, invoices and prices; the
 * bundled OpenReceive engine owns payment attempts in Paymenter's own
 * database. The buyer pays from the invoice's payment dialog, and a settled
 * payment is recorded on the invoice with Paymenter's own addPayment.
 */
#[ExtensionMeta(
    name: 'OpenReceive',
    description: 'Bitcoin Lightning payments straight into your own wallet. Optional USDT, USDC, SOL and ETH swaps settle as BTC over Lightning.',
    version: Runtime::VERSION,
    author: 'OpenReceive',
    url: 'https://openreceive.org/integrations/paymenter',
)]
class OpenReceive extends Gateway
{
    /** Paymenter calls this on every request and console command while a gateway of this extension exists. */
    public function boot()
    {
        Runtime::boot();
    }

    public function getConfig($values = [])
    {
        return [
            [
                'name' => 'nwc_uri',
                'label' => 'Receive-only NWC code',
                'type' => 'password',
                'required' => true,
                'encrypted' => true,
                'description' => 'A Nostr Wallet Connect code that can only create invoices and read payments. Every payment goes straight to this wallet.',
            ],
            [
                'name' => 'lsc_uri_primary',
                'label' => 'Swap provider code (optional)',
                'type' => 'password',
                'required' => false,
                'encrypted' => true,
                'description' => 'Lets buyers pay with USDT, USDC, SOL or ETH. The provider converts the payment to BTC over Lightning into the wallet above.',
            ],
        ];
    }

    /** Hidden at checkout until a wallet code is saved. */
    public function canUseGateway($total, $currency, $type, $items = [])
    {
        return trim((string) $this->config('nwc_uri')) !== '';
    }

    /** The checkout, rendered inside the invoice's payment dialog. */
    public function pay(Invoice $invoice, $total)
    {
        return Runtime::checkoutView($invoice);
    }

    /** Called after the admin creates the gateway. */
    public function enabled($gateway)
    {
        Runtime::afterSave($gateway);
    }

    /** Called after the admin saves the gateway's settings. */
    public function updated($gateway)
    {
        Runtime::afterSave($gateway);
    }

    /**
     * `php artisan app:extension:install gateway OpenReceive`: creates the
     * tables and the gateway row, which makes the openreceive:* commands
     * available. The admin area's "create gateway" does the same through enabled().
     */
    public function installed()
    {
        Runtime::migrate();
        Runtime::ensureGateway();
    }

    public function upgraded($oldVersion = null)
    {
        Runtime::migrate();
    }
}
