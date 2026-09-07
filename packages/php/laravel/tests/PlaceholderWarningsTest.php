<?php

declare(strict_types=1);

namespace OpenReceive\Laravel\Tests;

use Illuminate\Contracts\Foundation\Application;
use Illuminate\Log\Events\MessageLogged;
use OpenReceive\Laravel\Tests\Fixtures\PlaceholderHost;

final class PlaceholderWarningsTest extends TestCase
{
    protected string $hostClass = PlaceholderHost::class;

    /** @var list<string> */
    private static array $logged = [];

    protected function defineOpenReceiveEnvironment(Application $app): void
    {
        self::$logged = [];
        $app->make('events')->listen(MessageLogged::class, static function (MessageLogged $event): void {
            self::$logged[] = "{$event->level}: {$event->message}";
        });
    }

    public function testBootWarnsOnceForEachPlaceholderStillWired(): void
    {
        $warnings = array_values(array_filter(self::$logged, static fn (string $line): bool => str_starts_with($line, 'warning: [openreceive]')));
        self::assertCount(2, $warnings);
        self::assertStringContainsString('authorize is the generated placeholder (allow-all)', $warnings[0]);
        self::assertStringContainsString('onPaid is the generated placeholder (logging-only)', $warnings[1]);
    }
}
