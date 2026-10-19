<?php

declare(strict_types=1);

namespace PrestaShop\Module\OpenReceive;

use OpenReceive\Host as OpenReceiveHost;
use OpenReceive\Hosts\AfterPaid;
use OpenReceive\PaymentSettlement;
use OpenReceive\Server\AuthorizeContext;

/**
 * The bridge between the engine and PrestaShop's orders. The reference is
 * the order's id; PrestaShop owns the order, its customer and its total.
 *
 * A settled payment is recorded the way PrestaShop's own payment modules
 * record one: an order payment whose transaction id is the payment hash,
 * inside the settlement transaction. Once that has committed, the order
 * moves to PrestaShop's "Payment accepted", which makes its invoice, sends
 * the customer's email and runs the other modules' hooks (Completion).
 *
 * PrestaShop can split one cart into several orders that share a reference.
 * The first of them carries the payment, for their total.
 */
final class Host implements OpenReceiveHost, AfterPaid
{
    /** An order this module created, by its id. */
    public static function order(string $reference): ?\Order
    {
        if (!preg_match('/\A[1-9][0-9]{0,9}\z/', $reference)) {
            return null;
        }
        $order = new \Order((int) $reference);
        return \Validate::isLoadedObject($order) && $order->module === Runtime::MODULE ? $order : null;
    }

    /**
     * The orders PrestaShop made from the same cart, the first one first.
     *
     * @return list<array{id_order: string, current_state: string, total_paid_tax_incl: string}>
     */
    public static function group(\Order $order): array
    {
        $rows = Runtime::connection()->query(
            'SELECT id_order, current_state, total_paid_tax_incl FROM `' . _DB_PREFIX_ . 'orders` WHERE reference = ? AND id_cart = ? ORDER BY id_order',
            [(string) $order->reference, (int) $order->id_cart],
        );
        /** @var list<array{id_order: string, current_state: string, total_paid_tax_incl: string}> $rows */
        return $rows === [] ? [['id_order' => (string) $order->id, 'current_state' => (string) $order->current_state, 'total_paid_tax_incl' => (string) $order->total_paid_tax_incl]] : $rows;
    }

    /** The order whose checkout pays for the whole cart. */
    public static function primaryId(\Order $order): int
    {
        return (int) self::group($order)[0]['id_order'];
    }

    /**
     * The customer the order belongs to, signed in (or still in their guest
     * checkout), or a browser PrestaShop already showed the order's page to
     * (see Runtime::checkoutHtml). The console is the shop owner.
     */
    public function authorize(AuthorizeContext $context): bool
    {
        $order = self::order($context->reference());
        if ($order === null) {
            return false;
        }
        if (PHP_SAPI === 'cli') {
            return true;
        }
        $shop = \Context::getContext();
        $customer = $shop->customer;
        if ($customer instanceof \Customer && $customer->isLogged(true) && (int) $customer->id === (int) $order->id_customer) {
            return true;
        }
        return isset($shop->cookie) && Grants::allows((string) $shop->cookie->{Runtime::COOKIE_GRANTS}, (int) $order->id);
    }

    /** What an order still awaiting its payment comes to, with tax and shipping, in its own currency. */
    public function amountFor(string $reference): ?array
    {
        $order = self::order($reference);
        if ($order === null || (int) $order->current_state !== Runtime::awaitingState()) {
            return null;
        }
        $group = self::group($order);
        if ((int) $group[0]['id_order'] !== (int) $order->id) {
            return null;
        }
        $currency = new \Currency((int) $order->id_currency);
        $total = Amounts::total(array_column($group, 'total_paid_tax_incl'), (int) ($currency->precision ?? 2));
        if (!Amounts::isPositive($total)) {
            return null;
        }
        return [
            'currency' => strtoupper((string) $currency->iso_code),
            'value' => $total,
            'description' => 'Order ' . $order->reference,
        ];
    }

    /**
     * Records the payment inside the settlement transaction, so the two
     * commit together: an order payment whose transaction id is the payment
     * hash, for the amount the customer was charged.
     */
    public function onPaid(PaymentSettlement $settlement): void
    {
        $order = self::order($settlement->reference);
        if ($order === null) {
            throw new \RuntimeException("Order {$settlement->reference} is missing; its payment {$settlement->paymentHash} is settled in the wallet.");
        }
        $recorded = Runtime::connection()->query(
            'SELECT id_order_payment FROM `' . _DB_PREFIX_ . 'order_payment` WHERE order_reference = ? AND transaction_id = ?',
            [(string) $order->reference, $settlement->paymentHash],
        );
        if ($recorded !== []) {
            return;
        }
        // PrestaShop's payment API takes a float; the value is the exact decimal string, rounded to cents.
        if (!$order->addOrderPayment((float) self::paidAmount($settlement, $order), null, $settlement->paymentHash)) {
            throw new \RuntimeException("PrestaShop did not record the payment {$settlement->paymentHash} on order {$order->reference}.");
        }
    }

    /** Moves the order to "Payment accepted" once the payment has committed. */
    public function afterPaid(PaymentSettlement $settlement): void
    {
        Completion::complete((int) $settlement->reference);
    }

    /** The amount the customer was charged: the order's total when the Lightning invoice was made. */
    private static function paidAmount(PaymentSettlement $settlement, \Order $order): string
    {
        $rows = $settlement->connection?->query('SELECT checkout_data FROM ' . Runtime::table() . ' WHERE payment_hash = ?', [$settlement->paymentHash]) ?? [];
        $checkout = json_decode((string) ($rows[0]['checkout_data'] ?? ''), true);
        $fiat = is_array($checkout) ? ($checkout['fiat_quote']['fiat'] ?? null) : null;
        $currency = new \Currency((int) $order->id_currency);
        if (is_array($fiat) && strtoupper((string) ($fiat['currency'] ?? '')) === strtoupper((string) $currency->iso_code) && is_string($fiat['value'] ?? null)) {
            return $fiat['value'];
        }
        return Amounts::total(array_column(self::group($order), 'total_paid_tax_incl'), (int) ($currency->precision ?? 2));
    }
}
