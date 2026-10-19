<?php

declare(strict_types=1);

namespace PrestaShop\Module\OpenReceive;

use OpenReceive\Storage\DatabaseConnection;
use OpenReceive\Storage\PaymentsSchema;

/**
 * Moves an order whose payment settled to PrestaShop's "Payment accepted".
 * That runs after the settlement transaction committed (afterPaid), and its
 * work is PrestaShop's own: the invoice, the customer's email and the other
 * modules' hooks. Should it fail there, the settled payment row and the order
 * still in the module's awaiting state are the record of what is left, and
 * every reconcile pass and checkout request finishes it (repair).
 *
 * An order someone moved out of the awaiting state, cancelled for example,
 * is the merchant's decision: it is never moved again. Its payment is on it.
 */
final class Completion
{
    /** At most this many orders per repair pass. */
    public const REPAIR_BATCH = 50;

    public static function complete(int $orderId): void
    {
        $connection = Runtime::connection();
        // One process completes an order at a time; another skips it.
        $lock = substr('or-ps-' . hash('sha256', _DB_PREFIX_ . ':' . $orderId), 0, 64);
        if ((int) ($connection->query('SELECT GET_LOCK(?, 0) AS acquired', [$lock])[0]['acquired'] ?? 0) !== 1) {
            return;
        }
        try {
            $order = Host::order((string) $orderId);
            if ($order === null) {
                return;
            }
            $primary = Host::primaryId($order);
            $settled = $connection->query('SELECT payment_hash FROM ' . Runtime::table() . ' WHERE reference = ? AND status = ? ORDER BY id LIMIT 1', [(string) $primary, 'settled']);
            if ($settled === []) {
                return;
            }
            $awaiting = Runtime::awaitingState();
            $paid = (int) \Configuration::get('PS_OS_PAYMENT');
            foreach (Host::group($order) as $row) {
                if ((int) $row['current_state'] !== $awaiting) {
                    if ((int) $row['current_state'] !== $paid) {
                        (new Logger())->warning('Order ' . $order->reference . ' (id ' . $row['id_order'] . ') was paid, payment ' . $settled[0]['payment_hash'] . ', but someone moved it out of "' . Runtime::AWAITING_NAME . '" first. OpenReceive left its state as it is; the payment is recorded on the order.');
                    }
                    continue;
                }
                $member = new \Order((int) $row['id_order']);
                $history = new \OrderHistory();
                $history->id_order = (int) $member->id;
                $history->changeIdOrderState($paid, $member, true);
                $history->addWithemail(true);
            }
        } finally {
            $connection->query('SELECT RELEASE_LOCK(?) AS released', [$lock]);
        }
    }

    /** Completes the orders whose payment settled but that still await it. */
    public static function repair(): void
    {
        $awaiting = Runtime::awaitingState();
        if ($awaiting === 0) {
            return;
        }
        foreach (self::pending(Runtime::connection(), _DB_PREFIX_, $awaiting) as $reference) {
            try {
                self::complete((int) $reference);
            } catch (\Throwable $error) {
                // The settled row and the awaiting order stay the record; the next pass tries again.
                (new Logger())->error('Could not complete order ' . $reference . ': ' . Runtime::errorMessage($error));
            }
        }
    }

    /**
     * The references (first order ids) with a settled payment while an order
     * of their cart still waits in the module's state. The order id and the
     * reference compare as numbers, so the two tables' collations never meet.
     *
     * @return list<string>
     */
    public static function pending(DatabaseConnection $db, string $prefix, int $awaitingState): array
    {
        $rows = $db->query(
            'SELECT DISTINCT p.reference FROM ' . $prefix . PaymentsSchema::DEFAULT_TABLE . ' p'
            . ' INNER JOIN ' . $prefix . 'orders first ON first.id_order = p.reference'
            . ' INNER JOIN ' . $prefix . 'orders o ON o.reference = first.reference AND o.id_cart = first.id_cart'
            . ' WHERE p.status = ? AND o.current_state = ? AND o.module = ?'
            . ' ORDER BY p.reference LIMIT ' . self::REPAIR_BATCH,
            ['settled', $awaitingState, Runtime::MODULE],
        );
        return array_map(static fn (array $row): string => (string) $row['reference'], $rows);
    }
}
