<?php
declare(strict_types=1);
namespace OpenReceive\WP;
defined('ABSPATH') || exit;

use OpenReceive\Host;
use OpenReceive\Hosts\AfterPaid;
use OpenReceive\PaymentSettlement;
use OpenReceive\Server\AuthorizeContext;

/**
 * Easy Digital Downloads orders. Their references carry a prefix, edd-<order
 * id>, so they never meet a WooCommerce order id on a site that runs both.
 * Settlement follows the WooCommerce host: a completion marker commits with
 * the settled row, then EDD completes the order once that has committed.
 */
final class EddOrderHost implements Host, AfterPaid
{
    public const PREFIX = 'edd-';

    public static function reference(int $orderId): string { return self::PREFIX . $orderId; }

    public static function order(string $reference): ?\EDD\Orders\Order
    {
        if (!function_exists('edd_get_order') || !preg_match('/\Aedd-([1-9][0-9]*)\z/', $reference, $match)) { return null; }
        $order = edd_get_order((int) $match[1]);
        return $order instanceof \EDD\Orders\Order && $order->gateway === EddGateway::ID && $order->type === 'sale' ? $order : null;
    }

    public static function cookie(\EDD\Orders\Order $order, int $expires): string
    {
        return $expires . '.' . hash_hmac('sha256', 'edd:' . $order->id . ':' . $order->payment_key . ':' . $expires, wp_salt('auth'));
    }

    /** The buyer signed in as the order's customer, or the browser EDD showed the order's receipt to (a signed cookie). */
    public function authorize(AuthorizeContext $context): bool
    {
        $order = self::order((string) ($context->resource['reference'] ?? ''));
        if ($order === null) { return false; }
        if (get_current_user_id() > 0 && (int) $order->user_id === get_current_user_id()) { return true; }
        // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- The exact cookie is shape-checked and authenticated with hash_equals below.
        $cookie = wp_unslash($_COOKIE['openreceive_pay_edd_' . $order->id] ?? '');
        if (!is_string($cookie) || !preg_match('/\A([0-9]+)\.[0-9a-f]{64}\z/', $cookie, $match)) { return false; }
        $expires = (int) $match[1];
        return $expires >= time() && $expires <= time() + HOUR_IN_SECONDS && hash_equals(self::cookie($order, $expires), $cookie);
    }

    public function amountFor(string $reference): ?array
    {
        $order = self::order($reference);
        if (!$order || $order->status !== 'pending' || (float) $order->total <= 0) { return null; }
        $decimals = function_exists('edd_currency_decimal_filter') ? (int) edd_currency_decimal_filter(2, $order->currency) : 2;
        // translators: %s is the store's order number.
        $description = sprintf(__('Order #%s', 'openreceive'), $order->get_number());
        return ['currency' => strtoupper((string) $order->currency), 'value' => number_format((float) $order->total, $decimals, '.', ''), 'description' => $description];
    }

    public function onPaid(PaymentSettlement $settlement): void
    {
        $order = self::order($settlement->reference);
        if (!$order) { throw new \RuntimeException('Settlement order is missing.'); }
        $id = (int) $order->id;
        edd_update_order_meta($id, '_openreceive_payment_hash', $settlement->paymentHash);
        edd_update_order_meta($id, '_openreceive_settled_at', $settlement->paidAt);
        // This marker commits in the same wpdb transaction as the settled row.
        edd_update_order_meta($id, '_openreceive_completion_pending', 'yes');
    }

    public function afterPaid(PaymentSettlement $settlement): void
    {
        $order = self::order($settlement->reference);
        // EDD reads ids from the database as strings.
        if ($order) { self::complete((int) $order->id); }
    }

    public static function complete(int $id): void
    {
        global $wpdb;
        $db = new WpdbConnection($wpdb);
        $lock = substr('or-edd-' . hash('sha256', $wpdb->prefix . ':' . $id), 0, 64);
        if ((int) ($db->query('SELECT GET_LOCK(?, 0) AS acquired', [$lock])[0]['acquired'] ?? 0) !== 1) { return; }
        try {
            $order = self::order(self::reference($id));
            if (!$order || edd_get_order_meta($id, '_openreceive_completion_pending', true) !== 'yes') { return; }
            $hash = (string) edd_get_order_meta($id, '_openreceive_payment_hash', true);
            if ($order->status === 'pending') {
                // Completing the order sends EDD's receipt and opens the downloads.
                edd_update_order_status($id, 'complete');
                edd_set_payment_transaction_id($id, $hash);
                edd_insert_payment_note($id, sprintf('OpenReceive Lightning payment %s', $hash));
            }
            // A refunded or revoked order is an operator decision: never reopen it.
            if (edd_get_order($id)?->status !== 'complete') { return; }
            edd_delete_order_meta($id, '_openreceive_completion_pending');
        } finally { $db->query('SELECT RELEASE_LOCK(?)', [$lock]); }
    }

    public static function repair(): void
    {
        global $wpdb;
        if (!function_exists('edd_get_order')) { return; }
        // Read the markers from the table itself: EDD caches order queries for
        // the request, which would miss a marker this request just committed.
        $db = new WpdbConnection($wpdb);
        $rows = $db->query("SELECT edd_order_id FROM {$wpdb->prefix}edd_ordermeta WHERE meta_key = ? AND meta_value = ? ORDER BY edd_order_id LIMIT 50", ['_openreceive_completion_pending', 'yes']);
        foreach ($rows as $row) {
            try { self::complete((int) $row['edd_order_id']); } catch (\Throwable) { /* Retain the durable marker for the next pass. */ }
        }
    }
}
