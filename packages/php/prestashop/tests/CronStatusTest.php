<?php

declare(strict_types=1);

namespace PrestaShop\Module\OpenReceive\Tests;

use PHPUnit\Framework\TestCase;
use PrestaShop\Module\OpenReceive\CronStatus;

/** The settings page and doctor tell the merchant when the cron line does not run. */
final class CronStatusTest extends TestCase
{
    private const NOW = 1_800_000_000;
    private const CONSOLE = '/var/www/html/bin/console';

    public function testARecentPassNeedsNoWarning(): void
    {
        $this->assertNull(CronStatus::warning(self::NOW - 60, self::NOW, self::CONSOLE));
        $this->assertNull(CronStatus::warning(self::NOW - CronStatus::STALE_SECONDS + 1, self::NOW, self::CONSOLE));
    }

    public function testNoPassYetWarnsWithTheCronLine(): void
    {
        $warning = CronStatus::warning(0, self::NOW, self::CONSOLE);
        $this->assertNotNull($warning);
        $this->assertStringContainsString('has not run yet', $warning);
        $this->assertStringContainsString('*/5 * * * * php /var/www/html/bin/console openreceive:reconcile', $warning);
    }

    public function testAStalePassWarnsWithItsTime(): void
    {
        $last = self::NOW - CronStatus::STALE_SECONDS;
        $warning = CronStatus::warning($last, self::NOW, self::CONSOLE);
        $this->assertNotNull($warning);
        $this->assertStringContainsString('last ran ' . gmdate('Y-m-d H:i', $last) . ' UTC', $warning);
    }

    public function testDoctorDescribesEachState(): void
    {
        $this->assertSame('never, so add the cron line', CronStatus::describe(0, self::NOW));
        $this->assertSame(gmdate('Y-m-d H:i', self::NOW - 60) . ' UTC', CronStatus::describe(self::NOW - 60, self::NOW));
        $this->assertStringEndsWith('so check the cron line', CronStatus::describe(self::NOW - 3600, self::NOW));
    }
}
