<?php

// Host-owned database. OpenReceive has no database configuration of its own —
// it persists its two tables in whatever connection this app already uses.
//
// Locally the shop is a SQLite file (WAL, busy timeout) under
// examples/buttons/.data like the Node stacks, or under OPENRECEIVE_DEMO_DB
// when the E2E harness points it at a temp directory. compose.yml sets
// DB_CONNECTION=pgsql and DATABASE_URL for the host Postgres service.

$demoDb = env('OPENRECEIVE_DEMO_DB');
$sqlitePath = is_string($demoDb) && $demoDb !== ''
    ? rtrim($demoDb, '/').'/buttons-laravel.sqlite'
    : dirname(__DIR__, 3).'/.data/buttons-laravel.sqlite';

return [
    'default' => env('DB_CONNECTION', 'sqlite'),

    'connections' => [
        'sqlite' => [
            'driver' => 'sqlite',
            'database' => env('DB_DATABASE', $sqlitePath),
            'prefix' => '',
            'foreign_key_constraints' => true,
            'busy_timeout' => 5000,
            'journal_mode' => 'WAL',
            'synchronous' => 'NORMAL',
        ],

        'pgsql' => [
            'driver' => 'pgsql',
            'url' => env('DATABASE_URL', env('DB_URL')),
            'charset' => 'utf8',
            'prefix' => '',
            'prefix_indexes' => true,
            'search_path' => 'public',
            'sslmode' => 'prefer',
        ],
    ],

    'migrations' => [
        'table' => 'migrations',
        'update_date_on_publish' => true,
    ],
];
