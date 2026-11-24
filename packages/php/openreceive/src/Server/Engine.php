<?php

declare(strict_types=1);

namespace OpenReceive\Server;

use OpenReceive\ConfigurationError;
use OpenReceive\Host;
use OpenReceive\Hosts\AfterPaid;
use OpenReceive\PaymentSettlement;
use OpenReceive\Server\Errors\ConflictError;
use OpenReceive\Server\Errors\HttpError;
use OpenReceive\Server\Errors\NotFoundError;
use OpenReceive\Storage\PaymentRecord;
use OpenReceive\Storage\PaymentRepository;
use OpenReceive\Storage\SqlPaymentRepository;
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
    /**
     * How far back an earlier attempt's invoice may have expired and still be
     * checked before a new attempt is minted. A payment lands before its invoice
     * expires; this only covers the scan that has not caught up with it yet.
     */
    private const EARLIER_ATTEMPT_LOOKBACK_SECONDS = 10 * 60;

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
            fn (array $input): mixed => $this->commitAttempt(
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

    private function commitAttempt(string $reference, string $hash, array $checkout, ?array $swapData, ?string $clientIp): mixed
    {
        try {
            return $this->repository->commitAttempt($reference, $hash, $checkout, $swapData, $clientIp);
        } catch (\OpenReceive\Server\Errors\HttpError $e) {
            throw $e;
        } catch (\Throwable) {
            throw new \OpenReceive\Server\Errors\HostPersistenceError();
        }
    }

    /**
     * The PSR-15 mount: every payment route first runs the gated reconcile pass;
     * payments/check is served from it, and a create that mints first checks
     * the order's unpaid attempts.
     */
    public function psr15Handler(): Psr15Handler
    {
        return new Psr15Handler(
            $this->requestHandler(),
            $this->prefix,
            $this->responseFactory,
            fn (): array => $this->reconciler()->maybeReconcile(),
            fn (string $hash): ?array => $this->reconciler()->attemptStatus($hash),
            fn (string $reference, ?array $pass): null => $this->assertEarlierAttemptsUnpaid($reference, $pass),
        );
    }

    /**
     * Before a new attempt is minted for an order that already has unpaid ones,
     * those are checked against the wallet, and a paid one refuses the mint as
     * "already paid".
     *
     * Without it, an order paid moments ago could be handed a swap deposit
     * address: the payer pays the invoice, the page reloads before the shop's
     * next wallet scan (the gate waits 3 to 12 s between scans), the payer picks
     * a coin, and the shop opens a provider order for an order already paid. The
     * gated pass at the top of every request is skipped while the gate is
     * closed, so it cannot be relied on here.
     *
     * Only a request that mints pays for this: one bounded wallet walk over the
     * order's own pending attempts that this request's gated pass did not
     * already check. Re-serving an attempt, status polls and prepare never do. A
     * walk that cannot finish refuses the mint as retryable rather than minting
     * blind: a payer told to try again in a moment is better off than one handed
     * a second address to pay.
     *
     * @param array<string, mixed>|null $reconcilePass
     */
    private function assertEarlierAttemptsUnpaid(string $reference, ?array $reconcilePass): null
    {
        $now = $this->service->clock();
        $checked = [];
        if (($reconcilePass['reason'] ?? null) === 'ran') {
            foreach ($reconcilePass['checks'] ?? [] as $check) {
                $checked[strtolower((string) ($check['payment_hash'] ?? ''))] = true;
            }
        }
        $earlier = [];
        foreach ($this->repository->listForReference($reference) as $record) {
            if ($record->status !== 'pending' || isset($checked[strtolower($record->paymentHash)])) {
                continue;
            }
            // The invoice's own expiry, not a swap's provider deadline.
            $expiresAt = SqlPaymentRepository::settlementExpiresAt($record->checkout, $record->paymentHash);
            if ($expiresAt + self::EARLIER_ATTEMPT_LOOKBACK_SECONDS <= $now) {
                continue;
            }
            $source = $record->checkout['created_at_source'] ?? 'host';
            $earlier[] = [
                'payment_hash' => $record->paymentHash,
                'created_at' => $record->createdAt,
                'created_at_source' => is_string($source) ? $source : 'host',
                'expires_at' => $expiresAt,
            ];
        }
        if ($earlier === []) {
            return null;
        }
        // JS races the walk against a timer and lets it run on; PHP cannot, so
        // the walk carries the request-path scan deadline itself.
        $deadline = hrtime(true) / 1e9 + Reconciler::RECONCILE_SCAN_TIMEOUT_SECONDS;
        try {
            $pass = $this->reconciler()->reconcileAttempts($earlier, $deadline);
            $paid = in_array('settled', array_column($pass['checks'], 'status'), true);
            // A walk the deadline cut short that found no payment cannot rule one out.
            if (!$paid && !$pass['complete'] && !$pass['stalled'] && hrtime(true) / 1e9 >= $deadline) {
                throw new \RuntimeException('the wallet history walk did not finish within ' . Reconciler::RECONCILE_SCAN_TIMEOUT_SECONDS . ' s');
            }
        } catch (\Throwable $e) {
            $this->logger?->warning("[openreceive] payment.reconcile.before_mint.failed: could not check an order's earlier attempts before a new one (refused as retryable): " . Reconciler::sanitizeFailureMessage($e));
            throw new HttpError(503, 'INTERNAL', "Could not confirm this order's earlier payment attempt. Please try again in a moment.", retryable: true);
        }
        if ($paid) {
            throw new ConflictError('This reference is already paid.');
        }
        return null;
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
        $attempts = [];
        $paid = null;
        // Before the host is asked for a price: a host may well answer null for an
        // order it already knows is paid, and "unknown order" is the wrong thing to
        // tell the payer who paid it.
        if (in_array($action, ['checkout.prepare', 'checkout.create', 'swap.create', 'payment.check'], true)) {
            $attempts = $this->repository->listForReference($reference);
            foreach ($attempts as $record) {
                if ($record->status === 'settled') {
                    $paid = $record;
                    break;
                }
            }
            if ($paid !== null && $action === 'checkout.prepare') {
                return [...self::paidAttempt($paid), 'paid' => true];
            }
            if ($paid !== null && $action !== 'payment.check') {
                throw new ConflictError('This reference is already paid.');
            }
        }
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
        if ($action === 'checkout.prepare') {
            return Records::compact([
                'amount' => $amount,
                'description' => $description,
                'pending_payment_hash' => self::newestPending($attempts)?->paymentHash,
            ]);
        }
        if ($action === 'swap.quote') {
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
            // payments/check answers it as `paid` on EVERY attempt of a paid order.
            'paid_attempt' => $paid === null ? null : self::paidAttempt($paid),
        ]);
    }

    /** @return array<string, mixed> the attempt that paid a reference, as RequestHandler builds `paid` from it */
    private static function paidAttempt(PaymentRecord $record): array
    {
        return Records::compact([
            'payment_hash' => $record->paymentHash,
            'checkout' => $record->checkout,
            'paid_at' => $record->paidAt,
            'swap' => $record->swapData !== null,
        ]);
    }

    /**
     * The attempt a picker opened on this reference watches: the newest one
     * still pending, superseded or not, since a superseded invoice can still be
     * paid. Any pending attempt would do (`paid` answers for the whole order);
     * the newest is the one most likely still on the payer's wallet screen.
     *
     * @param list<PaymentRecord> $records
     */
    private static function newestPending(array $records): ?PaymentRecord
    {
        $newest = null;
        foreach ($records as $record) {
            if ($record->status === 'pending' && ($newest === null || $record->createdAt > $newest->createdAt)) {
                $newest = $record;
            }
        }
        return $newest;
    }
}
