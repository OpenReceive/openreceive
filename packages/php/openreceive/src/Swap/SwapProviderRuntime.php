<?php

declare(strict_types=1);

namespace OpenReceive\Swap;

/** Optional runtime attachments the service wires onto providers that accept them (the real provider does; fakes need not). */
interface SwapProviderRuntime
{
    public function attachSwapCache(TransientCache $cache): void;

    public function attachWeightBudget(WeightBudget $budget): void;
}
