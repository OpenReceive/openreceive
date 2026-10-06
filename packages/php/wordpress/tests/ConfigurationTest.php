<?php
declare(strict_types=1);
namespace OpenReceive\WP;

use OpenReceive\ConfigurationError;
use PHPUnit\Framework\TestCase;

// These tests load source classes without WordPress; capture writes so a
// failed preflight cannot accidentally persist even encrypted bad settings.
function get_woocommerce_currency(): string { return 'USD'; }
function update_option(string $name, mixed $value, mixed $autoload = null): bool
{
    ConfigurationTest::$writes[] = [$name, $value];
    return true;
}

final class ConfigurationTest extends TestCase
{
    public static array $writes = [];

    protected function setUp(): void
    {
        self::$writes = [];
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
}
