<?php

declare(strict_types=1);

// The committed database/migrations/*_create_openreceive_tables.php is a
// snapshot of the openreceive/laravel install command's migration stub.
// Nothing else notices when the stub changes — the app boots from its own
// migrations — so this re-renders the stub through the command class it ships
// in and diffs the result against the committed file. On drift, copy the
// rendered stub over the committed file (keep the timestamped name).

require __DIR__.'/../vendor/autoload.php';

use OpenReceive\Laravel\Console\InstallCommand;

$root = dirname(__DIR__);
$committedPaths = glob($root.'/database/migrations/*_create_openreceive_tables.php') ?: [];
if ($committedPaths === []) {
    fwrite(STDERR, "check-migration-drift: no committed database/migrations/*_create_openreceive_tables.php found.\n");
    exit(1);
}
$committedPath = max($committedPaths);
$committed = (string) file_get_contents($committedPath);
$rendered = InstallCommand::renderMigration();

if ($rendered !== $committed) {
    $renderedLines = explode("\n", $rendered);
    $committedLines = explode("\n", $committed);
    fwrite(STDERR, str_replace($root.'/', '', $committedPath)." has drifted from the openreceive/laravel migration stub:\n");
    $shown = 0;
    for ($i = 0, $n = max(count($renderedLines), count($committedLines)); $i < $n && $shown < 15; $i++) {
        if (($renderedLines[$i] ?? null) === ($committedLines[$i] ?? null)) {
            continue;
        }
        fwrite(STDERR, sprintf("  line %d:\n    stub:      %s\n    committed: %s\n", $i + 1, var_export($renderedLines[$i] ?? '<missing>', true), var_export($committedLines[$i] ?? '<missing>', true)));
        $shown++;
    }
    exit(1);
}

echo 'Migration drift check passed: '.basename($committedPath)." matches the openreceive/laravel install stub.\n";
