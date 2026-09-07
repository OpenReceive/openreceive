<?php

declare(strict_types=1);

namespace OpenReceive\Server;

use Psr\Log\LoggerInterface;

/**
 * The OPTIONAL long-lived worker: listens for NWC-02 `payment_received`
 * notifications AND runs the periodic reconcile pass in the same process —
 * the safety net for notifications missed while it was down. The web process
 * never does this; its default is request-path opportunistic reconcile. Every
 * pass claims the same durable gate, so running both never double-scans.
 * Resubscribes with the shared backoff ramp when the subscription ends.
 */
final class Notifications
{
    public const RECONCILE_INTERVAL_ENV = 'OPENRECEIVE_NOTIFICATIONS_RECONCILE_INTERVAL_SECONDS';
    public const DEFAULT_RECONCILE_INTERVAL_SECONDS = 15;

    /** @var callable(int): void */
    private $sleep;
    /** @var callable(): float */
    private $monotonic;
    private bool $stopped = false;

    /**
     * @param (callable(int): void)|null $sleep
     * @param (callable(): float)|null $monotonic
     */
    public function __construct(
        private readonly Service $service,
        private readonly Reconciler $reconciler,
        private readonly int $reconcileIntervalSeconds = self::DEFAULT_RECONCILE_INTERVAL_SECONDS,
        private readonly ?LoggerInterface $logger = null,
        ?callable $sleep = null,
        ?callable $monotonic = null,
    ) {
        $this->sleep = $sleep ?? static function (int $seconds): void {
            sleep($seconds);
        };
        $this->monotonic = $monotonic ?? static fn (): float => hrtime(true) / 1e9;
    }

    /** @param array<string, mixed> $env */
    public static function intervalFromEnvironment(array $env): int
    {
        $raw = trim((string) ($env[self::RECONCILE_INTERVAL_ENV] ?? ''));
        return $raw === '' ? self::DEFAULT_RECONCILE_INTERVAL_SECONDS : max(1, (int) $raw);
    }

    /**
     * One subscription: blocks until it ends, handling every notification
     * through the reconciler and running the periodic pass on the idle tick.
     */
    public function listen(): void
    {
        $lastPass = 0.0;
        $this->service->subscribeNotifications(
            function (array $notification): void {
                $this->reconciler->handleNotification($notification);
            },
            function () use (&$lastPass): void {
                if (($this->monotonic)() - $lastPass < $this->reconcileIntervalSeconds) {
                    return;
                }
                $lastPass = ($this->monotonic)();
                $this->periodicPass();
            }
        );
    }

    /**
     * The worker loop: subscribe, and when the subscription ends (relay drop,
     * error) resubscribe after the backoff. `$shouldContinue` lets tests (and
     * signal handlers) end the loop.
     *
     * @param (callable(): bool)|null $shouldContinue
     */
    public function run(?callable $shouldContinue = null): void
    {
        $backoff = null;
        $this->periodicPass();
        while (!$this->stopped && ($shouldContinue === null || $shouldContinue())) {
            $subscribedAt = ($this->monotonic)();
            $failure = null;
            try {
                $this->listen();
            } catch (\Throwable $e) {
                $failure = $e;
            }
            if ($this->stopped) {
                return;
            }
            $backoff = Reconciler::notificationsRetryDelay($backoff, ($this->monotonic)() - $subscribedAt);
            if ($failure === null) {
                $this->logger?->warning("openreceive notifications subscription ended; retrying in {$backoff}s");
            } else {
                $this->logger?->warning('openreceive notifications error: ' . Reconciler::sanitizeFailureMessage($failure) . "; retrying in {$backoff}s (the periodic reconcile pass still covers settlements)");
            }
            ($this->sleep)($backoff);
        }
    }

    public function stop(): void
    {
        $this->stopped = true;
    }

    private function periodicPass(): void
    {
        try {
            $this->reconciler->reconcile();
        } catch (\Throwable $e) {
            $this->logger?->warning('openreceive notifications periodic reconcile failed (will retry): ' . Reconciler::sanitizeFailureMessage($e));
        }
    }
}
