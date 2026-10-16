<?php

declare(strict_types=1);

namespace Paymenter\Extensions\Gateways\OpenReceive\Support;

use App\Helpers\ExtensionHelper;
use App\Models\Invoice;
use Illuminate\Support\Facades\Auth;
use OpenReceive\Host as OpenReceiveHost;
use OpenReceive\PaymentSettlement;
use OpenReceive\Server\AuthorizeContext;
use OpenReceive\Storage\PaymentsSchema;

/**
 * The bridge between the engine and Paymenter's invoices. The reference is
 * the invoice id; Paymenter owns the invoice, its owner and its amount.
 */
final class Host implements OpenReceiveHost
{
    public static function invoice(string $reference): ?Invoice
    {
        if (!preg_match('/\A[1-9][0-9]{0,17}\z/', $reference)) {
            return null;
        }
        return Invoice::find((int) $reference);
    }

    /** Only the signed-in client the invoice belongs to may pay it or follow its payment. */
    public function authorize(AuthorizeContext $context): bool
    {
        $invoice = self::invoice($context->reference());
        $user = Auth::id();
        return $invoice !== null && $user !== null && (int) $invoice->user_id === (int) $user;
    }

    /** What is still due on a pending invoice, in its own currency. */
    public function amountFor(string $reference): ?array
    {
        $invoice = self::invoice($reference);
        if ($invoice === null || $invoice->status !== Invoice::STATUS_PENDING) {
            return null;
        }
        $remaining = number_format((float) $invoice->remaining, 2, '.', '');
        if ((float) $remaining <= 0) {
            return null;
        }
        return [
            'currency' => strtoupper((string) $invoice->currency_code),
            'value' => $remaining,
            'description' => 'Invoice #' . ($invoice->number ?: $invoice->id),
        ];
    }

    /**
     * Records the payment on the invoice inside the settlement transaction,
     * so the two commit together. The payment hash is the transaction id,
     * which makes a repeat a no-op in Paymenter as well.
     */
    public function onPaid(PaymentSettlement $settlement): void
    {
        $invoice = self::invoice($settlement->reference);
        if ($invoice === null) {
            throw new \RuntimeException("Invoice {$settlement->reference} is missing; its payment {$settlement->paymentHash} is settled in the wallet.");
        }
        ExtensionHelper::addPayment($invoice->id, Runtime::EXTENSION, self::paidAmount($settlement, $invoice), transactionId: $settlement->paymentHash);
    }

    /** The amount the buyer was charged: the invoice's amount when the Lightning invoice was made. */
    private static function paidAmount(PaymentSettlement $settlement, Invoice $invoice): string
    {
        $rows = $settlement->connection?->query('SELECT checkout_data FROM ' . PaymentsSchema::DEFAULT_TABLE . ' WHERE payment_hash = ?', [$settlement->paymentHash]) ?? [];
        $checkout = json_decode((string) ($rows[0]['checkout_data'] ?? ''), true);
        $fiat = is_array($checkout) ? ($checkout['fiat_quote']['fiat'] ?? null) : null;
        if (is_array($fiat) && strtoupper((string) ($fiat['currency'] ?? '')) === strtoupper((string) $invoice->currency_code) && is_string($fiat['value'] ?? null)) {
            return $fiat['value'];
        }
        return number_format((float) $invoice->remaining, 2, '.', '');
    }
}
