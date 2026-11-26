<?php

/**
 * @package     pkg_openreceive
 * @copyright   (C) 2026 OpenReceive
 * @license     GPL-2.0-or-later; see LICENSE
 */

declare(strict_types=1);

namespace OpenReceiveHikaShop;

\defined('_JEXEC') or die;

/**
 * Moves an order whose payment settled to the payment method's paid status
 * (HikaShop's "confirmed" unless the merchant picked another). That runs
 * after the settlement transaction committed (afterPaid), through HikaShop's
 * own order class: the invoice number, the emails, the stock and the other
 * plugins' hooks are HikaShop's. Should it fail there, the settled payment
 * row and the order still unpaid are the record of what is left, and every
 * reconcile pass and checkout request finishes it (repair).
 *
 * An order someone moved out of the unpaid statuses, cancelled for example,
 * is the merchant's decision: it is never moved again. Its payment is in its
 * history.
 */
final class Completion
{
    /** At most this many orders per repair pass. */
    public const REPAIR_BATCH = 50;

    public static function complete(int $orderId): void
    {
        $connection = Runtime::connection();
        // One process completes an order at a time; another skips it.
        $lock = substr('or-hk-' . hash('sha256', Runtime::prefix() . ':' . $orderId), 0, 64);
        if ((int) ($connection->query('SELECT GET_LOCK(?, 0) AS acquired', [$lock])[0]['acquired'] ?? 0) !== 1) {
            return;
        }
        try {
            $order = Host::order((string) $orderId);
            if ($order === null) {
                return;
            }
            $settled = $connection->query('SELECT payment_hash FROM ' . Runtime::table() . ' WHERE reference = ? AND status = ? ORDER BY id LIMIT 1', [(string) $orderId, 'settled']);
            if ($settled === []) {
                return;
            }
            $hash = (string) $settled[0]['payment_hash'];
            Runtime::hikashop();
            $plugin = hikashop_import(Runtime::GROUP, Runtime::PLUGIN);
            if (!$plugin instanceof \plgHikashoppaymentOpenreceive) {
                throw new \RuntimeException('HikaShop did not load the OpenReceive payment plugin.');
            }
            $paid = $plugin->paidStatus($order['order_payment_id']);
            if (!Host::unpaid($order)) {
                if ($order['order_status'] !== $paid) {
                    (new Logger())->warning('Order ' . $order['order_number'] . ' (id ' . $orderId . ') was paid, payment ' . $hash . ', but someone moved it to "' . $order['order_status'] . '" first. OpenReceive left its status as it is; the payment is in the order\'s history.');
                }
                return;
            }
            $plugin->markPaid($orderId, $paid, $hash);
        } finally {
            $connection->query('SELECT RELEASE_LOCK(?) AS released', [$lock]);
        }
    }

    /** Completes the orders whose payment settled but that are still unpaid. */
    public static function repair(): void
    {
        foreach (PaymentHistory::pending(Runtime::connection(), Runtime::prefix(), Runtime::unpaidStatuses(), self::REPAIR_BATCH) as $orderId) {
            try {
                self::complete($orderId);
            } catch (\Throwable $error) {
                // The settled row and the unpaid order stay the record; the next pass tries again.
                (new Logger())->error('Could not complete order ' . $orderId . ': ' . Runtime::errorMessage($error));
            }
        }
    }
}
