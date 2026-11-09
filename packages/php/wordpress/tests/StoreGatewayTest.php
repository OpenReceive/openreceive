<?php
declare(strict_types=1);

namespace {
    // Stand-ins from the sibling test files: the wpdb and wp_options fakes.
    require_once __DIR__ . '/AvailabilityTest.php';
    require_once __DIR__ . '/ConfigurationTest.php';

    if (!class_exists('WC_Payment_Gateway')) {
        // What Gateway reads from WooCommerce's base class. Only these tests
        // reach it: Plugin's gateway registration never runs here.
        class WC_Payment_Gateway
        {
            public array $settings = [];
            public array $form_fields = [];

            public function is_available() { return true; }
            public function get_post_data(): array { return []; }
            public function get_field_value($key, $field, $post_data = []) { return null; }
        }
    }
    if (!class_exists('WC_Admin_Settings')) {
        final class WC_Admin_Settings
        {
            public static array $errors = [];

            public static function add_error($text): void { self::$errors[] = $text; }
        }
    }
}

namespace OpenReceive\WP {

use PHPUnit\Framework\TestCase;

function esc_html(string $text): string
{
    StoreGatewayTest::$escaped[] = $text;
    return $text;
}
function add_settings_error(string $setting, string $code, string $message): void { StoreGatewayTest::$notices[] = $message; }
function wp_verify_nonce(string $nonce, string $action): int { return 1; }
function sanitize_text_field(string $value): string { return $value; }
function wp_unslash(mixed $value): mixed { return $value; }
function current_user_can(string $capability): bool { return true; }

/**
 * The two stores' gateway classes, without WordPress: each checks availability
 * and saves its settings its own way, and the helpers they call have their own
 * tests. These pin that the classes really call them.
 */
final class StoreGatewayTest extends TestCase
{
    public static array $escaped = [];
    public static array $notices = [];
    private const HEX = 'b889ff5b1513b641e2a139f661a661364979c5beee91842f8f0ef42ab558e9d4';

    protected function setUp(): void
    {
        if (!defined('AUTH_KEY')) { define('AUTH_KEY', 'unit-test-auth-key'); }
        if (!defined('SECURE_AUTH_KEY')) { define('SECURE_AUTH_KEY', 'unit-test-secure-auth-key'); }
        $GLOBALS['wpdb'] = new \wpdb();
        AvailabilityTest::$settings = [];
        ConfigurationTest::$writes = [];
        ConfigurationTest::$transients = [];
        self::$escaped = [];
        self::$notices = [];
        \WC_Admin_Settings::$errors = [];
        Plugin::resetEngine();
    }

    protected function tearDown(): void
    {
        $_POST = [];
        AvailabilityTest::$settings = [];
        Plugin::resetEngine();
    }

    private function gateway(array $settings): Gateway
    {
        $gateway = (new \ReflectionClass(Gateway::class))->newInstanceWithoutConstructor();
        $gateway->settings = $settings;
        return $gateway;
    }

    /**
     * The WooCommerce "no payment methods available" report: the availability
     * check built the engine, so a slow relay hid the gateway from an order
     * that worked minutes before. A relay that does not resolve must not.
     */
    public function testTheWooCommerceGatewayStaysAvailableWhenTheRelayIsUnreachable(): void
    {
        AvailabilityTest::$settings = ['nwc_uri' => Secrets::encrypt('nostr+walletconnect://' . self::HEX . '?relay=wss%3A%2F%2Frelay.example.invalid&secret=' . self::HEX)];
        $started = microtime(true);

        self::assertTrue($this->gateway([])->is_available());

        self::assertLessThan(0.5, microtime(true) - $started, 'no relay handshake or price request was attempted');
        self::assertNull((new \ReflectionProperty(Plugin::class, 'engine'))->getValue(), 'no engine, so no wallet preflight');
    }

    public function testAFailedWooCommerceSaveNamesTheReasonNotJustTheCodes(): void
    {
        $gateway = $this->gateway(['enabled' => 'yes', 'nwc_uri' => Secrets::encrypt('not-a-wallet-code')]);

        self::assertFalse($gateway->process_admin_options());

        self::assertCount(1, \WC_Admin_Settings::$errors);
        self::assertStringStartsWith('OpenReceive settings were not saved. Check the receive-only NWC code', \WC_Admin_Settings::$errors[0]);
        self::assertStringContainsString('nostr+walletconnect', \WC_Admin_Settings::$errors[0], 'the reason follows the lead sentence');
        self::assertSame([], ConfigurationTest::$writes, 'nothing was saved');
    }

    public function testAFailedEddSaveShowsTheEscapedReason(): void
    {
        $_POST = ['openreceive_edd_nonce' => 'nonce', 'openreceive' => ['nwc_uri' => 'not-a-wallet-code']];

        self::assertSame(['kept' => true], EddGateway::save(['kept' => true]));

        self::assertCount(1, self::$notices);
        self::assertStringStartsWith('OpenReceive settings were not saved:', self::$notices[0]);
        self::assertStringContainsString('nostr+walletconnect', self::$notices[0]);
        self::assertSame(self::$notices, self::$escaped, 'Easy Digital Downloads prints the notice as HTML, so it is escaped first');
        self::assertSame([], ConfigurationTest::$writes, 'nothing was saved');
    }
}
}
