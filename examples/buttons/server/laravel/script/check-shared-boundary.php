<?php

declare(strict_types=1);

// THE SHARED BOUNDARY, enforced. examples/buttons/shared/ is laid out so a
// wrong import is visible in the diff rather than discovered at build time:
//
//   client/          React + Mantine + mobx-keystone. Rails, Next.js, Laravel.
//   client-vanilla/  the no-framework host ONLY.
//   server-node/     SQLite and Express. The Node stacks ONLY.
//
// This app has Eloquent and its own controllers, so its browser code may
// import shared/shop-types.ts, shared/http.ts, shared/bootstrap.ts,
// shared/checkout-resume.ts, shared/shop.css and shared/client/** — and never
// shared/server-node/** or shared/client-vanilla/**.

$root = dirname(__DIR__);
$files = [];
foreach (['resources/js', 'vite'] as $dir) {
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root.'/'.$dir, FilesystemIterator::SKIP_DOTS));
    foreach ($iterator as $file) {
        if (preg_match('/\.(ts|tsx|js|jsx)$/', $file->getFilename()) === 1) {
            $files[] = $file->getPathname();
        }
    }
}
$files[] = $root.'/vite.config.ts';

$violations = [];
foreach ($files as $path) {
    foreach (file($path, FILE_IGNORE_NEW_LINES) ?: [] as $index => $line) {
        foreach (['server-node', 'client-vanilla'] as $forbidden) {
            if (str_contains($line, "shared/{$forbidden}/")) {
                $violations[] = str_replace($root.'/', '', $path).':'.($index + 1)." imports shared/{$forbidden}/";
            }
        }
    }
}

if ($violations !== []) {
    fwrite(STDERR, "The Laravel demo may only import shared/shop-types.ts, shared/*.ts and shared/client/**:\n");
    foreach ($violations as $violation) {
        fwrite(STDERR, "- {$violation}\n");
    }
    exit(1);
}

echo 'Shared-boundary check passed: '.count($files)." client files, no shared/server-node or shared/client-vanilla imports.\n";
