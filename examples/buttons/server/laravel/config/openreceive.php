<?php

// Published by `php artisan openreceive:install`, then filled in for the button
// shop. Hooks are a CLASS NAME (config:cache cannot serialize closures);
// secrets stay in the environment and are read through env() here.

return [
    // The three hooks. The whole bridge — see app/OpenReceive/Host.php.
    'host' => App\OpenReceive\Host::class,

    'price_currencies' => ['USD'],

    // Cap invoice creation per client IP, counted from the engine-owned
    // openreceive_payments rows. On here because this is a public web shop and
    // every payer arrives on their own address. Behind a proxy, configure
    // Laravel's TrustProxies so request()->ip() is the payer, not the proxy.
    'rate_limiting' => true,

    // Settlement discovery is opportunistic by default: every engine request
    // first runs one reconcile pass through the durable openreceive_meta gate
    // (shared by every Apache worker; min 2 s between real wallet scans), so
    // pending attempts settle or close on any later OpenReceive call — no
    // scheduled job required. Set false only if a dedicated worker owns scanning.
    'opportunistic_reconcile' => true,

    // The session and CSRF check the browser client and `authorize` rely on.
    'middleware' => ['web'],

    // null = the default connection: sqlite locally, Postgres in compose.
    'connection' => null,

    'route_prefix' => 'openreceive',

    'nwc_uri' => env('NWC_URI'),
    'lsc_uri_primary' => env('LSC_URI_PRIMARY'),
    'lsc_uri_backup' => env('LSC_URI_BACKUP'),
    'allow_spend_capable_wallet' => (bool) env('OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC', false),
    'wallet_info_cache_seconds' => 600,
    'eager_preflight' => true,
];
