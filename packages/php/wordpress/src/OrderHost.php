<?php
declare(strict_types=1);
namespace OpenReceive\WP;

use OpenReceive\Host;
use OpenReceive\Hosts\AfterPaid;
use OpenReceive\PaymentSettlement;
use OpenReceive\Server\AuthorizeContext;

final class OrderHost implements Host, AfterPaid
{
    public static function order(string $reference): ?\WC_Order
    {
        if (!preg_match('/\A[1-9][0-9]*\z/', $reference) || (string) (int) $reference !== $reference) { return null; }
        $order = wc_get_order((int) $reference);
        return $order instanceof \WC_Order && $order->get_payment_method() === 'openreceive' ? $order : null;
    }

    public static function cookie(\WC_Order $order, int $expires): string
    {
        return $expires . '.' . hash_hmac('sha256', $order->get_id() . ':' . $order->get_order_key() . ':' . $expires, wp_salt('auth'));
    }

    public function authorize(AuthorizeContext $context): bool
    {
        $order = self::order((string) ($context->resource['reference'] ?? ''));
        if ($order === null) { return false; }
        if (get_current_user_id() > 0 && $order->get_customer_id() === get_current_user_id()) { return true; }
        $session = WC()->session;
        foreach (['order_awaiting_payment', 'store_api_draft_order'] as $key) {
            if ($session && (int) $session->get($key) === $order->get_id()) { return true; }
        }
        // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- The exact cookie is shape-checked and authenticated with hash_equals below.
        $cookie = wp_unslash($_COOKIE['openreceive_pay_' . $order->get_id()] ?? '');
        if (!is_string($cookie) || !preg_match('/\A([0-9]+)\.[0-9a-f]{64}\z/', $cookie, $match)) { return false; }
        $expires = (int) $match[1];
        return $expires >= time() && $expires <= time() + HOUR_IN_SECONDS && hash_equals(self::cookie($order, $expires), $cookie);
    }

    public function amountFor(string $reference): ?array
    {
        $order = self::order($reference);
        if (!$order || !$order->needs_payment()) { return null; }
        // translators: %s is the WooCommerce order number.
        $description = sprintf(__('Order #%s', 'openreceive'), $order->get_order_number());
        return ['currency' => $order->get_currency(), 'value' => $order->get_total(), 'description' => $description];
    }

    public function onPaid(PaymentSettlement $settlement): void
    {
        $order = self::order($settlement->reference);
        if (!$order) { throw new \RuntimeException('Settlement order is missing.'); }
        $order->update_meta_data('_openreceive_payment_hash', $settlement->paymentHash);
        $order->update_meta_data('_openreceive_settled_at', $settlement->paidAt);
        // This marker commits in the same wpdb transaction as the settled row.
        $order->update_meta_data('_openreceive_completion_pending', 'yes');
        $order->save_meta_data();
    }

    public function afterPaid(PaymentSettlement $settlement): void
    {
        self::complete((int) $settlement->reference);
    }

    public static function complete(int $id): void
    {
        global $wpdb;
        $db = new WpdbConnection($wpdb);
        $lock = 'or-wc-' . hash('sha256', $wpdb->prefix . ':' . $id);
        $lock = substr($lock, 0, 64);
        if ((int) ($db->query('SELECT GET_LOCK(?, 0) AS acquired', [$lock])[0]['acquired'] ?? 0) !== 1) { return; }
        try {
            $order = self::order((string) $id);
            if (!$order || $order->get_meta('_openreceive_completion_pending') !== 'yes') { return; }
            $hash = (string) $order->get_meta('_openreceive_payment_hash');
            if ($order->needs_payment()) {
                $order->payment_complete($hash);
            }
            // A cancelled/refunded order is an operator decision: never reopen it.
            if (!$order->is_paid()) { return; }
            $order->delete_meta_data('_openreceive_completion_pending');
            $order->save_meta_data();
        } finally { $db->query('SELECT RELEASE_LOCK(?)', [$lock]); }
    }

    public static function repair(): void
    {
        // WC_Order query supports both HPOS and legacy stores. Limit each pass.
        $orders = wc_get_orders(['limit' => 50, 'payment_method' => 'openreceive',
            'status' => ['pending', 'failed', 'on-hold', 'processing', 'completed'],
            // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_key, WordPress.DB.SlowDBQuery.slow_db_query_meta_value -- Bounded recovery of the host-owned durable completion marker, through the WC API for both storage modes.
            'meta_key' => '_openreceive_completion_pending', 'meta_value' => 'yes',
            'orderby' => 'ID', 'order' => 'ASC']);
        foreach ($orders as $order) {
            try { self::complete($order->get_id()); } catch (\Throwable) { /* Retain the durable marker for the next pass. */ }
        }
    }
}
