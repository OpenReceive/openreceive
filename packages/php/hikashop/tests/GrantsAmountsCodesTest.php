<?php

declare(strict_types=1);

namespace OpenReceiveHikaShop\Tests;

use OpenReceiveHikaShop\Amounts;
use OpenReceiveHikaShop\Codes;
use OpenReceiveHikaShop\Grants;
use PHPUnit\Framework\TestCase;

/** The plugin's pure parts: the session's grants, order totals and the sealed codes. */
final class GrantsAmountsCodesTest extends TestCase
{
    public function testGrantsKeepTheNewestOrdersOnly(): void
    {
        $value = '';
        foreach (range(1, Grants::MAX + 5) as $id) {
            $value = Grants::add($value, $id);
        }
        $this->assertFalse(Grants::allows($value, 5));
        $this->assertTrue(Grants::allows($value, 6));
        $this->assertTrue(Grants::allows($value, Grants::MAX + 5));
        // Granting an order again moves it to the end instead of repeating it.
        $this->assertSame('3,1', Grants::add('1,3', 1));
    }

    public function testGrantsIgnoreAnythingButOrderIds(): void
    {
        $this->assertSame([7, 9], Grants::parse('7,abc,0,-3,07,9,1.5'));
        $this->assertFalse(Grants::allows('7,9', 0));
        $this->assertFalse(Grants::allows('', 7));
    }

    public function testTheCheckoutTokenMustMatchJoomlasFormToken(): void
    {
        $token = md5('session');
        $this->assertTrue(Grants::tokenMatches($token, $token));
        $this->assertFalse(Grants::tokenMatches($token, md5('other')));
        $this->assertFalse(Grants::tokenMatches($token, null));
        // No session token, no write: an empty expected value never matches.
        $this->assertFalse(Grants::tokenMatches('', ''));
    }

    public function testTotalsRoundHalfUpToTheCurrencysDecimals(): void
    {
        $this->assertSame('12.50', Amounts::total('12.50000', 2));
        $this->assertSame('12.51', Amounts::total('12.50500', 2));
        $this->assertSame('1235', Amounts::total('1234.50000', 0));
        $this->assertSame('0.000', Amounts::total('0', 3));
        $this->assertFalse(Amounts::isPositive(Amounts::total('0.00400', 2)));
        $this->assertTrue(Amounts::isPositive(Amounts::total('0.00500', 2)));
    }

    public function testTotalsRefuseWhatIsNotANonNegativeDecimal(): void
    {
        foreach (['-1.00', '1e3', '', ' 1.00', '1,00'] as $bad) {
            try {
                Amounts::total($bad, 2);
                $this->fail("accepted {$bad}");
            } catch (\InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
    }

    public function testCodesOpenOnlyUnderTheSameSiteSecret(): void
    {
        $code = 'nostr+walletconnect://' . str_repeat('ab', 32) . '?relay=wss%3A%2F%2Frelay.example&secret=' . str_repeat('cd', 32);
        $sealed = Codes::seal($code, 'site-secret-one');
        $this->assertStringStartsWith('v1:', $sealed);
        $this->assertStringNotContainsString('walletconnect', $sealed);
        $this->assertNotSame($sealed, Codes::seal($code, 'site-secret-one'), 'each seal takes a new nonce');
        $this->assertSame($code, Codes::open($sealed, 'site-secret-one'));
        $this->assertNull(Codes::open($sealed, 'site-secret-two'));
        $this->assertNull(Codes::open($code, 'site-secret-one'));
        $this->assertNull(Codes::open('v1:not-base64!', 'site-secret-one'));
        $this->assertNull(Codes::open('v1:' . base64_encode('short'), 'site-secret-one'));
    }

    public function testASiteWithoutASecretCannotSealCodes(): void
    {
        $this->expectException(\RuntimeException::class);
        Codes::seal('nostr+walletconnect://x', '');
    }
}
