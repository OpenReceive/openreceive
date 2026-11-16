<?php

declare(strict_types=1);

namespace OpenReceive\Tests\Server;

use OpenReceive\Server\AuthorizeContext;
use OpenReceive\Server\ClientIp;
use OpenReceive\Server\Errors\RateLimitedError;
use OpenReceive\Server\RateLimit;
use OpenReceive\Storage\PaymentRepository;
use PHPUnit\Framework\TestCase;
use Psr\Log\AbstractLogger;
use Psr\Log\LoggerInterface;

/**
 * The built-in per-IP limiter's two safeguards, like the JS tests in
 * tests/rate-limit.test.mjs: an address that cannot be a payer is never
 * counted, and a refusal names the address it refused.
 */
final class RateLimitTest extends TestCase
{
    /** @var list<string> */
    private array $warnings = [];

    private function logger(): LoggerInterface
    {
        $warnings = &$this->warnings;
        return new class ($warnings) extends AbstractLogger {
            /** @param list<string> $warnings */
            public function __construct(private array &$warnings)
            {
            }

            public function log($level, string|\Stringable $message, array $context = []): void
            {
                if ($level === 'warning') {
                    $this->warnings[] = (string) $message;
                }
            }
        };
    }

    /**
     * The limiter as the engine builds it: the client value arrives already
     * trimmed, lower-cased and bucketed (ClientIp::attributed).
     *
     * @param bool|array{limit_per_hour?: int, limit_per_day?: int} $settings
     * @return callable(AuthorizeContext): bool
     */
    private function limiter(PaymentRepository $repository, ?string $address, bool|array $settings, callable $clock): callable
    {
        return RateLimit::builtIn($repository, static fn (): ?string => ClientIp::attributed($address), $settings, $this->logger(), $clock);
    }

    private static function create(string $action = 'checkout.create'): AuthorizeContext
    {
        return new AuthorizeContext($action, null, ['reference' => 'order-1']);
    }

    private static function assertRefused(callable $limit, string $action = 'checkout.create'): void
    {
        try {
            $limit(self::create($action));
            self::fail('the limiter did not refuse');
        } catch (RateLimitedError $error) {
            // The 429 itself is unchanged.
            self::assertSame(429, $error->status);
            self::assertSame('RATE_LIMITED', $error->errorCode);
            self::assertSame('Too many payment attempts. Please try again later.', $error->getMessage());
            self::assertSame(60, $error->retryAfterSeconds);
        }
    }

    public function testAProxysOwnAddressIsNeverCountedEveryPayerWouldShareItsLimit(): void
    {
        // The rows say the limit is long gone. For a payer's address that is a
        // 429; a loopback or private address is the host's proxy, and refusing
        // it would stop every checkout on the site.
        foreach (['127.0.0.1', '::ffff:10.0.0.7', '172.18.0.3', '192.168.1.20', '100.64.0.9', '::1', 'fd12:3456::9', 'fe80::1%eth0'] as $proxy) {
            $this->warnings = [];
            $repository = $this->createMock(PaymentRepository::class);
            $repository->expects(self::never())->method('countAttemptsFromIp');
            $limit = $this->limiter($repository, $proxy, ['limit_per_hour' => 1, 'limit_per_day' => 1], static fn (): int => 10_000);
            foreach (['checkout.create', 'swap.create', 'checkout.create'] as $action) {
                self::assertTrue($limit(self::create($action)), $proxy);
            }
            // Said once, not on every request.
            self::assertCount(1, $this->warnings, $proxy);
            $address = ClientIp::bucket($proxy);
            self::assertSame(
                "[openreceive] rateLimiting is on, but this request's client address is {$address}, a private or loopback address: "
                . 'your own proxy or network, not the payer. Limiting it would make every payer share one limit, so the request was '
                . "allowed and such requests are not limited. Pass the payer's own address — see https://openreceive.org/guides/rate-limiting.md",
                $this->warnings[0],
            );
        }
    }

    public function testARefusalNamesTheAddressInTheServerLogAtMostOnceAMinute(): void
    {
        $at = 10_000;
        $repository = $this->createStub(PaymentRepository::class);
        $repository->method('countAttemptsFromIp')->willReturn(61);
        $limit = $this->limiter($repository, '203.0.113.9', true, static function () use (&$at): int {
            return $at;
        });
        for ($i = 0; $i < 3; $i++) {
            self::assertRefused($limit, 'swap.create');
        }
        $at += 59;
        self::assertRefused($limit, 'swap.create');
        self::assertCount(1, $this->warnings);
        $at += 1;
        self::assertRefused($limit, 'swap.create');
        self::assertCount(2, $this->warnings);
        // The line an operator needs when the address is their own load balancer.
        self::assertSame(
            '[openreceive] rateLimiting refused a new payment from 203.0.113.9: 61 made in the last hour, limit 60. '
            . 'If 203.0.113.9 is your proxy, load balancer or CDN rather than one payer, every payer is sharing this limit: '
            . "pass the payer's own address — see https://openreceive.org/guides/rate-limiting.md",
            $this->warnings[0],
        );
        self::assertSame($this->warnings[0], $this->warnings[1]);
    }

    public function testARefusalByTheDailyLimitNamesItsWindow(): void
    {
        $repository = $this->createStub(PaymentRepository::class);
        $repository->method('countAttemptsFromIp')->willReturnCallback(
            static fn (string $ip, int $since): int => $since === 10_000 - RateLimit::DAY_SECONDS ? 100 : 5
        );
        $limit = $this->limiter($repository, '2001:DB8:1:2::7', ['limit_per_hour' => 60, 'limit_per_day' => 100], static fn (): int => 10_000);
        self::assertRefused($limit);
        self::assertCount(1, $this->warnings);
        self::assertStringContainsString('refused a new payment from 2001:db8:1:2::/64: 100 made in the last 24 hours, limit 100.', $this->warnings[0]);
    }

    public function testAHostSuppliedIdentifierIsCountedAsGiven(): void
    {
        $repository = $this->createMock(PaymentRepository::class);
        $repository->expects(self::once())->method('countAttemptsFromIp')->with('account-42', 10_000 - RateLimit::HOUR_SECONDS)->willReturn(2);
        $limit = $this->limiter($repository, 'account-42', ['limit_per_hour' => 2], static fn (): int => 10_000);
        self::assertRefused($limit);
        self::assertStringContainsString('refused a new payment from account-42: 2 made in the last hour, limit 2.', $this->warnings[0]);
    }

    public function testAPayerUnderTheLimitAndARequestWithNoAddressAreAllowedWithoutTheNewWarnings(): void
    {
        $repository = $this->createMock(PaymentRepository::class);
        $repository->expects(self::once())->method('countAttemptsFromIp')->with('198.51.100.7', 6_400)->willReturn(59);
        $limit = $this->limiter($repository, '198.51.100.7', true, static fn (): int => 10_000);
        self::assertTrue($limit(self::create()));
        // Only the two minting actions are metered.
        self::assertTrue($limit(self::create('payment.check')));
        self::assertSame([], $this->warnings);

        // No address at all is still the first step: allowed, with its own warning.
        $uncounted = $this->createMock(PaymentRepository::class);
        $uncounted->expects(self::never())->method('countAttemptsFromIp');
        $limit = $this->limiter($uncounted, null, true, static fn (): int => 10_000);
        self::assertTrue($limit(self::create()));
        self::assertTrue($limit(self::create()));
        self::assertCount(1, $this->warnings);
        self::assertStringContainsString('no client IP could be resolved', $this->warnings[0]);
    }
}
