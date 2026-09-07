<?php

// The session carries only the CSRF token, so it lives in an encrypted cookie:
// no table, no file store, and every Apache worker sees the same session.
return [
    'driver' => env('SESSION_DRIVER', 'cookie'),
    'lifetime' => (int) env('SESSION_LIFETIME', 120),
    'encrypt' => true,
    'same_site' => 'lax',
];
