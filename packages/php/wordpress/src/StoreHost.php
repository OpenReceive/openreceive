<?php
declare(strict_types=1);
namespace OpenReceive\WP;
defined('ABSPATH') || exit;

use OpenReceive\Host;
use OpenReceive\Hosts\AfterPaid;
use OpenReceive\PaymentSettlement;
use OpenReceive\Server\AuthorizeContext;

/**
 * The engine's one host for whichever stores the site runs: an edd-<id>
 * reference is an Easy Digital Downloads order, a plain number a WooCommerce
 * order. A store that is not active has no orders.
 */
final class StoreHost implements Host, AfterPaid
{
    public static function woocommerce(): bool { return class_exists('WC_Payment_Gateway') && function_exists('wc_get_order'); }

    public static function edd(): bool { return function_exists('edd_get_order') && class_exists(\EDD\Orders\Order::class); }

    private static function host(string $reference): (Host&AfterPaid)|null
    {
        if (str_starts_with($reference, EddOrderHost::PREFIX)) { return self::edd() ? new EddOrderHost() : null; }
        return self::woocommerce() ? new OrderHost() : null;
    }

    public function authorize(AuthorizeContext $context): bool
    {
        return self::host((string) ($context->resource['reference'] ?? ''))?->authorize($context) ?? false;
    }

    public function amountFor(string $reference): ?array { return self::host($reference)?->amountFor($reference); }

    public function onPaid(PaymentSettlement $settlement): void
    {
        $host = self::host($settlement->reference);
        if ($host === null) { throw new \RuntimeException('Settlement order belongs to a store that is not active.'); }
        $host->onPaid($settlement);
    }

    public function afterPaid(PaymentSettlement $settlement): void { self::host($settlement->reference)?->afterPaid($settlement); }

    public static function repair(): void
    {
        if (self::woocommerce()) { OrderHost::repair(); }
        if (self::edd()) { EddOrderHost::repair(); }
    }

    /** @return list<string> the currencies the active stores sell in */
    public static function currencies(): array
    {
        $currencies = [];
        if (function_exists('get_woocommerce_currency')) { $currencies[] = strtoupper((string) get_woocommerce_currency()); }
        if (function_exists('edd_get_currency')) { $currencies[] = strtoupper((string) edd_get_currency()); }
        return $currencies === [] ? ['USD'] : array_values(array_unique($currencies));
    }
}
