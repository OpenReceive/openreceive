<?php
declare(strict_types=1);
namespace OpenReceive\WP;

use OpenReceive\ConfigurationError;
use OpenReceive\Server\Errors\SpendCapableWalletError;
use PHPUnit\Framework\TestCase;

// These tests load source classes without WordPress; capture writes so a
// failed preflight cannot accidentally persist even encrypted bad settings.
function get_woocommerce_currency(): string { return 'USD'; }
function update_option(string $name, mixed $value, mixed $autoload = null): bool
{
    ConfigurationTest::$writes[] = [$name, $value];
    return true;
}
function wp_salt(string $scheme): string { return 'unit-test-salt-' . $scheme; }
function get_transient(string $name): mixed { return ConfigurationTest::$transients[$name] ?? false; }

final class ConfigurationTest extends TestCase
{
    public static array $writes = [];
    public static array $transients = [];
    private const CODE = 'nostr+walletconnect://' . self::HEX . '?relay=wss%3A%2F%2Frelay.example.invalid&secret=' . self::HEX;
    private const HEX = 'b889ff5b1513b641e2a139f661a661364979c5beee91842f8f0ef42ab558e9d4';

    protected function setUp(): void
    {
        self::$writes = [];
        self::$transients = [];
        if (!defined('AUTH_KEY')) { define('AUTH_KEY', 'unit-test-auth-key'); }
        if (!defined('SECURE_AUTH_KEY')) { define('SECURE_AUTH_KEY', 'unit-test-secure-auth-key'); }
    }

    public function testInvalidWalletFailsBeforeAnySettingsWrite(): void
    {
        $settings = Configuration::withSecret(['enabled' => 'yes'], 'nwc_uri', 'not-a-wallet-code');
        try {
            Configuration::save($settings);
            self::fail('An invalid wallet must fail preflight.');
        } catch (ConfigurationError $error) {
            self::assertStringContainsString('nostr+walletconnect', $error->getMessage());
        }
        self::assertSame([], self::$writes);
    }

    public function testBlankInputPreservesExistingCredential(): void
    {
        $settings = ['nwc_uri' => Secrets::encrypt('opaque-unit-test-value')];
        try {
            Configuration::withSecret($settings, 'nwc_uri', " \n");
            self::fail('Empty stdin must fail.');
        } catch (\InvalidArgumentException) {
            self::assertSame('opaque-unit-test-value', Secrets::decrypt($settings['nwc_uri']));
        }
        self::assertSame([], self::$writes);
    }

    public function testRequestsReuseTheCachedWalletInfoWithoutARelayRoundTrip(): void
    {
        // The relay host does not resolve: a live preflight here would fail.
        $this->cacheWalletInfo(['make_invoice', 'list_transactions']);
        $service = Plugin::service(['nwc_uri' => Secrets::encrypt(self::CODE)], live: false);
        self::assertSame(['make_invoice', 'list_transactions'], $service->nwcClient()->preflight()['methods']);
    }

    public function testCachedWalletInfoStillRefusesASpendCapableWallet(): void
    {
        $this->cacheWalletInfo(['make_invoice', 'list_transactions', 'pay_invoice']);
        $this->expectException(SpendCapableWalletError::class);
        Plugin::service(['nwc_uri' => Secrets::encrypt(self::CODE)], live: false);
    }

    private function cacheWalletInfo(array $methods): void
    {
        self::$transients['openreceive_wallet_info'] = [
            'key' => hash_hmac('sha256', self::CODE, wp_salt('auth')),
            'info' => ['methods' => $methods, 'encryption' => ['nip44_v2']],
        ];
    }
}
