<?php

declare(strict_types=1);

namespace OpenReceive\Server;

use OpenReceive\Server\Errors\MethodNotAllowedError;
use OpenReceive\Server\Errors\NotFoundError;
use OpenReceive\Server\Errors\PayloadTooLargeError;
use Psr\Http\Message\ResponseFactoryInterface;
use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\RequestHandlerInterface;

/**
 * The PSR-15 mount over RequestHandler, with the same semantics as the Ruby
 * Rack app and the JS router: KNOWN_PATHS answer 405 on a wrong method, the
 * body is read only after a route matches (an unknown path stays a 404 no
 * matter how large the body is), request ids are always server-generated
 * (`req_<uuid>`), and every failure still answers with the shared JSON error
 * contract. Storage-aware hosts (Engine) pass `$opportunisticReconcile` and
 * `$attemptStatus` so every payment route first runs the gated reconcile pass.
 */
final class Psr15Handler implements RequestHandlerInterface
{
    public const KNOWN_PATHS = ['/checkouts/prepare', '/checkouts', '/payments/check', '/swaps/quote', '/swaps', '/swaps/status', '/swaps/refunds', '/rates'];

    private readonly string $prefix;
    private readonly ResponseFactoryInterface $responses;
    /** @var (callable(): array<string, mixed>)|null */
    private $opportunisticReconcile;
    /** @var (callable(string): (array<string, mixed>|null))|null */
    private $attemptStatus;

    /**
     * @param (callable(): array<string, mixed>)|null $opportunisticReconcile runs one gated reconcile pass; returns ['reason' => 'ran', 'checks' => …] or a skip reason
     * @param (callable(string): (array<string, mixed>|null))|null $attemptStatus a payment hash → ['status' => …, 'paid_at' => ?] from the host rows
     */
    public function __construct(
        private readonly RequestHandler $handler,
        string $prefix = '/openreceive',
        ?ResponseFactoryInterface $responseFactory = null,
        ?callable $opportunisticReconcile = null,
        ?callable $attemptStatus = null,
    ) {
        $this->prefix = rtrim($prefix, '/');
        $this->responses = $responseFactory ?? self::discoverResponseFactory();
        $this->opportunisticReconcile = $opportunisticReconcile;
        $this->attemptStatus = $attemptStatus;
    }

    public function requestHandler(): RequestHandler
    {
        return $this->handler;
    }

    public function handle(ServerRequestInterface $request): ResponseInterface
    {
        $requestId = 'req_' . self::uuid();
        try {
            $path = $request->getUri()->getPath();
            if ($this->prefix !== '' && !str_starts_with($path, $this->prefix)) {
                return $this->respond($this->handler->errorResponse(new NotFoundError('No OpenReceive route matched this method and path.'), $requestId));
            }
            $relative = rtrim(substr($path, strlen($this->prefix)), '/');
            $method = strtoupper($request->getMethod());
            $route = match ("{$method} {$relative}") {
                'POST /checkouts/prepare' => 'prepareCheckout',
                'POST /checkouts' => 'createCheckout',
                'POST /payments/check' => 'checkPayment',
                'POST /swaps/quote' => 'quoteSwap',
                'POST /swaps' => 'createSwap',
                'POST /swaps/status' => 'getSwap',
                'POST /swaps/refunds' => 'refundSwap',
                'GET /rates' => 'readRates',
                default => null,
            };
            if ($route === null) {
                $error = in_array($relative, self::KNOWN_PATHS, true)
                    ? new MethodNotAllowedError()
                    : new NotFoundError('No OpenReceive route matched this method and path.');
                return $this->respond($this->handler->errorResponse($error, $requestId));
            }
            if ($route === 'readRates') {
                // Unauthenticated GET /rates never consumes the wallet-scan budget.
                return $this->respond($this->handler->readRates($request->getUri()->getQuery(), $request, $requestId));
            }
            // The body cap runs FIRST: an anonymous oversized POST is refused without a database read or a gate claim.
            $rawBody = $this->readBody($request);
            $pass = $this->opportunisticReconcile === null ? null : ($this->opportunisticReconcile)();
            if ($route === 'checkPayment') {
                return $this->respond($this->handler->checkPayment($rawBody, $request, $requestId, $pass, $this->attemptStatus));
            }
            return $this->respond($this->handler->{$route}($rawBody, $request, $requestId));
        } catch (\Throwable $e) {
            return $this->respond($this->handler->errorResponse($e, $requestId));
        }
    }

    /**
     * Pre-auth body cap: an over-declared Content-Length is rejected before
     * any read, and the read itself stops one byte past the cap.
     */
    private function readBody(ServerRequestInterface $request): string
    {
        $declared = $request->getHeaderLine('content-length');
        if ($declared !== '' && (int) $declared > RequestHandler::MAX_BODY_BYTES) {
            throw new PayloadTooLargeError();
        }
        $stream = $request->getBody();
        if ($stream->isSeekable()) {
            $stream->rewind();
        }
        $value = $stream->read(RequestHandler::MAX_BODY_BYTES + 1);
        if ($stream->isSeekable()) {
            $stream->rewind();
        }
        if (strlen($value) > RequestHandler::MAX_BODY_BYTES) {
            throw new PayloadTooLargeError();
        }
        return $value;
    }

    /** @param array{0: int, 1: array<string, string>, 2: array<string, mixed>} $triple */
    private function respond(array $triple): ResponseInterface
    {
        [$status, $headers, $body] = $triple;
        $response = $this->responses->createResponse($status);
        foreach ($headers as $name => $value) {
            $response = $response->withHeader($name, $value);
        }
        $response->getBody()->write(json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        return $response;
    }

    private static function discoverResponseFactory(): ResponseFactoryInterface
    {
        if (class_exists(\Nyholm\Psr7\Factory\Psr17Factory::class)) {
            return new \Nyholm\Psr7\Factory\Psr17Factory();
        }
        throw new \LogicException('Psr15Handler needs a PSR-17 ResponseFactoryInterface: pass one, or install nyholm/psr7.');
    }

    private static function uuid(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }
}
