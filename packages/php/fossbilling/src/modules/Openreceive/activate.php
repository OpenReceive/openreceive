<?php

declare(strict_types=1);

/*
 * `php modules/Openreceive/activate.php`, from FOSSBilling's folder, as the
 * web server's user: activates the OpenReceive module the way the admin
 * area's Extensions page does. That creates the payment tables and the
 * payment gateway (off until a wallet code is saved), hooks the reconcile
 * pass into FOSSBilling's cron, and makes the openreceive:* console commands
 * available. Safe to run again.
 */
if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

$root = dirname(__DIR__, 2);
if (!is_file($root . '/console.php') || !is_file($root . '/config.php')) {
    fwrite(STDERR, "Run this from an installed FOSSBilling: {$root} has no console.php or config.php.\n");
    exit(1);
}
chdir($root);
require_once $root . '/load.php';
$di = include $root . '/di.php';
$di['translate']();

try {
    $di['mod_service']('extension')->activateExistingExtension(['type' => 'mod', 'id' => 'openreceive']);
} catch (Throwable $error) {
    fwrite(STDERR, 'OpenReceive was not activated: ' . $error->getMessage() . "\n");
    exit(1);
}

// FOSSBilling connects every module's event hooks on each cron run, or at an
// admin's first login. Before either, the admin area's activation hook does
// not run, so connect them all now, as the cron run would, which hooks the
// reconcile pass into FOSSBilling's cron.
if (!$di['mod_service']('hook')->batchConnect()) {
    fwrite(STDERR, "OpenReceive is active, but FOSSBilling was busy connecting event hooks. Run this again.\n");
    exit(1);
}

echo "OpenReceive is active: its tables and its payment gateway exist, and FOSSBilling's cron runs its reconcile pass.\n";
echo "Next, save the receive-only wallet code: php console.php openreceive:configure --nwc-uri=- < /path/to/code-file\n";
