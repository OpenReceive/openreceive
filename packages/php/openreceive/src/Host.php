<?php

declare(strict_types=1);

namespace OpenReceive;

use OpenReceive\Server\AuthorizeContext;

/**
 * The quickstart host contract: three methods plus a database handle. The
 * engine derives checkout resolution, attempt commit and settlement
 * write-once from its own payment rows; the host keeps authentication,
 * prices and fulfillment. Implement `Hosts\AfterPaid` too for work that must
 * run after the settlement transaction commits (mail, events).
 */
interface Host
{
    /** Whether the payer behind `$context->request` may perform `$context->action` on the named reference. */
    public function authorize(AuthorizeContext $context): bool;

    /**
     * The amount to charge for a reference — `['currency' => 'USD', 'value' => '12.00']`
     * or `['sats' => 1200]`, optionally with `'description' => 'what they buy'` —
     * or null for an unknown reference. Asked only where a price is minted or quoted.
     *
     * @return array<string, mixed>|null
     */
    public function amountFor(string $reference): ?array;

    /**
     * Fulfill the order. Runs INSIDE the settlement transaction, once, for the
     * reference's first settled attempt; `$settlement->connection` is that
     * transaction. A throw rolls the settlement back for the next pass.
     */
    public function onPaid(PaymentSettlement $settlement): void;
}
