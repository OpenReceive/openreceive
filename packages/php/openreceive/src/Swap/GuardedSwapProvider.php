<?php

declare(strict_types=1);

namespace OpenReceive\Swap;

/**
 * Optional: a provider that knows its API's limits and can say whether its
 * request guard would refuse a new swap (the real provider does; fakes and
 * custom providers need not). A provider without it gets a guard with the
 * FixedFloat limits and is not asked before a create.
 */
interface GuardedSwapProvider
{
    /** The provider's API limits, which size the request guard the service attaches. */
    public function limits(): SwapProviderLimits;

    /**
     * Throw now when the attached guard would refuse a create, so the service
     * can refuse a new swap before it does any other work for it. Uses no
     * budget; the create itself still reserves.
     *
     * @throws WeightBudgetError
     */
    public function assertCreateAvailable(): void;
}
