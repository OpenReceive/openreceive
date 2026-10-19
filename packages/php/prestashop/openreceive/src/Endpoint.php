<?php

declare(strict_types=1);

namespace PrestaShop\Module\OpenReceive;

use Nyholm\Psr7\ServerRequest;

/**
 * The checkout's routes. The engine's own handler answers every route: it
 * owns the body cap, the JSON content-type gate, the cross-site refusal and
 * the 404 or 405 for an unknown route. PrestaShop checks no token on a module
 * front controller, so a write is refused here unless it carries the token
 * the checkout's page put in its csrf-token meta tag.
 */
final class Endpoint
{
    /**
     * @param array<string, string|list<string>> $headers
     * @param array<string, mixed> $server
     * @return array{status: int, headers: array<string, list<string>>, body: string}
     */
    public static function handle(string $method, string $path, array $headers, string $body, array $server): array
    {
        $requestId = 'req_' . bin2hex(random_bytes(12));
        try {
            if (!preg_match('#\A(/[a-z]+){1,3}\z#', $path)) {
                return self::json(404, ['code' => 'NOT_FOUND', 'message' => 'Not found.', 'request_id' => $requestId]);
            }
            if (!in_array($method, ['GET', 'HEAD', 'OPTIONS'], true) && !self::csrfValid($headers)) {
                return self::json(403, ['code' => 'FORBIDDEN', 'message' => 'The page\'s security token is missing or old. Reload the page and try again.', 'request_id' => $requestId]);
            }
            $request = new ServerRequest($method, 'http://localhost' . Runtime::ENGINE_PREFIX . $path, $headers, $body, '1.1', $server);
            // A payment that settled while its order missed the news is finished here too.
            Completion::repair();
            $answer = Runtime::engine()->psr15Handler()->handle($request);
            Completion::repair();
            return ['status' => $answer->getStatusCode(), 'headers' => $answer->getHeaders() + ['Cache-Control' => ['no-store']], 'body' => (string) $answer->getBody()];
        } catch (\Throwable $error) {
            // The buyer sees a generic 503; the reason goes to PrestaShop's log, without any code.
            (new Logger())->error($requestId . ' ' . $path . ' unavailable: ' . (new \ReflectionClass($error))->getShortName() . ': ' . Runtime::errorMessage($error));
            return self::json(503, ['code' => 'UNAVAILABLE', 'message' => 'Payment service is unavailable. Ask the merchant to run php bin/console openreceive:doctor.', 'request_id' => $requestId]);
        }
    }

    /** @param array<string, string|list<string>> $headers */
    private static function csrfValid(array $headers): bool
    {
        // The console is the shop owner; it has no cookie.
        if (PHP_SAPI === 'cli') {
            return true;
        }
        $sent = null;
        foreach ($headers as $name => $value) {
            if (strtolower((string) $name) === 'x-csrf-token') {
                $sent = is_array($value) ? (string) ($value[0] ?? '') : (string) $value;
            }
        }
        return Grants::tokenMatches((string) \Context::getContext()->cookie->{Runtime::COOKIE_CSRF}, $sent);
    }

    /**
     * @param array<string, string> $body
     * @return array{status: int, headers: array<string, list<string>>, body: string}
     */
    private static function json(int $status, array $body): array
    {
        return ['status' => $status, 'headers' => ['Content-Type' => ['application/json'], 'Cache-Control' => ['no-store']], 'body' => (string) json_encode($body)];
    }
}
