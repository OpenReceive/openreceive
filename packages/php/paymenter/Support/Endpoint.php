<?php

declare(strict_types=1);

namespace Paymenter\Extensions\Gateways\OpenReceive\Support;

use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Nyholm\Psr7\ServerRequest;
use OpenReceive\Server\RequestHandler;
use Symfony\Component\HttpFoundation\BinaryFileResponse;

/**
 * The checkout's routes. The engine's own handler answers every path under
 * the prefix: it owns the body cap, the JSON content-type gate, the
 * cross-site refusal and the 404 or 405 for an unknown path. Laravel's web
 * middleware has already checked the CSRF token the checkout sends from the
 * page's csrf-token meta tag.
 */
final class Endpoint
{
    public function api(Request $request): Response
    {
        try {
            $query = $request->getQueryString();
            $psr = (new ServerRequest(
                $request->getMethod(),
                'http://localhost/' . ltrim($request->path(), '/') . ($query === null || $query === '' ? '' : '?' . $query),
                $request->headers->all(),
                $request->getContent(),
                '1.1',
                $request->server->all(),
            ))->withAttribute(RequestHandler::HOST_REQUEST_ATTRIBUTE, $request);
            $answer = Runtime::engine()->psr15Handler()->handle($psr);
            $response = new Response((string) $answer->getBody(), $answer->getStatusCode());
            foreach ($answer->getHeaders() as $name => $values) {
                $response->headers->set($name, $values);
            }
        } catch (\Throwable $error) {
            $requestId = 'req_' . Str::uuid()->toString();
            // The buyer sees a generic 503; the reason goes to Paymenter's log, without any code.
            Log::error("OpenReceive {$requestId} /{$request->path()} unavailable: " . (new \ReflectionClass($error))->getShortName() . ': ' . Runtime::errorMessage($error));
            $response = new Response(
                (string) json_encode(['code' => 'UNAVAILABLE', 'message' => 'Payment service is unavailable. Ask the merchant to run php artisan openreceive:doctor.', 'request_id' => $requestId]),
                503,
                ['Content-Type' => 'application/json'],
            );
        }
        $response->headers->set('Cache-Control', 'no-store');
        return $response;
    }

    /** The checkout's script and stylesheet, shipped inside the extension. */
    public function asset(string $file): BinaryFileResponse
    {
        $path = dirname(__DIR__) . '/assets/' . basename($file);
        abort_unless(is_file($path), 404);
        return response()->file($path, [
            'Content-Type' => str_ends_with($file, '.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
            'Cache-Control' => 'public, max-age=31536000, immutable',
        ]);
    }
}
