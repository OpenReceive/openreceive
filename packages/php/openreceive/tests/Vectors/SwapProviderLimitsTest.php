<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Vectors;

use OpenReceive\Swap\SwapProviderLimits;
use OpenReceive\Swap\WeightBudget;
use OpenReceive\Swap\WeightBudgetError;
use OpenReceive\Tests\VectorSupport;
use PHPUnit\Framework\TestCase;

/**
 * swap-provider-limits.json: only FixedFloat's own host is counted locally.
 * The profile numbers, every `hosts` row and every clocked scenario step run
 * against the production SwapProviderLimits and WeightBudget, like the JS test
 * of the same name in tests/crosslang.test.mjs.
 */
final class SwapProviderLimitsTest extends TestCase
{
    use VectorSupport;

    /** @return array<string, SwapProviderLimits> */
    private static function profiles(): array
    {
        return [
            'fixedfloat' => SwapProviderLimits::fixedFloat(),
            'provider-only' => SwapProviderLimits::providerOnly(),
        ];
    }

    public function testTheProfilesCarryTheSharedNumbers(): void
    {
        $family = self::vector('swap-provider-limits');
        self::assertSame($family['window_seconds'], WeightBudget::WINDOW_SECONDS);
        $profiles = self::profiles();
        $expectedNames = array_keys($family['profiles']);
        $actualNames = array_keys($profiles);
        sort($expectedNames);
        sort($actualNames);
        self::assertSame($expectedNames, $actualNames);
        foreach ($family['profiles'] as $name => $expected) {
            $limits = $profiles[$name];
            self::assertSame($name, $limits->profile);
            $budget = $limits->localBudget;
            self::assertSameRecord($expected, [
                'local_budget' => $budget === null ? null : [
                    'soft_cap' => $budget->softCap,
                    'non_create_cap' => $budget->nonCreateCap,
                    'create_weight' => $budget->createWeight,
                    'default_weight' => $budget->defaultWeight,
                ],
                'backoff_seconds' => $limits->backoffSeconds,
                'min_backoff_seconds' => $limits->minBackoffSeconds,
                'max_backoff_seconds' => $limits->maxBackoffSeconds,
                'create_backoff_only' => $limits->createBackoffOnly,
            ], $name);
        }
    }

    public function testTheProvidersHostPicksTheProfile(): void
    {
        $family = self::vector('swap-provider-limits');
        self::assertNotEmpty($family['hosts']);
        foreach ($family['hosts'] as $row) {
            self::assertSame($row['profile'], SwapProviderLimits::forBaseUrl($row['base_url'])->profile, $row['base_url']);
        }
    }

    public function testEveryScenarioStepGetsTheAnswerTheGuardMustGive(): void
    {
        $family = self::vector('swap-provider-limits');
        self::assertNotEmpty($family['scenarios']);
        $profiles = self::profiles();
        foreach ($family['scenarios'] as $scenario) {
            $now = $scenario['steps'][0]['at'];
            $budget = new WeightBudget('vector', static function () use (&$now): int {
                return $now;
            }, $profiles[$scenario['profile']]);
            foreach ($scenario['steps'] as $index => $step) {
                $now = $step['at'];
                $label = sprintf('%s: step %d (%s %s at %d)', $scenario['name'], $index + 1, $step['op'], $step['path'], $step['at']);
                for ($run = 0; $run < ($step['repeat'] ?? 1); $run++) {
                    if ($step['op'] === 'rate_limited') {
                        $budget->markRateLimited($step['path'], $step['retry_after'] ?? null);
                        continue;
                    }
                    self::assertContains($step['op'], ['reserve', 'check'], $label);
                    $result = 'ok';
                    $until = null;
                    try {
                        if ($step['op'] === 'check') {
                            $budget->assertAvailable($step['path']);
                        } else {
                            $budget->reserve($step['path']);
                        }
                    } catch (WeightBudgetError $error) {
                        $result = $error->denial['reason'];
                        $until = $error->denial['backoff_until'] ?? null;
                    }
                    self::assertSame($step['expect'], $result, $label);
                    if (isset($step['backoff_until'])) {
                        self::assertSame($step['backoff_until'], $until, $label);
                    }
                }
            }
        }
    }
}
