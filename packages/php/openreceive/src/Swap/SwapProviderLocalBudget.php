<?php

declare(strict_types=1);

namespace OpenReceive\Swap;

/**
 * The per-window count the request guard keeps for a provider that needs one
 * (FixedFloat). Every call adds its weight to the window; a create may bring
 * the window up to the whole soft cap, and the calls that are not creates
 * (status, refund, catalog) may use only `nonCreateCap` of it between them,
 * so open swap screens polling their status never starve new swaps.
 */
final class SwapProviderLocalBudget
{
    /**
     * @param int $softCap weight every call in one window may add up to
     * @param int $nonCreateCap weight the calls that are not creates may use between them in one window
     */
    public function __construct(
        public readonly int $softCap,
        public readonly int $nonCreateCap,
        public readonly int $createWeight,
        public readonly int $defaultWeight,
    ) {
    }
}
