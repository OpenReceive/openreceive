<?php

// Everything to stderr: the Vite dev server and the compose logs show the
// engine's INFO lines and the shop's on_paid line next to each other.
return [
    'default' => env('LOG_CHANNEL', 'stderr'),
];
