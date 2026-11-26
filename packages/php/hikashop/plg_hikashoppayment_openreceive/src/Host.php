<?php

/**
 * @package     pkg_openreceive
 * @copyright   (C) 2026 OpenReceive
 * @license     GPL-2.0-or-later; see LICENSE
 */

declare(strict_types=1);

namespace OpenReceiveHikaShop;

use Joomla\CMS\Factory;
use OpenReceive\Host as OpenReceiveHost;
use OpenReceive\Hosts\AfterPaid;
use OpenReceive\PaymentSettlement;
use OpenReceive\Server\AuthorizeContext;

\defined('_JEXEC') or die;

/**
 * The bridge between the engine and HikaShop's orders. The reference is the
 * order's id; HikaShop owns the order, its customer and its total.
 *
 * A settled payment is written on the order's history inside the settlement
 * transaction (PaymentHistory). Once that has committed, the order moves to
 * the payment method's paid status through HikaShop's own order class, which
 * makes its invoice number, sends its emails and runs the other plugins'
 * hooks (Completion).
 */
final class Host implements OpenReceiveHost, AfterPaid
{
    /**
     * A sale made with this plugin, by its id, as HikaShop's order table
     * holds it.
     *
     * @return array{order_id: int, order_number: string, order_status: string, order_user_id: int, order_full_price: string, order_currency_id: int, order_payment_id: int}|null
     */
    public static function order(string $reference): ?array
    {
        if (!preg_match('/\A[1-9][0-9]{0,9}\z/', $reference)) {
            return null;
        }
        $rows = Runtime::connection()->query(
            'SELECT order_id, order_number, order_status, order_user_id, order_full_price, order_currency_id, order_payment_id FROM ' . Runtime::prefix() . 'hikashop_order'
            . ' WHERE order_id = ? AND order_type = ? AND order_payment_method = ?',
            [(int) $reference, 'sale', Runtime::PLUGIN],
        );
        if ($rows === []) {
            return null;
        }
        $row = $rows[0];
        return [
            'order_id' => (int) $row['order_id'],
            'order_number' => (string) $row['order_number'],
            'order_status' => (string) $row['order_status'],
            'order_user_id' => (int) $row['order_user_id'],
            'order_full_price' => (string) $row['order_full_price'],
            'order_currency_id' => (int) $row['order_currency_id'],
            'order_payment_id' => (int) $row['order_payment_id'],
        ];
    }

    /** Whether HikaShop still counts the order as unpaid, so it may be paid. */
    public static function unpaid(array $order): bool
    {
        return in_array($order['order_status'], Runtime::unpaidStatuses(), true);
    }

    /**
     * The order's customer, signed in with their account, or a browser
     * HikaShop already showed the order's page to (see
     * Runtime::checkoutHtml). The console is the shop owner.
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
        $app = Factory::getApplication();
        $identity = $app->getIdentity();
        if ($identity !== null && !$identity->guest && $order['order_user_id'] > 0) {
            $owner = Runtime::connection()->query('SELECT user_cms_id FROM ' . Runtime::prefix() . 'hikashop_user WHERE user_id = ?', [$order['order_user_id']]);
            if ($owner !== [] && (int) $owner[0]['user_cms_id'] > 0 && (int) $owner[0]['user_cms_id'] === (int) $identity->id) {
                return true;
            }
        }
        return Grants::allows((string) $app->getSession()->get(Runtime::SESSION_GRANTS, ''), $order['order_id']);
    }

    /** What an order still awaiting its payment comes to, with tax and shipping, in its own currency. */
    public function amountFor(string $reference): ?array
    {
        $order = self::order($reference);
        if ($order === null || !self::unpaid($order)) {
            return null;
        }
        $currency = self::currency($order['order_currency_id']);
        if ($currency === null) {
            return null;
        }
        $total = Amounts::total($order['order_full_price'], $currency['decimals']);
        if (!Amounts::isPositive($total)) {
            return null;
        }
        return [
            'currency' => $currency['code'],
            'value' => $total,
            'description' => 'Order ' . $order['order_number'],
        ];
    }

    /**
     * Writes the payment on the order's history inside the settlement
     * transaction, so the two commit together, once per payment hash.
     */
    public function onPaid(PaymentSettlement $settlement): void
    {
        $db = $settlement->connection ?? Runtime::connection();
        $order = self::order($settlement->reference);
        if ($order === null) {
            throw new \RuntimeException("Order {$settlement->reference} is missing; its payment {$settlement->paymentHash} is settled in the wallet.");
        }
        PaymentHistory::record($db, Runtime::prefix(), $order['order_id'], $settlement->paymentHash, self::paidAmount($settlement, $order), $settlement->paidAt);
    }

    /** Moves the order to the paid status once the payment has committed. */
    public function afterPaid(PaymentSettlement $settlement): void
    {
        Completion::complete((int) $settlement->reference);
    }

    /** @return array{code: string, decimals: int}|null */
    public static function currency(int $currencyId): ?array
    {
        Runtime::hikashop();
        $rows = Runtime::connection()->query('SELECT currency_code, currency_locale FROM ' . Runtime::prefix() . 'hikashop_currency WHERE currency_id = ?', [$currencyId]);
        if ($rows === []) {
            return null;
        }
        $locale = hikashop_unserialize((string) $rows[0]['currency_locale']);
        $decimals = is_array($locale) && isset($locale['int_frac_digits']) ? (int) $locale['int_frac_digits'] : 2;
        return ['code' => strtoupper((string) $rows[0]['currency_code']), 'decimals' => $decimals];
    }

    /** The amount the customer was charged, as HikaShop's history shows amounts: the order's total when the invoice was made, and its currency. */
    public static function paidAmount(PaymentSettlement $settlement, array $order): string
    {
        $rows = $settlement->connection?->query('SELECT checkout_data FROM ' . Runtime::table() . ' WHERE payment_hash = ?', [$settlement->paymentHash]) ?? [];
        $checkout = json_decode((string) ($rows[0]['checkout_data'] ?? ''), true);
        $fiat = is_array($checkout) ? ($checkout['fiat_quote']['fiat'] ?? null) : null;
        $currency = self::currency($order['order_currency_id']);
        $code = $currency['code'] ?? '';
        if (is_array($fiat) && strtoupper((string) ($fiat['currency'] ?? '')) === $code && is_string($fiat['value'] ?? null)) {
            return $fiat['value'] . ' ' . $code;
        }
        return Amounts::total($order['order_full_price'], $currency['decimals'] ?? 2) . ' ' . $code;
    }
}
