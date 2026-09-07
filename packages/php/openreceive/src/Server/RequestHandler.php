<?php

declare(strict_types=1);

namespace OpenReceive\Server;

use OpenReceive\Nwc\Errors;
use OpenReceive\Nwc\WalletUnavailableError;
use OpenReceive\Server\Errors\ConflictError;
use OpenReceive\Server\Errors\ForbiddenError;
use OpenReceive\Server\Errors\HostPersistenceError;
use OpenReceive\Server\Errors\HttpError;
use OpenReceive\Server\Errors\InternalHostError;
use OpenReceive\Server\Errors\NotFoundError;
use OpenReceive\Server\Errors\PayloadTooLargeError;
use OpenReceive\Server\Errors\RateLimitedError;
use OpenReceive\Server\Errors\UnsupportedMediaTypeError;
use OpenReceive\Server\Errors\ValidationError;
use OpenReceive\Support\Records;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Log\LoggerInterface;

/**
 * The framework-free route implementations (the Ruby request_handler.rb twin):
 * raw body + a request + a request id in, a [status, headers, body] triple
 * out. Psr15Handler dispatches to it; the Laravel adapter reaches it through
 * Psr15Handler too, so routing/authorize/error semantics live in one place.
 *
 * Hooks (all callables):
 *   authorize(AuthorizeContext): bool
 *   resolveCheckout(array{action, request, reference, input, pay_in_asset?}): array
 *   onCheckoutCreated(array{reference, payment_hash, checkout, swap_data, client_ip}): void
 *   onPaid(array{payment_hash, paid_at, details}): void
 *   rateLimit(AuthorizeContext): bool           (optional)
 *   clientIp(mixed $request): ?string           (optional)
 */
final class RequestHandler
{
    public const MAX_REFERENCE_LENGTH = 200;
    public const MAX_MEMO_LENGTH = 500;
    public const MAX_BODY_BYTES = 64 * 1024;
    /** Declared fields per route (additionalProperties: false, snake_case only — camelCase aliases are rejected, matching JS). */
    public const ROUTE_BODY_FIELDS = [
        'checkout.prepare' => ['reference'],
        'checkout.create' => ['reference', 'memo', 'metadata'],
        'payment.check' => ['reference', 'payment_hash'],
        'swap.quote' => ['reference', 'pay_in_asset'],
        'swap.create' => ['reference', 'pay_in_asset', 'memo', 'metadata'],
        'swap.read' => ['reference', 'payment_hash'],
        'swap.refund' => ['reference', 'payment_hash', 'refund_address'],
    ];
    /** Payer-facing subset of a settlement's wallet details; never widen to preimage or invoice. */
    public const PUBLIC_TRANSACTION_FIELDS = ['payment_hash', 'transaction_state', 'amount_msats', 'fees_paid_msats', 'created_at', 'settled_at', 'expires_at'];
    /**
     * A PSR-7 attribute a framework mount may set to its own request object
     * (Laravel's Illuminate request). The handler keeps reading the PSR-7
     * headers for its own gates; the host's `authorize`, a custom rate limit
     * and the client-IP extractor receive the framework request instead, the
     * way Rails hands them ActionDispatch::Request.
     */
    public const HOST_REQUEST_ATTRIBUTE = 'openreceive.host_request';

    /** @var callable */
    private $authorize;
    /** @var callable */
    private $resolveCheckout;
    /** @var callable */
    private $onCheckoutCreated;
    /** @var callable */
    private $onPaid;
    /** @var callable|null */
    private $rateLimit;
    /** @var callable|null */
    private $clientIp;

    public function __construct(
        private readonly Service $service,
        callable $authorize,
        callable $resolveCheckout,
        callable $onCheckoutCreated,
        callable $onPaid,
        ?callable $rateLimit = null,
        ?callable $clientIp = null,
        private readonly ?LoggerInterface $logger = null,
    ) {
        $this->authorize = $authorize;
        $this->resolveCheckout = $resolveCheckout;
        $this->onCheckoutCreated = $onCheckoutCreated;
        $this->onPaid = $onPaid;
        $this->rateLimit = $rateLimit;
        $this->clientIp = $clientIp;
    }

    public function service(): Service
    {
        return $this->service;
    }

    /** @return array{0: int, 1: array<string, string>, 2: array<string, mixed>} */
    public function prepareCheckout(string $rawBody, mixed $request, string $requestId): array
    {
        return $this->handle($requestId, function () use ($rawBody, $request, $requestId): array {
            $body = $this->parse($rawBody, 'checkout.prepare', $request);
            $reference = $this->requiredReference($body);
            $this->guard('checkout.prepare', $request, ['reference' => $reference]);
            $resolved = $this->resolveHost('checkout.prepare', $request, $reference, $body);
            $prepared = $this->service->prepareCheckout(['amount' => $this->requiredAmount($resolved)]);
            $out = [...$prepared, 'reference' => $reference];
            $description = $this->resolvedDescription($resolved);
            if ($description !== null) {
                $out['description'] = $description;
            }
            return $this->success(200, $out, $requestId);
        });
    }

    /** @return array{0: int, 1: array<string, string>, 2: array<string, mixed>} */
    public function createCheckout(string $rawBody, mixed $request, string $requestId): array
    {
        return $this->handle($requestId, function () use ($rawBody, $request, $requestId): array {
            $body = $this->parse($rawBody, 'checkout.create', $request);
            $reference = $this->requiredReference($body);
            $this->authorizeAction('checkout.create', $request, ['reference' => $reference]);
            $resolved = $this->resolveHost('checkout.create', $request, $reference, $body);
            $reused = isset($resolved['payment_hash']);
            // Rate limits meter minting only: re-serving a committed attempt costs no wallet call.
            if (!$reused) {
                $this->enforceRateLimit('checkout.create', $request, ['reference' => $reference]);
            }
            $checkout = $reused
                ? $this->committedCheckout($reference, $resolved)
                : $this->service->createCheckout([
                    'reference' => $reference, 'amount' => $this->requiredAmount($resolved),
                    'memo' => $this->validatedMemo($body), 'metadata' => $body['metadata'] ?? null,
                ]);
            if (!$reused) {
                $this->commit($checkout, null, $request);
            }
            // The catalog rides along with the mint, amount-aware against this attempt's committed invoice amount.
            $out = ['checkout' => $checkout, 'payment_methods' => $this->service->listSwapOptions((int) $checkout['amount_msats'])];
            $description = $this->resolvedDescription($resolved);
            if ($description !== null) {
                $out['description'] = $description;
            }
            return $this->success(201, $out, $requestId);
        });
    }

    /**
     * Storage-aware callers pass `$reconcilePass` — the request-level gated
     * reconcile result — plus `$attemptStatus`, a callable mapping a payment
     * hash to its persisted ['status', 'paid_at'?]. The requested hash is then
     * served from the pass (winner) or the host row (gate_busy / outside the
     * pending set / disabled) — never a second per-invoice wallet walk.
     * Storage-agnostic callers omit both and run a one-attempt walk.
     *
     * @param array<string, mixed>|null $reconcilePass
     * @return array{0: int, 1: array<string, string>, 2: array<string, mixed>}
     */
    public function checkPayment(string $rawBody, mixed $request, string $requestId, ?array $reconcilePass = null, ?callable $attemptStatus = null): array
    {
        return $this->handle($requestId, function () use ($rawBody, $request, $requestId, $reconcilePass, $attemptStatus): array {
            $body = $this->parse($rawBody, 'payment.check', $request);
            $reference = $this->requiredReference($body);
            // Payer input is shape-validated BEFORE any host hook runs.
            $requestedHash = $this->requiredPaymentHash($body['payment_hash'] ?? null);
            $this->guard('payment.check', $request, ['reference' => $reference, 'payment_hash' => $requestedHash]);
            $resolved = $this->resolveHost('payment.check', $request, $reference, $body);
            $hash = $this->selectedPaymentHash($resolved, $requestedHash);
            $checkout = $this->committedCheckout($reference, $resolved);
            $checked = $reconcilePass === null
                ? $this->checkedViaWallet($hash, $checkout)
                : $this->checkedFromPass($hash, $reconcilePass, $attemptStatus);
            $checked['payment_methods'] = $this->service->listSwapOptions((int) $checkout['amount_msats']);
            return $this->success(200, $checked, $requestId);
        });
    }

    /** @return array{0: int, 1: array<string, string>, 2: array<string, mixed>} */
    public function quoteSwap(string $rawBody, mixed $request, string $requestId): array
    {
        return $this->handle($requestId, function () use ($rawBody, $request, $requestId): array {
            $body = $this->parse($rawBody, 'swap.quote', $request);
            $reference = $this->requiredReference($body);
            $asset = $this->required($body['pay_in_asset'] ?? null, 'pay_in_asset');
            $this->guard('swap.quote', $request, ['reference' => $reference]);
            $resolved = $this->resolveHost('swap.quote', $request, $reference, $body, $asset);
            return $this->success(200, $this->service->quoteSwap(['amount' => $this->requiredAmount($resolved), 'pay_in_asset' => $asset]), $requestId);
        });
    }

    /** @return array{0: int, 1: array<string, string>, 2: array<string, mixed>} */
    public function createSwap(string $rawBody, mixed $request, string $requestId): array
    {
        return $this->handle($requestId, function () use ($rawBody, $request, $requestId): array {
            $body = $this->parse($rawBody, 'swap.create', $request);
            $reference = $this->requiredReference($body);
            $asset = $this->required($body['pay_in_asset'] ?? null, 'pay_in_asset');
            $this->authorizeAction('swap.create', $request, ['reference' => $reference]);
            $resolved = $this->resolveHost('swap.create', $request, $reference, $body, $asset);
            $reused = isset($resolved['payment_hash']);
            if (!$reused) {
                $this->enforceRateLimit('swap.create', $request, ['reference' => $reference]);
            }
            if ($reused) {
                $data = $this->requiredSwapData($resolved['swap_data'] ?? null);
                $swap = [
                    ...$this->service->getSwap($reference, (string) $resolved['payment_hash'], $data),
                    'checkout' => $this->committedCheckout($reference, $resolved),
                    'swap_data' => $data,
                ];
            } else {
                // Explicit, validated fields only: the raw payer body never reaches the service.
                $swap = $this->service->createSwap([
                    'reference' => $reference, 'amount' => $this->requiredAmount($resolved), 'pay_in_asset' => $asset,
                    'memo' => $this->validatedMemo($body), 'metadata' => $body['metadata'] ?? null,
                ]);
                $this->commit($swap['checkout'], $swap['swap_data'] ?? null, $request);
            }
            unset($swap['swap_data']);
            return $this->success(201, ['swap' => $swap], $requestId);
        });
    }

    /** @return array{0: int, 1: array<string, string>, 2: array<string, mixed>} */
    public function getSwap(string $rawBody, mixed $request, string $requestId): array
    {
        return $this->swapAction('swap.read', $rawBody, $request, $requestId, fn (string $reference, string $hash, array $data, array $body): array => $this->service->getSwap($reference, $hash, $data));
    }

    /** @return array{0: int, 1: array<string, string>, 2: array<string, mixed>} */
    public function refundSwap(string $rawBody, mixed $request, string $requestId): array
    {
        return $this->swapAction('swap.refund', $rawBody, $request, $requestId, fn (string $reference, string $hash, array $data, array $body): array => $this->service->refundSwap(
            $reference,
            $hash,
            $data,
            $this->required($body['refund_address'] ?? null, 'refund_address')
        ));
    }

    /** @return array{0: int, 1: array<string, string>, 2: array<string, mixed>} */
    public function readRates(string $queryString, mixed $request, string $requestId): array
    {
        return $this->handle($requestId, function () use ($queryString, $requestId): array {
            $raw = null;
            foreach (explode('&', $queryString) as $pair) {
                if ($pair === '') {
                    continue;
                }
                [$key, $value] = array_pad(explode('=', $pair, 2), 2, '');
                if (urldecode($key) === 'currencies' && $raw === null) {
                    $raw = urldecode($value);
                }
            }
            $currencies = self::parseRatesCurrencies($raw);
            return $this->success(200, $this->service->listRates($currencies === null ? [] : ['currencies' => $currencies]), $requestId);
        });
    }

    /**
     * The payer's ?currencies filter, shape-checked at the wire boundary with the same message as the JS handler.
     *
     * @return list<string>|null
     */
    public static function parseRatesCurrencies(?string $raw): ?array
    {
        if ($raw === null) {
            return null;
        }
        $currencies = array_values(array_filter(array_map('trim', explode(',', $raw)), static fn (string $value): bool => $value !== ''));
        foreach ($currencies as $value) {
            if (preg_match('/\A[A-Za-z]{3}\z/', $value) !== 1) {
                throw new ValidationError('currencies must be a comma-separated list of three-letter currency codes.');
            }
        }
        if ($currencies === []) {
            throw new ValidationError('currencies must be a comma-separated list of three-letter currency codes.');
        }
        return $currencies;
    }

    /**
     * Only an error carrying a code from the canonical contract enum keeps its
     * status/code/message on the wire; anything else — a leaked library
     * exception included — is redacted to an opaque 500 (and reported).
     *
     * @return array{0: int, 1: array<string, string>, 2: array<string, mixed>}
     */
    public function errorResponse(\Throwable $error, string $requestId): array
    {
        if (!($error instanceof HttpError) || !in_array($error->errorCode, Errors::ERROR_CODES, true)) {
            $this->reportUnexpectedError($error, $requestId);
            return [500, $this->headers($requestId), ['code' => 'INTERNAL', 'message' => 'Internal server error.', 'request_id' => $requestId]];
        }
        $body = ['code' => $error->errorCode, 'message' => $error->getMessage(), 'request_id' => $requestId];
        if ($error->retryable !== null) {
            $body['retryable'] = $error->retryable;
        }
        if ($error->details !== null) {
            $body['details'] = $error->details;
        }
        $headers = $this->headers($requestId);
        if ($error->retryAfterSeconds !== null) {
            $headers['retry-after'] = (string) max(1, $error->retryAfterSeconds);
        }
        return [$error->status, $headers, $body];
    }

    /** @param array<string, mixed> $checkout @return array<string, mixed> */
    private function checkedViaWallet(string $hash, array $checkout): array
    {
        $checked = $this->service->reconcilePayments(['attempts' => [['payment_hash' => $hash, 'created_at' => $checkout['created_at']]]])[0] ?? null;
        if ($checked === null) {
            throw new WalletUnavailableError('payment reconciliation did not complete: the wallet history walk ended before this invoice could be confirmed');
        }
        if (($checked['status'] ?? null) === 'settled' && isset($checked['paid_at'])) {
            ($this->onPaid)(['payment_hash' => $checked['payment_hash'], 'paid_at' => $checked['paid_at'], 'details' => $checked['details'] ?? null]);
        }
        return $this->publicChecked($checked);
    }

    /** @param array<string, mixed> $reconcilePass @return array<string, mixed> */
    private function checkedFromPass(string $hash, array $reconcilePass, ?callable $attemptStatus): array
    {
        if (($reconcilePass['reason'] ?? null) === 'ran') {
            foreach ($reconcilePass['checks'] ?? [] as $check) {
                // A `not_found` pass result falls through to the row: a wallet that
                // ignores `unpaid: true` must not flap a pending attempt.
                if (strtolower((string) ($check['payment_hash'] ?? '')) === $hash && ($check['status'] ?? null) !== 'not_found') {
                    return $this->publicChecked($check);
                }
            }
        }
        $row = $attemptStatus === null ? null : $attemptStatus($hash);
        if ($row === null) {
            throw new NotFoundError('Payment attempt not found for this reference.');
        }
        // Row `attention` serves as `pending` on the wire (operator state, not payer information).
        $status = ($row['status'] ?? '') === 'attention' ? 'pending' : (string) ($row['status'] ?? '');
        $public = ['payment_hash' => $hash, 'status' => $status];
        if (isset($row['paid_at'])) {
            $public['paid_at'] = (int) $row['paid_at'];
        }
        return $public;
    }

    /** @param array<string, mixed> $checked @return array<string, mixed> */
    private function publicChecked(array $checked): array
    {
        $details = $checked['details'] ?? null;
        unset($checked['details']);
        if ($details !== null) {
            $checked['details'] = $this->publicPaymentDetails($details);
        }
        return $checked;
    }

    /** @return array{0: int, 1: array<string, string>, 2: array<string, mixed>} */
    private function swapAction(string $action, string $rawBody, mixed $request, string $requestId, callable $work): array
    {
        return $this->handle($requestId, function () use ($action, $rawBody, $request, $requestId, $work): array {
            $body = $this->parse($rawBody, $action, $request);
            $reference = $this->requiredReference($body);
            $requestedHash = $this->requiredPaymentHash($body['payment_hash'] ?? null);
            $this->guard($action, $request, ['reference' => $reference, 'payment_hash' => $requestedHash]);
            $resolved = $this->resolveHost($action, $request, $reference, $body);
            $hash = $this->selectedPaymentHash($resolved, $requestedHash);
            return $this->success(200, $work($reference, $hash, $this->requiredSwapData($resolved['swap_data'] ?? null), $body), $requestId);
        });
    }

    /** @param array<string, mixed> $body @return array<string, mixed> */
    private function resolveHost(string $action, mixed $request, string $reference, array $body, ?string $payInAsset = null): array
    {
        $args = ['action' => $action, 'request' => $request, 'reference' => $reference, 'input' => $body];
        if ($payInAsset !== null) {
            $args['pay_in_asset'] = $payInAsset;
        }
        return Records::asArray(($this->resolveCheckout)($args));
    }

    /** @param array{reference: string, payment_hash?: string} $resource */
    private function guard(string $action, mixed $request, array $resource): void
    {
        $this->enforceRateLimit($action, $request, $resource);
        $this->authorizeAction($action, $request, $resource);
    }

    /** The framework's request when the mount attached one (HOST_REQUEST_ATTRIBUTE), else the request as passed. */
    public static function hostRequest(mixed $request): mixed
    {
        if ($request instanceof ServerRequestInterface) {
            return $request->getAttribute(self::HOST_REQUEST_ATTRIBUTE) ?? $request;
        }
        return $request;
    }

    /** @param array{reference: string, payment_hash?: string} $resource */
    private function enforceRateLimit(string $action, mixed $request, array $resource): void
    {
        if ($this->rateLimit === null) {
            return;
        }
        if (($this->rateLimit)(new AuthorizeContext($action, self::hostRequest($request), $resource)) !== true) {
            throw new RateLimitedError();
        }
    }

    /** @param array{reference: string, payment_hash?: string} $resource */
    private function authorizeAction(string $action, mixed $request, array $resource): void
    {
        if (($this->authorize)(new AuthorizeContext($action, self::hostRequest($request), $resource)) === true) {
            return;
        }
        throw new ForbiddenError(
            "Not authorized for this action. The application's authorize hook denied it; if this is unexpected, "
            . "check that the payer's session reaches the checkout routes. https://openreceive.org/guides/authorization.md"
        );
    }

    /** @param array<string, mixed> $checkout @param array<string, mixed>|null $swapData */
    private function commit(array $checkout, ?array $swapData, mixed $request): void
    {
        try {
            $clientIp = $this->clientIp === null ? null : ($this->clientIp)(self::hostRequest($request));
            ($this->onCheckoutCreated)([
                'reference' => $checkout['reference'],
                'payment_hash' => $checkout['payment_hash'],
                'checkout' => $checkout,
                'swap_data' => $swapData,
                'client_ip' => $clientIp,
            ]);
        } catch (HttpError $e) {
            // Meaningful repository refusals ("already paid", live attempt) pass through untouched.
            throw $e;
        } catch (\Throwable $e) {
            // Anything else is infrastructure failing to persist: retryable 503, never a payer-blaming conflict.
            $this->reportUnexpectedError($e, 'commit');
            throw new HostPersistenceError();
        }
    }

    /** @return array<string, mixed> */
    private function publicPaymentDetails(mixed $details): array
    {
        $data = Records::asArray($details);
        $result = [];
        if (Records::isRecord($data['transaction'] ?? null)) {
            $rows = Records::asArray($data['transaction']);
            $picked = [];
            foreach (self::PUBLIC_TRANSACTION_FIELDS as $field) {
                if (isset($rows[$field])) {
                    $picked[$field] = $rows[$field];
                }
            }
            $result['transaction'] = $picked;
        }
        $result['observed_at'] = $data['observed_at'] ?? null;
        if (isset($data['paid_at_source'])) {
            $result['paid_at_source'] = $data['paid_at_source'];
        }
        return $result;
    }

    /** @return array{0: int, 1: array<string, string>, 2: array<string, mixed>} */
    private function handle(string $requestId, callable $work): array
    {
        try {
            return $work();
        } catch (\Throwable $e) {
            return $this->errorResponse($e, $requestId);
        }
    }

    /** Class and request id only — never the message, which could quote bodies, NWC URIs, invoices or preimages. */
    private function reportUnexpectedError(\Throwable $error, string $requestId): void
    {
        try {
            $line = "[openreceive] unexpected " . $error::class . " (request_id={$requestId}) at {$error->getFile()}:{$error->getLine()}";
            if ($this->logger !== null) {
                $this->logger->error($line, ['exception' => $error]);
            } else {
                error_log($line);
            }
        } catch (\Throwable) {
            // Diagnostics never affect the response.
        }
    }

    /** @return array<string, mixed> */
    private function parse(string $raw, string $route, mixed $request): array
    {
        $this->assertNotCrossSite($request);
        $this->assertJsonContentType($request);
        if (strlen($raw) > self::MAX_BODY_BYTES) {
            throw new PayloadTooLargeError();
        }
        if (trim($raw) === '') {
            $value = [];
        } else {
            try {
                $value = json_decode($raw, true, 512, JSON_THROW_ON_ERROR | JSON_BIGINT_AS_STRING);
            } catch (\JsonException) {
                throw new ValidationError('Request body must be a JSON object.');
            }
        }
        if (!is_array($value) || ($value !== [] && array_is_list($value))) {
            throw new ValidationError('Request body must be a JSON object.');
        }
        $this->assertDeclaredFields($value, $route);
        return $value;
    }

    /**
     * Body-bearing routes accept `application/json` only, checked before
     * authorize or any host hook: the CSRF-equivalent on cookie-authenticated
     * mounts. Parameters and charset are ignored; the media type is case-folded.
     */
    private function assertJsonContentType(mixed $request): void
    {
        $contentType = $request instanceof ServerRequestInterface ? $request->getHeaderLine('content-type') : (string) (Records::asArray($request)['CONTENT_TYPE'] ?? '');
        if (strtolower(trim(explode(';', $contentType)[0])) === 'application/json') {
            return;
        }
        throw new UnsupportedMediaTypeError();
    }

    /** A forged request from another site is always `Sec-Fetch-Site: cross-site`; `same-site` and an absent header pass. */
    private function assertNotCrossSite(mixed $request): void
    {
        $site = $request instanceof ServerRequestInterface ? $request->getHeaderLine('sec-fetch-site') : (string) (Records::asArray($request)['HTTP_SEC_FETCH_SITE'] ?? '');
        if (strtolower(trim($site)) === 'cross-site') {
            throw new ForbiddenError('Cross-site requests are not accepted.');
        }
    }

    /** @param array<string, mixed> $body */
    private function assertDeclaredFields(array $body, string $route): void
    {
        $allowed = self::ROUTE_BODY_FIELDS[$route] ?? null;
        if ($allowed === null) {
            return;
        }
        // A payer-supplied amount is the one undeclared field worth naming.
        if (array_key_exists('amount', $body) || array_key_exists('amount_msats', $body)) {
            throw new ValidationError('This route does not accept a payer-supplied amount; the host resolves its order price.');
        }
        foreach (array_keys($body) as $key) {
            if (!in_array((string) $key, $allowed, true)) {
                throw new ValidationError("Unexpected request field for this route: {$key}.");
            }
        }
    }

    private function required(mixed $value, string $field): string
    {
        $text = trim(is_scalar($value) ? (string) $value : '');
        if ($text === '') {
            throw new ValidationError("{$field} is required.");
        }
        return $text;
    }

    /** @param array<string, mixed> $body */
    private function requiredReference(array $body): string
    {
        $reference = $this->required($body['reference'] ?? null, 'reference');
        if (mb_strlen($reference) > self::MAX_REFERENCE_LENGTH) {
            throw new ValidationError('reference must be ' . self::MAX_REFERENCE_LENGTH . ' characters or fewer.');
        }
        return $reference;
    }

    /** @param array<string, mixed> $body */
    private function validatedMemo(array $body): mixed
    {
        $memo = $body['memo'] ?? null;
        if (is_string($memo) && mb_strlen($memo) > self::MAX_MEMO_LENGTH) {
            throw new ValidationError('memo must be ' . self::MAX_MEMO_LENGTH . ' characters or fewer.');
        }
        return $memo;
    }

    /**
     * What the payer is buying, in the host's own words — response only, blank is absent.
     *
     * @param array<string, mixed> $resolved
     */
    private function resolvedDescription(array $resolved): ?string
    {
        $value = $resolved['description'] ?? null;
        if (!is_string($value)) {
            return null;
        }
        $trimmed = trim($value);
        return $trimmed === '' ? null : $trimmed;
    }

    /** @param array<string, mixed> $resolved */
    private function requiredAmount(array $resolved): mixed
    {
        if (!isset($resolved['amount'])) {
            // A host order without an amount is a host-integration bug, not a payer mistake.
            throw new InternalHostError('The host resolved this order without an amount.');
        }
        return $resolved['amount'];
    }

    private function requiredPaymentHash(mixed $value): string
    {
        $hash = strtolower($this->required($value, 'payment_hash'));
        if (preg_match('/\A[0-9a-f]{64}\z/', $hash) !== 1) {
            throw new ValidationError('payment_hash must be 64 hexadecimal characters.');
        }
        return $hash;
    }

    /** @return array<string, mixed> */
    private function requiredSwapData(mixed $value): array
    {
        if ($value === null) {
            throw new NotFoundError('The host order has no swap data.');
        }
        if (!Records::isRecord($value)) {
            throw new ValidationError("The host order's swap data is not a valid swap_data object.");
        }
        return Records::asArray($value);
    }

    /** @param array<string, mixed> $resolved */
    private function selectedPaymentHash(array $resolved, string $requestedHash): string
    {
        $selected = $this->hostPaymentHash($resolved['payment_hash'] ?? null);
        if ($selected === $requestedHash) {
            return $selected;
        }
        throw new NotFoundError('The selected payment attempt does not belong to this order.');
    }

    /** A hash the HOST resolver returned: missing or malformed is a host bug (500), never payer input. */
    private function hostPaymentHash(mixed $value): string
    {
        $hash = is_string($value) ? strtolower(trim($value)) : null;
        if ($hash !== null && preg_match('/\A[0-9a-f]{64}\z/', $hash) === 1) {
            return $hash;
        }
        throw new InternalHostError('The host resolver returned a missing or malformed payment hash for this reference.');
    }

    /** @param array<string, mixed> $resolved @return array<string, mixed> */
    private function committedCheckout(string $reference, array $resolved): array
    {
        $checkout = $resolved['checkout'] ?? null;
        if (!Records::isRecord($checkout)) {
            throw new ConflictError('The host payment attempt has no checkout snapshot.');
        }
        $data = Records::asArray($checkout);
        try {
            $hash = $this->hostPaymentHash($data['payment_hash'] ?? null);
            $selected = $this->hostPaymentHash($resolved['payment_hash'] ?? null);
            $checkoutReference = $this->required($data['reference'] ?? null, 'reference');
        } catch (ValidationError) {
            throw new ConflictError('The selected payment attempt is not a reusable pending checkout.');
        }
        if ($hash !== $selected || $checkoutReference !== $reference) {
            throw new ConflictError('The selected payment attempt is not a reusable pending checkout.');
        }
        return $data;
    }

    /** @param array<string, mixed> $body @return array{0: int, 1: array<string, string>, 2: array<string, mixed>} */
    private function success(int $status, array $body, string $requestId): array
    {
        return [$status, $this->headers($requestId), $body];
    }

    /** @return array<string, string> */
    private function headers(string $requestId): array
    {
        return ['content-type' => 'application/json; charset=utf-8', 'x-request-id' => $requestId];
    }
}
