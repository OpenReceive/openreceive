<?php

declare(strict_types=1);

namespace OpenReceive\Laravel\Tests;

use OpenReceive\Host;
use OpenReceive\Laravel\Tests\Fixtures\ShopHost;

/**
 * THE TRAP THIS PACKAGE IS SHAPED AROUND: `php artisan config:cache` runs the
 * merged config through var_export, and a closure anywhere in it fails with
 * "Serialization of 'Closure' is not allowed". Hooks are therefore a class
 * NAME. This test does what the command does — export, write, require — and
 * proves the engine still resolves its host from the round-tripped array.
 */
final class ConfigCacheTest extends TestCase
{
    public function testTheMergedConfigSurvivesVarExportAndStillResolvesTheHost(): void
    {
        $config = $this->app->make('config')->get('openreceive');
        self::assertIsArray($config);
        array_walk_recursive($config, static function (mixed $value): void {
            self::assertFalse($value instanceof \Closure, 'config/openreceive.php must hold no closures');
        });
        self::assertSame(ShopHost::class, $config['host']);

        $file = tempnam(sys_get_temp_dir(), 'openreceive-config-cache');
        self::assertNotFalse($file);
        file_put_contents($file, '<?php return ' . var_export($config, true) . ';' . PHP_EOL);
        $cached = require $file;
        unlink($file);
        self::assertSame($config, $cached);

        $this->app->make('config')->set('openreceive', $cached);
        $this->app->forgetInstance(Host::class);
        self::assertInstanceOf(ShopHost::class, $this->app->make(Host::class));
    }

    public function testTheShippedConfigFileHoldsExactlyTheDocumentedKeys(): void
    {
        $shipped = require __DIR__ . '/../config/openreceive.php';
        self::assertSame(
            ['host', 'price_currencies', 'rate_limiting', 'opportunistic_reconcile', 'middleware', 'connection', 'route_prefix', 'nwc_uri', 'lsc_uri_primary', 'lsc_uri_backup', 'allow_spend_capable_wallet', 'wallet_info_cache_seconds', 'eager_preflight'],
            array_keys($shipped),
        );
        self::assertSame('App\\OpenReceive\\Host', $shipped['host']);
        self::assertSame(['web'], $shipped['middleware']);
        self::assertSame('openreceive', $shipped['route_prefix']);
    }
}
