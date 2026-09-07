<?php
declare(strict_types=1);

use OpenReceive\WP\Secrets;
use PHPUnit\Framework\TestCase;

final class SecretsTest extends TestCase
{
    public static function setUpBeforeClass(): void
    {
        if (!defined('AUTH_KEY')) { define('AUTH_KEY', 'unit-test-auth-key'); }
        if (!defined('SECURE_AUTH_KEY')) { define('SECURE_AUTH_KEY', 'unit-test-secure-auth-key'); }
    }

    public function testEncryptionIsRandomizedAndTamperingFailsClosed(): void
    {
        $value = 'opaque-unit-test-value';
        $one = Secrets::encrypt($value);
        self::assertNotSame($one, Secrets::encrypt($value));
        self::assertStringNotContainsString($value, $one);
        self::assertSame($value, Secrets::decrypt($one));
        $bytes = base64_decode($one);
        $bytes[30] = chr(ord($bytes[30]) ^ 1);
        $this->expectException(RuntimeException::class);
        Secrets::decrypt(base64_encode($bytes));
    }

    public function testBlankAndMalformedSettings(): void
    {
        self::assertSame('', Secrets::decrypt(Secrets::encrypt('')));
        $this->expectException(RuntimeException::class);
        Secrets::decrypt('not ciphertext');
    }
}
