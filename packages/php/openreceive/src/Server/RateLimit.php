<?php

declare(strict_types=1);

namespace OpenReceive\Server;

use OpenReceive\ConfigurationError;
use OpenReceive\Server\Errors\RateLimitedError;
use OpenReceive\Storage\PaymentRepository;
use Psr\Log\LoggerInterface;

/**
 * The built-in per-IP invoice rate limiter: a COUNT over the engine-owned
 * rows' client_ip within the rolling window (`inserted_at`, per the
 * rate-limit-window vector), throttling only the minting actions. OFF by
 * default — shared-IP deployments (POS terminals, kiosks) must never be
 * throttled by accident. Identical semantics and message to JS and Ruby.
 *
 * An address that cannot be a payer (loopback, private, link-local: the
 * host's own proxy or network, see ClientIp::isPayer) is never counted, and a
 * refusal names the address it refused in the log. The warnings go to the
 * PSR-3 logger the engine was given; "once" is once per limiter, which a PHP
 * process that serves one request builds anew for each request.
 */
final class RateLimit
{
    public const DEFAULT_LIMIT_PER_HOUR = 60;
    public const HOUR_SECONDS = 3_600;
    public const DAY_SECONDS = 86_400;
    public const BUILT_IN_MESSAGE = 'Too many payment attempts. Please try again later.';
    /** A refusal is logged at most this often per limiter. */
    public const REFUSAL_WARNING_SECONDS = 60;

    /**
     * @param bool|array{limit_per_hour?: int, limit_per_day?: int} $settings
     * @param callable(mixed): ?string $clientIp
     * @param (callable(): int)|null $clock
     * @return callable(AuthorizeContext): bool
     */
    public static function builtIn(PaymentRepository $repository, callable $clientIp, bool|array $settings = true, ?LoggerInterface $logger = null, ?callable $clock = null): callable
    {
        $config = is_array($settings) ? $settings : [];
        $perHour = self::positive($config['limit_per_hour'] ?? self::DEFAULT_LIMIT_PER_HOUR, 'limit_per_hour');
        $perDay = isset($config['limit_per_day']) ? self::positive($config['limit_per_day'], 'limit_per_day') : null;
        $clock ??= static fn (): int => time();
        $warned = false;
        $warnedNotAPayer = false;
        $lastRefusalWarning = null;
        // Say which address was refused, at most once a minute. When that
        // address is the host's own proxy, every payer shares its budget and
        // this line is the only place the operator can see why checkouts stopped.
        $refuse = static function (string $ip, int $counted, int $limit, string $window, int $at) use ($logger, &$lastRefusalWarning): RateLimitedError {
            if ($lastRefusalWarning === null || $at - $lastRefusalWarning >= self::REFUSAL_WARNING_SECONDS) {
                $lastRefusalWarning = $at;
                $logger?->warning(
                    "[openreceive] rateLimiting refused a new payment from {$ip}: {$counted} made in the last {$window}, limit {$limit}. "
                    . "If {$ip} is your proxy, load balancer or CDN rather than one payer, every payer is sharing this limit: "
                    . "pass the payer's own address — see https://openreceive.org/guides/rate-limiting.md"
                );
            }
            return new RateLimitedError(self::BUILT_IN_MESSAGE);
        };
        return static function (AuthorizeContext $context) use ($repository, $clientIp, $perHour, $perDay, $clock, $logger, $refuse, &$warned, &$warnedNotAPayer): bool {
            if (!in_array($context->action, ['checkout.create', 'swap.create'], true)) {
                return true;
            }
            $ip = (string) ($clientIp($context->request) ?? '');
            if ($ip === '') {
                // Warned once per process: a deployment where no request ever yields an IP has rate limiting silently off.
                if (!$warned) {
                    $warned = true;
                    $logger?->warning('[openreceive] rate limiting is enabled but no client IP could be resolved; attempts from this request are not counted. Configure clientIp. https://openreceive.org/guides/rate-limiting.md');
                }
                return true;
            }
            if (!ClientIp::isPayer($ip)) {
                // A loopback or private address is the host's own proxy or
                // network, never a payer on the internet. Counting it would put
                // every payer in one bucket and stop the whole site at the
                // limit, so it is not counted.
                if (!$warnedNotAPayer) {
                    $warnedNotAPayer = true;
                    $logger?->warning(
                        "[openreceive] rateLimiting is on, but this request's client address is {$ip}, a private or loopback address: "
                        . 'your own proxy or network, not the payer. Limiting it would make every payer share one limit, so the request '
                        . "was allowed and such requests are not limited. Pass the payer's own address — see "
                        . 'https://openreceive.org/guides/rate-limiting.md'
                    );
                }
                return true;
            }
            $now = $clock();
            $lastHour = $repository->countAttemptsFromIp($ip, $now - self::HOUR_SECONDS);
            if ($lastHour >= $perHour) {
                throw $refuse($ip, $lastHour, $perHour, 'hour', $now);
            }
            if ($perDay !== null) {
                $lastDay = $repository->countAttemptsFromIp($ip, $now - self::DAY_SECONDS);
                if ($lastDay >= $perDay) {
                    throw $refuse($ip, $lastDay, $perDay, '24 hours', $now);
                }
            }
            return true;
        };
    }

    private static function positive(mixed $value, string $name): int
    {
        $limit = is_int($value) ? $value : (int) $value;
        if ($limit <= 0) {
            throw new ConfigurationError("OpenReceive rateLimiting {$name} must be a positive integer (got {$limit}).");
        }
        return $limit;
    }
}
