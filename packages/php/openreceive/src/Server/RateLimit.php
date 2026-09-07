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
 */
final class RateLimit
{
    public const DEFAULT_LIMIT_PER_HOUR = 60;
    public const HOUR_SECONDS = 3_600;
    public const DAY_SECONDS = 86_400;
    public const BUILT_IN_MESSAGE = 'Too many payment attempts. Please try again later.';

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
        return static function (AuthorizeContext $context) use ($repository, $clientIp, $perHour, $perDay, $clock, $logger, &$warned): bool {
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
            $now = $clock();
            if ($repository->countAttemptsFromIp($ip, $now - self::HOUR_SECONDS) >= $perHour) {
                throw new RateLimitedError(self::BUILT_IN_MESSAGE);
            }
            if ($perDay !== null && $repository->countAttemptsFromIp($ip, $now - self::DAY_SECONDS) >= $perDay) {
                throw new RateLimitedError(self::BUILT_IN_MESSAGE);
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
