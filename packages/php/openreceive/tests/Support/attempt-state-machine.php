<?php

declare(strict_types=1);

// `npm run test:model` runs this: it replays a file of attempt-state-machine
// sequences and prints a JSON report of every result.

use OpenReceive\Tests\Support\AttemptStateMachineRunner;

require dirname(__DIR__, 2) . '/vendor/autoload.php';

$family = json_decode((string) file_get_contents($argv[1]), true, flags: JSON_THROW_ON_ERROR);
$results = [];
foreach ($family['sequences'] as $sequence) {
    $results[] = AttemptStateMachineRunner::runSequence($sequence);
}
fwrite(STDOUT, json_encode($results, JSON_THROW_ON_ERROR) . PHP_EOL);
