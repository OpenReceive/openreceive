<?php

declare(strict_types=1);

namespace Box\Mod\Openreceive\Support;

use FOSSBilling\Environment;
use OpenReceive\Host as OpenReceiveHost;
use OpenReceive\Hosts\AfterPaid;
use OpenReceive\PaymentSettlement;
use OpenReceive\Server\AuthorizeContext;
use OpenReceive\Storage\PaymentsSchema;

/**
 * The bridge between the engine and FOSSBilling's invoices. The reference is
 * the invoice id; FOSSBilling owns the invoice, its client and its amount.
 *
 * A settled payment reaches the invoice the way FOSSBilling's own gateways
 * record one: a transaction in its payment log and the amount on the
 * client's balance, both inside the settlement transaction, then the
 * balance pays the invoice once that has committed. FOSSBilling's cron also
 * pays unpaid invoices from client balances, so a failure after the commit
 * still ends with a paid invoice.
 */
final class Host implements OpenReceiveHost, AfterPaid
{
    public static function invoice(string $reference): ?\Model_Invoice
    {
        if (!preg_match('/\A[1-9][0-9]{0,17}\z/', $reference)) {
            return null;
        }
        $invoice = Runtime::di()['db']->findOne('Invoice', 'id = :id', [':id' => (int) $reference]);
        return $invoice instanceof \Model_Invoice ? $invoice : null;
    }

    /**
     * The client the invoice belongs to, an admin, or a session that
     * FOSSBilling already let open this invoice's payment page (a visitor
     * holding the invoice's link, when the shop allows paying from it). The
     * console is the shop owner.
     */
    public function authorize(AuthorizeContext $context): bool
    {
        $invoice = self::invoice($context->reference());
        if ($invoice === null) {
            return false;
        }
        $di = Runtime::di();
        if (Environment::isCLI() || $di['auth']->isAdminLoggedIn()) {
            return true;
        }
        if ($di['auth']->isClientLoggedIn() && (int) $di['session']->get('client_id') === (int) $invoice->client_id) {
            return true;
        }
        $grants = $di['session']->get(Runtime::SESSION_GRANTS);
        return is_array($grants) && isset($grants[(int) $invoice->id]);
    }

    /** What an unpaid invoice comes to with tax, in its own currency. */
    public function amountFor(string $reference): ?array
    {
        $invoice = self::invoice($reference);
        if ($invoice === null || $invoice->status !== \Model_Invoice::STATUS_UNPAID) {
            return null;
        }
        $total = number_format(Runtime::di()['mod_service']('Invoice')->getTotalWithTax($invoice), 2, '.', '');
        if ((float) $total <= 0) {
            return null;
        }
        return [
            'currency' => strtoupper((string) $invoice->currency),
            'value' => $total,
            'description' => 'Invoice ' . self::number($invoice),
        ];
    }

    /**
     * Records the payment inside the settlement transaction, so the two
     * commit together: a processed transaction whose id is the payment hash,
     * and the amount on the client's balance.
     */
    public function onPaid(PaymentSettlement $settlement): void
    {
        $invoice = self::invoice($settlement->reference);
        if ($invoice === null) {
            throw new \RuntimeException("Invoice {$settlement->reference} is missing; its payment {$settlement->paymentHash} is settled in the wallet.");
        }
        $di = Runtime::di();
        $amount = self::paidAmount($settlement, $invoice);
        $gateway = Runtime::gateway();
        $now = date('Y-m-d H:i:s');

        $transaction = $di['db']->dispense('Transaction');
        $transaction->invoice_id = $invoice->id;
        $transaction->gateway_id = $gateway?->id;
        $transaction->txn_id = $settlement->paymentHash;
        $transaction->txn_status = 'settled';
        $transaction->amount = $amount;
        $transaction->currency = $invoice->currency;
        $transaction->type = \Payment_Transaction::TXTYPE_PAYMENT;
        $transaction->status = \Model_Transaction::STATUS_PROCESSED;
        $transaction->validate_ipn = 0;
        $transaction->note = 'OpenReceive Lightning payment ' . $settlement->paymentHash;
        $transaction->created_at = $now;
        $transaction->updated_at = $now;
        $transactionId = $di['db']->store($transaction);

        if ($gateway !== null && (int) $invoice->gateway_id !== (int) $gateway->id) {
            $invoice->gateway_id = $gateway->id;
            $invoice->updated_at = $now;
            $di['db']->store($invoice);
        }

        $client = $di['db']->getExistingModelById('Client', $invoice->client_id);
        $di['mod_service']('client')->addFunds($client, $amount, 'OpenReceive payment for invoice ' . self::number($invoice), ['type' => 'transaction', 'rel_id' => $transactionId]);
    }

    /** Pays the invoice from the balance the payment just added: FOSSBilling marks it paid, emails the receipt and activates the order. */
    public function afterPaid(PaymentSettlement $settlement): void
    {
        $invoice = self::invoice($settlement->reference);
        if ($invoice === null || $invoice->status !== \Model_Invoice::STATUS_UNPAID) {
            return;
        }
        $invoices = Runtime::di()['mod_service']('Invoice');
        if (!$invoice->approved) {
            $invoices->approveInvoice($invoice, ['use_credits' => false]);
        }
        $invoices->payInvoiceWithCredits($invoice);
    }

    /** The invoice's number as FOSSBilling prints it. */
    public static function number(\Model_Invoice $invoice): string
    {
        return $invoice->nr ? '#' . $invoice->serie . sprintf('%05s', $invoice->nr) : '#' . $invoice->id;
    }

    /** The amount the buyer was charged: the invoice's total when the Lightning invoice was made. */
    private static function paidAmount(PaymentSettlement $settlement, \Model_Invoice $invoice): string
    {
        $rows = $settlement->connection?->query('SELECT checkout_data FROM ' . PaymentsSchema::DEFAULT_TABLE . ' WHERE payment_hash = ?', [$settlement->paymentHash]) ?? [];
        $checkout = json_decode((string) ($rows[0]['checkout_data'] ?? ''), true);
        $fiat = is_array($checkout) ? ($checkout['fiat_quote']['fiat'] ?? null) : null;
        if (is_array($fiat) && strtoupper((string) ($fiat['currency'] ?? '')) === strtoupper((string) $invoice->currency) && is_string($fiat['value'] ?? null)) {
            return $fiat['value'];
        }
        return number_format(Runtime::di()['mod_service']('Invoice')->getTotalWithTax($invoice), 2, '.', '');
    }
}
