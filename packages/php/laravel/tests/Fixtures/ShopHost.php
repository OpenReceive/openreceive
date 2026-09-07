<?php

declare(strict_types=1);

namespace OpenReceive\Laravel\Tests\Fixtures;

use Illuminate\Http\Request;
use OpenReceive\Host;
use OpenReceive\Hosts\AfterPaid;
use OpenReceive\PaymentSettlement;
use OpenReceive\Server\AuthorizeContext;

/**
 * A host with a real ownership policy: `order-1` belongs to session user `u1`.
 * It records what `authorize` received so the tests can prove the Illuminate
 * request (with its session) is what reaches the hook.
 */
final class ShopHost implements Host, AfterPaid
{
    /** @var list<AuthorizeContext> */
    public static array $authorized = [];
    /** @var list<PaymentSettlement> */
    public static array $paid = [];
    /** @var list<PaymentSettlement> */
    public static array $afterPaid = [];

    public static function reset(): void
    {
        self::$authorized = [];
        self::$paid = [];
        self::$afterPaid = [];
    }

    public function authorize(AuthorizeContext $context): bool
    {
        self::$authorized[] = $context;
        if (!$context->request instanceof Request) {
            return false;
        }
        return $context->reference() === 'order-1' && $context->request->session()->get('user_id') === 'u1';
    }

    public function amountFor(string $reference): ?array
    {
        return $reference === 'order-1'
            ? ['currency' => 'USD', 'value' => '1.00', 'description' => 'One button']
            : null;
    }

    public function onPaid(PaymentSettlement $settlement): void
    {
        self::$paid[] = $settlement;
    }

    public function afterPaid(PaymentSettlement $settlement): void
    {
        self::$afterPaid[] = $settlement;
    }
}
