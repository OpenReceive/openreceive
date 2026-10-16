<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Route;
use Paymenter\Extensions\Gateways\OpenReceive\Support\Endpoint;
use Paymenter\Extensions\Gateways\OpenReceive\Support\Runtime;

// The web group brings the session the invoice owner is signed in with, and
// Laravel's CSRF check on every POST.
Route::middleware('web')->group(static function (): void {
    Route::get(Runtime::ASSET_PREFIX . '/{file}', [Endpoint::class, 'asset'])
        ->where('file', 'openreceive-checkout\.(?:js|css)')
        ->name('extensions.gateways.openreceive.asset');
    Route::any(Runtime::PREFIX . '/{path}', [Endpoint::class, 'api'])
        ->where('path', '.*')
        ->name('extensions.gateways.openreceive.api');
});
