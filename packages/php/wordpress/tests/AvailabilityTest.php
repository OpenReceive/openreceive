<?php
declare(strict_types=1);

namespace {
    // A stand-in for WordPress's database class: it answers the schema marker
    // query, or fails the way a missing table does.
    final class wpdb
    {
        public string $prefix = 'wp_';
        public string $last_error = '';
        public int $insert_id = 0;
        public ?string $schemaVersion = '1';
        public function suppress_errors(bool $suppress = true): bool { return false; }
        public function prepare(string $format, mixed $value): string { return "'" . addslashes((string) $value) . "'"; }
        public function get_results(string $sql, string $output): ?array
        {
            if ($this->schemaVersion === null) { $this->last_error = "Table 'wp_openreceive_meta' doesn't exist"; return null; }
            $this->last_error = '';
            return [['value' => $this->schemaVersion]];
        }
    }
    const ARRAY_A = 'ARRAY_A';
}

namespace OpenReceive\WP {

use PHPUnit\Framework\TestCase;

function get_option(string $name, mixed $default = false): mixed { return $name === 'woocommerce_openreceive_settings' ? AvailabilityTest::$settings : $default; }
function is_admin(): bool { return false; }
function edd_get_currency(): string { return AvailabilityTest::$eddCurrency; }

/**
 * Checkout asks for availability on every page that lists payment methods.
 * The wallet code here names a relay that does not resolve and nothing is
 * cached, and these tests have no HTTP transport: any wallet preflight or
 * price lookup would fail, so a gateway offered here was decided locally.
 */
final class AvailabilityTest extends TestCase
{
    public static array $settings = [];
    public static string $eddCurrency = 'USD';
    private const HEX = 'b889ff5b1513b641e2a139f661a661364979c5beee91842f8f0ef42ab558e9d4';

    protected function setUp(): void
    {
        if (!defined('AUTH_KEY')) { define('AUTH_KEY', 'unit-test-auth-key'); }
        if (!defined('SECURE_AUTH_KEY')) { define('SECURE_AUTH_KEY', 'unit-test-secure-auth-key'); }
        $GLOBALS['wpdb'] = new \wpdb();
        self::$settings = ['nwc_uri' => Secrets::encrypt('nostr+walletconnect://' . self::HEX . '?relay=wss%3A%2F%2Frelay.example.invalid&secret=' . self::HEX)];
        self::$eddCurrency = 'USD';
        Plugin::resetEngine();
    }

    public function testAnUnreachableWalletAndPriceFeedLeaveCheckoutAvailable(): void
    {
        $started = microtime(true);
        self::assertTrue(Plugin::checkoutAvailable('USD'));
        self::assertTrue(Plugin::checkoutAvailable('eur'));
        self::assertLessThan(0.5, microtime(true) - $started, 'no relay handshake or price request was attempted');
        self::assertNull((new \ReflectionProperty(Plugin::class, 'engine'))->getValue(), 'no engine, so no wallet preflight');
    }

    public function testEasyDigitalDownloadsKeepsTheGatewayWhenTheWalletIsUnreachable(): void
    {
        $gateways = ['manual' => ['admin_label' => 'Store Gateway'], EddGateway::ID => ['admin_label' => 'OpenReceive (Bitcoin Lightning)']];
        self::assertSame($gateways, EddGateway::available($gateways));
        self::$eddCurrency = 'KES';
        self::assertSame(['manual' => $gateways['manual']], EddGateway::available($gateways), 'a currency the price feeds never quote');
    }

    public function testLocalChecksStillHideTheGateway(): void
    {
        self::assertFalse(Plugin::checkoutAvailable('KES'), 'the price feeds are never asked for KES');
        $GLOBALS['wpdb']->schemaVersion = null;
        self::assertFalse(Plugin::checkoutAvailable('USD'), 'missing tables');
        $GLOBALS['wpdb']->schemaVersion = '1';
        self::$settings = ['nwc_uri' => Secrets::encrypt('not-a-wallet-code')];
        self::assertFalse(Plugin::checkoutAvailable('USD'), 'a code that does not parse');
        self::$settings = [];
        self::assertFalse(Plugin::checkoutAvailable('USD'), 'no wallet code');
        self::$settings = ['nwc_uri' => 'not-encrypted-with-these-keys'];
        self::assertFalse(Plugin::checkoutAvailable('USD'), 'a code that cannot be decrypted');
    }
}
}
