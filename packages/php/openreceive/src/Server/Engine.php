<?php

declare(strict_types=1);

namespace OpenReceive\Server;

use OpenReceive\ConfigurationError;
use OpenReceive\Host;
use OpenReceive\Hosts\AfterPaid;
use OpenReceive\PaymentSettlement;
use OpenReceive\Server\Errors\NotFoundError;
use OpenReceive\Storage\PaymentRepository;
use OpenReceive\Support\Records;
use Psr\Http\Message\ResponseFactoryInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Log\LoggerInterface;

/**
 * The quickstart composition (the Rails Configuration twin): a Host, the
 * library repository and a Service become the RequestHandler callbacks, the
 * PSR-15 mount with request-path opportunistic reconcile, the settlement hook
 * (write-once + onPaid inside the transaction, afterPaid after commit), the
 * reconciler, the notifications worker and the doctor. Laravel and the
 * plain-PHP host both build one of these; WordPress builds one over its own
 * DatabaseConnection.
 */
final class Engine
{
    private ?RequestHandler $requestHandler = null;
    private ?Reconciler $reconciler = null;
    /** @var callable(mixed): ?string */
    private $clientIp;
    /** @var callable(AuthorizeContext): bool|null */
    private $rateLimitHook;

    /**
     * @param bool|array{min_interval_seconds?: int} $opportunisticReconcile ON by default; false when a worker owns scanning
     * @param bool|array{limit_per_hour?: int, limit_per_day?: int} $rateLimiting the built-in per-IP limiter, OFF by default
     * @param (callable(AuthorizeContext): bool)|null $rateLimit a custom limiter (mutually exclusive with rateLimiting)
     * @param (callable(mixed): ?string)|null $clientIp the framework request → client IP; default reads REMOTE_ADDR from a PSR-7 request
     */
    public function __construct(
        private readonly Host $host,
        private readonly PaymentRepository $repository,
        private readonly Service $service,
        private readonly bool|array $opportunisticReconcile = true,
        bool|array $rateLimiting = false,
        ?callable $rateLimit = null,
        ?callable $clientIp = null,
        private readonly ?LoggerInterface $logger = null,
        private readonly string $prefix = '/openreceive',
        private readonly ?ResponseFactoryInterface $responseFactory = null,
    ) {
        if ($rateLimiting !== false && $rateLimit !== null) {
            throw new ConfigurationError('Set either rateLimiting or a custom rateLimit hook, not both: rateLimiting is the built-in per-IP limiter, rateLimit replaces it with your own policy. https://openreceive.org/guides/rate-limiting.md');
        }
        $extractor = $clientIp ?? [self::class, 'defaultClientIp'];
        // The extracted IP is normalized into the bucket the limiter counts with, and that same bucket is stamped on committed rows.
        $this->clientIp = static fn (mixed $request): ?string => ClientIp::attributed($extractor($request));
        $this->rateLimitHook = $rateLimiting !== false
            ? RateLimit::builtIn($repository, $this->clientIp, $rateLimiting, $logger, fn (): int => $this->service->clock())
            : $rateLimit;
        foreach (Doctor::placeholderWarnings($host) as $warning) {
            $logger?->warning($warning);
        }
    }

    public function host(): Host
    {
        return $this->host;
    }

    public function repository(): PaymentRepository
    {
        return $this->repository;
    }

    public function service(): Service
    {
        return $this->service;
    }

    public function requestHandler(): RequestHandler
    {
        return $this->requestHandler ??= new RequestHandler(
            $this->service,
            fn (AuthorizeContext $context): bool => $this->host->authorize($context),
            fn (array $args): array => $this->resolveCheckout($args),
            fn (array $input): mixed => $this->repository->commitAttempt(
                (string) $input['reference'],
                (string) $input['payment_hash'],
                Records::asArray($input['checkout']),
                $input['swap_data'] === null ? null : Records::asArray($input['swap_data']),
                $input['client_ip'] ?? null,
            ),
            fn (array $event): mixed => $this->settle($event),
            $this->rateLimitHook,
            $this->clientIp,
            $this->logger,
        );
    }

    /** The PSR-15 mount: every payment route first runs the gated reconcile pass; payments/check is served from it. */
    public function psr15Handler(): Psr15Handler
    {
        return new Psr15Handler(
            $this->requestHandler(),
            $this->prefix,
            $this->responseFactory,
            fn (): array => $this->reconciler()->maybeReconcile(),
            fn (string $hash): ?array => $this->reconciler()->attemptStatus($hash),
        );
    }

    public function reconciler(): Reconciler
    {
        return $this->reconciler ??= new Reconciler(
            $this->service,
            $this->repository,
            fn (array $event): mixed => $this->settle($event),
            $this->opportunisticReconcile,
            $this->logger,
            fn (): int => $this->service->clock(),
        );
    }

    /**
     * One reconciliation pass (the `openreceive:reconcile` one-shot).
     *
     * @return list<array<string, mixed>>
     */
    public function reconcile(): array
    {
        return $this->reconciler()->reconcile();
    }

    /**
     * The gated opportunistic pass, for host-only routes that want settlement discovery too.
     *
     * @return array{reason: string, checks?: list<array<string, mixed>>}
     */
    public function maybeReconcile(): array
    {
        return $this->reconciler()->maybeReconcile();
    }

    /**
     * The optional long-lived worker (`openreceive:notifications`).
     *
     * @param array<string, mixed>|null $env
     */
    public function notificationsWorker(?array $env = null): Notifications
    {
        return new Notifications($this->service, $this->reconciler(), Notifications::intervalFromEnvironment($env ?? Service::processEnvironment()), $this->logger);
    }

    /** @param array<string, mixed>|null $env @return list<string> */
    public function doctor(?array $env = null, ?callable $walletCheck = null, ?string $mountedAt = null): array
    {
        return Doctor::report($env ?? Service::processEnvironment(), $this->host, $walletCheck, $mountedAt ?? $this->prefix);
    }

    /**
     * The settlement hook shared by payments/check, the reconcile pass and
     * notifications: write-once through the repository, `onPaid` inside the
     * settlement transaction for the first settled attempt only, then
     * `afterPaid` (when the host implements it) after COMMIT, best-effort.
     *
     * @param array<string, mixed> $event payment_hash, paid_at, details?
     */
    public function settle(array $event): bool
    {
        $delivered = null;
        $fulfilled = $this->repository->markPaidOnce(
            (string) $event['payment_hash'],
            (int) $event['paid_at'],
            isset($event['details']) ? Records::asArray($event['details']) : null,
            function (PaymentSettlement $settlement) use (&$delivered): void {
                $this->host->onPaid($settlement);
                $delivered = $settlement;
            }
        );
        if ($fulfilled && $delivered !== null && $this->host instanceof AfterPaid) {
            try {
                $this->host->afterPaid(new PaymentSettlement($delivered->reference, $delivered->paymentHash, $delivered->paidAt, $delivered->details, null));
            } catch (\Throwable $e) {
                $this->logger?->warning("[openreceive] afterPaid for {$delivered->reference} failed (the settlement is committed; not retried): " . Reconciler::sanitizeFailureMessage($e));
            }
        }
        return $fulfilled;
    }

    /** REMOTE_ADDR from a PSR-7 server request (or a server-params array); hosts behind proxies pass their own extractor. */
    public static function defaultClientIp(mixed $request): ?string
    {
        if ($request instanceof ServerRequestInterface) {
            $address = $request->getServerParams()['REMOTE_ADDR'] ?? null;
            return is_string($address) ? $address : null;
        }
        $address = Records::asArray($request)['REMOTE_ADDR'] ?? null;
        return is_string($address) ? $address : null;
    }

    /**
     * The host is asked only where a price is minted or quoted; status polls
     * and refund recovery are answered from the engine's own rows.
     *
     * @param array<string, mixed> $args action, request, reference, input, pay_in_asset?
     * @return array<string, mixed>
     */
    private function resolveCheckout(array $args): array
    {
        $action = (string) $args['action'];
        $reference = (string) $args['reference'];
        $pricing = in_array($action, ['checkout.prepare', 'swap.quote', 'checkout.create', 'swap.create'], true);
        $price = $pricing ? $this->host->amountFor($reference) : null;
        if ($pricing && $price === null) {
            throw new NotFoundError('Unknown reference.');
        }
        $amount = $price;
        $description = null;
        if (is_array($price)) {
            $raw = $price['description'] ?? null;
            $description = is_string($raw) && trim($raw) !== '' ? trim($raw) : null;
            unset($amount['description']);
        }
        if (in_array($action, ['checkout.prepare', 'swap.quote'], true)) {
            return Records::compact(['amount' => $amount, 'description' => $description]);
        }
        $input = Records::asArray($args['input'] ?? null);
        $requestedHash = $input['payment_hash'] ?? null;
        $requestedHash = is_string($requestedHash) && trim($requestedHash) !== '' ? $requestedHash : null;
        $payInAsset = $args['pay_in_asset'] ?? null;
        $payment = $this->repository->selectedFor($reference, $action, $requestedHash, is_string($payInAsset) ? $payInAsset : null);
        if ($requestedHash !== null && $payment === null) {
            throw new NotFoundError('Payment attempt not found for this reference.');
        }
        return Records::compact([
            'amount' => $amount,
            'description' => $description,
            'payment_hash' => $payment?->paymentHash,
            'checkout' => $payment?->checkout,
            'swap_data' => $payment?->swapData,
        ]);
    }
}
