<?php

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // The testkit control surface is driven by curl and Playwright's request
        // context, which carry no session token. It answers a JSON 404 in every
        // mode but DEMO_WALLET=testkit anyway — see app/Testkit/Testkit.php.
        $middleware->validateCsrfTokens(except: ['__testkit/*']);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        //
    })->create();
