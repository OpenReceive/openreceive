<?php

declare(strict_types=1);

namespace OpenReceive\Laravel\Http;

use Illuminate\Http\Request;
use Nyholm\Psr7\Factory\Psr17Factory;
use OpenReceive\Server\Engine;
use OpenReceive\Server\RequestHandler;
use Symfony\Bridge\PsrHttpMessage\Factory\HttpFoundationFactory;
use Symfony\Bridge\PsrHttpMessage\Factory\PsrHttpFactory;
use Symfony\Component\HttpFoundation\Response;

/**
 * The one action behind every OpenReceive route: bridge the Illuminate request
 * to PSR-7, hand it to the engine's PSR-15 handler, bridge the response back.
 *
 * It never reads the body itself — the handler owns the body cap, the JSON
 * content-type gate, the cross-site refusal and the 404/405 decision inside
 * the prefix. The Illuminate request rides along as a PSR-7 attribute, which
 * is what the host's `authorize` receives (session, cookies, `ip()`), exactly
 * as Rails hands its hooks ActionDispatch::Request.
 */
final class OpenReceiveController
{
    public function __invoke(Request $request, Engine $engine): Response
    {
        $factory = new Psr17Factory();
        $psrRequest = (new PsrHttpFactory($factory, $factory, $factory, $factory))
            ->createRequest($request)
            ->withAttribute(RequestHandler::HOST_REQUEST_ATTRIBUTE, $request);
        $psrResponse = $engine->psr15Handler()->handle($psrRequest);
        return (new HttpFoundationFactory())->createResponse($psrResponse);
    }
}
