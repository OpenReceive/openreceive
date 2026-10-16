<?php

declare(strict_types=1);

namespace Box\Mod\Openreceive\Support;

use FOSSBilling\Environment;
use Nyholm\Psr7\ServerRequest;
use OpenReceive\Server\RequestHandler;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * The checkout's routes. The engine's own handler answers every path under
 * the prefix: it owns the body cap, the JSON content-type gate, the
 * cross-site refusal and the 404 or 405 for an unknown path. FOSSBilling
 * checks CSRF tokens only on its own API, so a write is refused here unless
 * it carries the session's token, which the checkout sends from the page's
 * csrf-token meta tag.
 */
final class Endpoint
{
    public static function api(Request $request, string $path): Response
    {
        $requestId = 'req_' . bin2hex(random_bytes(12));
        try {
            if (!in_array($request->getMethod(), ['GET', 'HEAD', 'OPTIONS'], true) && !self::csrfValid($request)) {
                $response = self::json(403, ['code' => 'FORBIDDEN', 'message' => 'The page\'s security token is missing or old. Reload the page and try again.', 'request_id' => $requestId]);
            } else {
                $query = $request->getQueryString();
                $psr = (new ServerRequest(
                    $request->getMethod(),
                    'http://localhost' . Runtime::PREFIX . '/' . ltrim($path, '/') . ($query === null || $query === '' ? '' : '?' . $query),
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
            }
        } catch (\Throwable $error) {
            // The buyer sees a generic 503; the reason goes to FOSSBilling's log, without any code.
            try {
                Runtime::di()['logger']->error('OpenReceive ' . $requestId . ' ' . Runtime::PREFIX . '/' . ltrim($path, '/') . ' unavailable: ' . (new \ReflectionClass($error))->getShortName() . ': ' . Runtime::errorMessage($error));
            } catch (\Throwable) {
                error_log('OpenReceive ' . $requestId . ' unavailable: ' . Runtime::errorMessage($error));
            }
            $response = self::json(503, ['code' => 'UNAVAILABLE', 'message' => 'Payment service is unavailable. Ask the merchant to run php console.php openreceive:doctor.', 'request_id' => $requestId]);
        }
        $response->headers->set('Cache-Control', 'no-store');
        return $response;
    }

    /** The checkout's script and stylesheet, shipped inside the module. */
    public static function asset(string $file): Response
    {
        $path = dirname(__DIR__) . '/assets/' . basename($file);
        if (!preg_match('/\Aopenreceive-checkout\.(?:js|css)\z/', $file) || !is_file($path)) {
            return new Response('Not found', 404, ['Content-Type' => 'text/plain; charset=utf-8']);
        }
        return new Response((string) file_get_contents($path), 200, [
            'Content-Type' => str_ends_with($file, '.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
            'Cache-Control' => 'public, max-age=31536000, immutable',
        ]);
    }

    /** The console is the shop owner; it has no session. */
    private static function csrfValid(Request $request): bool
    {
        if (Environment::isCLI()) {
            return true;
        }
        $expected = Runtime::di()['session']->get('csrf_token');
        $sent = $request->headers->get('X-CSRF-Token');
        return is_string($expected) && $expected !== '' && is_string($sent) && hash_equals($expected, $sent);
    }

    /** @param array<string, string> $body */
    private static function json(int $status, array $body): Response
    {
        return new Response((string) json_encode($body), $status, ['Content-Type' => 'application/json']);
    }
}
