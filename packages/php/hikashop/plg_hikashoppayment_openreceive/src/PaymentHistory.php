<?php

/**
 * @package     pkg_openreceive
 * @copyright   (C) 2026 OpenReceive
 * @license     GPL-2.0-or-later; see LICENSE
 */

declare(strict_types=1);

namespace OpenReceiveHikaShop;

use OpenReceive\Storage\DatabaseConnection;
use OpenReceive\Storage\PaymentsSchema;

/**
 * A settled payment, written on its order the way HikaShop records a
 * payment notification: a row in the order's history whose payment id is
 * the payment hash, with the amount. It runs inside the settlement
 * transaction, on the connection the engine hands over, so it commits with
 * the payment row or rolls back with it. The status change comes after the
 * commit (Completion), because it is HikaShop's own work: emails, invoice
 * number, stock and other plugins' hooks.
 *
 * Plain SQL on HikaShop's tables, so it is tested without Joomla.
 */
final class PaymentHistory
{
    public const METHOD = 'openreceive';

    /**
     * Records the payment once; a second call for the same hash records
     * nothing. Returns whether it wrote the row.
     */
    public static function record(DatabaseConnection $db, string $prefix, int $orderId, string $paymentHash, string $amount, int $paidAt): bool
    {
        $table = $prefix . 'hikashop_history';
        $orders = $db->query('SELECT order_status FROM ' . $prefix . 'hikashop_order WHERE order_id = ?', [$orderId]);
        if ($orders === []) {
            throw new \RuntimeException("Order {$orderId} is missing; its payment {$paymentHash} is settled in the wallet.");
        }
        if ($db->query('SELECT history_id FROM ' . $table . ' WHERE history_order_id = ? AND history_payment_id = ?', [$orderId, $paymentHash]) !== []) {
            return false;
        }
        $db->execute(
            'INSERT INTO ' . $table . ' (history_order_id, history_created, history_ip, history_new_status, history_reason, history_notified, history_amount, history_package_id, history_payment_id, history_payment_method, history_data, history_type, history_user_id)'
            . ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
                $orderId,
                $paidAt,
                '',
                (string) $orders[0]['order_status'],
                'Bitcoin Lightning payment received',
                0,
                $amount,
                0,
                $paymentHash,
                self::METHOD,
                'OpenReceive payment hash ' . $paymentHash,
                'payment',
                0,
            ],
        );
        return true;
    }

    /**
     * The orders with a settled payment that are still unpaid in HikaShop:
     * what is left to complete. The order id and the reference compare as
     * numbers, so the two tables' collations never meet.
     *
     * @param list<string> $unpaidStatuses
     * @return list<int>
     */
    public static function pending(DatabaseConnection $db, string $prefix, array $unpaidStatuses, int $limit = 50): array
    {
        $unpaidStatuses = array_values(array_filter($unpaidStatuses, static fn (string $status): bool => $status !== ''));
        if ($unpaidStatuses === []) {
            return [];
        }
        $rows = $db->query(
            'SELECT DISTINCT o.order_id FROM ' . $prefix . PaymentsSchema::DEFAULT_TABLE . ' p'
            . ' INNER JOIN ' . $prefix . 'hikashop_order o ON o.order_id = p.reference'
            . ' WHERE p.status = ? AND o.order_payment_method = ? AND o.order_type = ?'
            . ' AND o.order_status IN (' . implode(', ', array_fill(0, count($unpaidStatuses), '?')) . ')'
            . ' ORDER BY o.order_id LIMIT ' . max(1, $limit),
            ['settled', self::METHOD, 'sale', ...$unpaidStatuses],
        );
        return array_map(static fn (array $row): int => (int) $row['order_id'], $rows);
    }
}
