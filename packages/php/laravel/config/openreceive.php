<?php

// OpenReceive settings. Published by `php artisan openreceive:install`.
//
// HOOKS ARE CLASS NAMES, NOT CLOSURES. `php artisan config:cache` serializes
// this file with var_export, and a closure anywhere in it fails the cache
// ("Serialization of 'Closure' is not allowed"). The host class below is
// resolved from the container, so it may take constructor dependencies.
//
// Secrets stay in the environment: NWC_URI, LSC_URI_PRIMARY and LSC_URI_BACKUP
// are read through env() HERE (config:cache captures them at cache time, which
// is how Laravel treats every secret) and never appear in a log — the engine
// redacts connection strings, and `openreceive:doctor` prints set/unset only.

return [
    // Your OpenReceive\Host implementation: authorize / amountFor / onPaid.
    // `openreceive:install` scaffolds app/OpenReceive/Host.php with the two
    // generated placeholders; the engine warns at boot until both are replaced.
    'host' => App\OpenReceive\Host::class,

    // Fiat currencies GET /openreceive/rates quotes and amountFor may price in.
    'price_currencies' => ['USD'],

    // The built-in per-IP invoice cap, counted on the engine's own rows. Off by
    // default; turn it on for a public shop where every payer has their own
    // address (behind a proxy, Laravel's TrustProxies decides the client IP):
    // true, or ['limit_per_hour' => 60, 'limit_per_day' => 500].
    'rate_limiting' => false,

    // Settlement discovery on the request path: every mounted OpenReceive route
    // first runs one reconcile pass through the durable openreceive_meta gate
    // (shared by every worker; at least 2 s between real wallet scans). Set
    // false only when a dedicated worker owns scanning, or tune the floor with
    // ['min_interval_seconds' => 5].
    'opportunistic_reconcile' => true,

    // The middleware group the routes mount under. `web` brings the session and
    // CSRF check your authorize hook and the browser client rely on: Laravel's
    // VerifyCsrfToken reads X-CSRF-TOKEN, the checkout client sends it from
    // <meta name="csrf-token">, so no attribute is needed on the element.
    'middleware' => ['web'],

    // The database connection whose openreceive_payments / openreceive_meta
    // tables the engine owns. null = the default connection. The published
    // migration runs against the same connection.
    'connection' => null,

    // Where the routes mount: POST /openreceive/checkouts, GET /openreceive/rates, …
    // The browser packages default to the same prefix.
    'route_prefix' => 'openreceive',

    // The receive-only NWC code. Never a literal here — env() only.
    'nwc_uri' => env('NWC_URI'),

    // Swap providers (optional). Setting LSC_URI_PRIMARY auto-builds one; it
    // also commits you to a refund route back (docs: swap-refunds).
    'lsc_uri_primary' => env('LSC_URI_PRIMARY'),
    'lsc_uri_backup' => env('LSC_URI_BACKUP'),

    // The wallet preflight fails closed when the NWC code advertises spend
    // methods such as pay_invoice. This is the explicit override, also
    // honoured as OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=true in the environment.
    'allow_spend_capable_wallet' => (bool) env('OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC', false),

    // PHP boots the engine afresh on every request, and the Service runs the
    // receive-only wallet preflight (get_info) at construction. The info event
    // is remembered in your default cache store for this many seconds so a
    // checkout request costs one relay round trip, not two. 0 disables.
    'wallet_info_cache_seconds' => 600,

    // In production the wallet is checked when the application boots (a bad
    // NWC_URI stops the deploy instead of the first checkout). The secretless
    // build-step commands (config:cache, migrate, …) skip it and the workers
    // check on first use; set false to turn the boot check off entirely.
    'eager_preflight' => true,
];
