<?php

/**
 * Optional PHP live-wallet smoke, the twin of ruby-smoke.rb and index.mjs.
 * Reads NWC_URI from the environment or the root .env, REDACTS the connection
 * string (the secret is never printed), runs the receive-only preflight
 * through the production NostrPhpNwcReceiveClient, and creates an invoice
 * only with OPENRECEIVE_LIVE_CREATE_INVOICE=1 — the same opt-in as Node and
 * Ruby, so one command means one thing on every engine. Skips clearly when
 * NWC_URI is unset. Never part of the deterministic gate.
 */

declare(strict_types=1);

$root = dirname(__DIR__, 2);
$autoload = "{$root}/packages/php/openreceive/vendor/autoload.php";
if (!is_file($autoload)) {
    echo "PHP engine dependencies are not installed (composer install in packages/php/openreceive); skipping PHP live NWC smoke test.\n";
    exit(0);
}
require $autoload;

use OpenReceive\Nwc\Info;
use OpenReceive\Nwc\NostrPhpNwcReceiveClient;
use OpenReceive\Nwc\Uri;
use OpenReceive\Server\Reconciler;
use OpenReceive\Server\Service;

// Mirrors the JS twin's process.loadEnvFile closely enough for this repo's
// .env: `export NAME=value` lines and single/double-quoted values both load.
$dotenv = "{$root}/.env";
if (is_file($dotenv)) {
    foreach (file($dotenv, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
        $entry = preg_replace('/^export\s+/', '', trim($line)) ?? '';
        [$name, $value] = array_pad(explode('=', $entry, 2), 2, '');
        if (!in_array($name, ['NWC_URI', 'LSC_URI_PRIMARY', 'LSC_URI_BACKUP'], true) || getenv($name) !== false) {
            continue;
        }
        $value = trim($value);
        if (strlen($value) >= 2 && (($value[0] === '"' && str_ends_with($value, '"')) || ($value[0] === "'" && str_ends_with($value, "'")))) {
            $value = substr($value, 1, -1);
        }
        putenv("{$name}={$value}");
    }
}

$nwc = trim((string) getenv('NWC_URI'));
if ($nwc === '') {
    echo "NWC_URI is not set; skipping PHP live NWC smoke test.\n";
    exit(0);
}

$expectedPath = getenv('OPENRECEIVE_EXPECTED_CAPABILITIES') ?: "{$root}/tools/live-nwc-test/expected_capabilities.json";
if (!is_file($expectedPath)) {
    $expectedPath = "{$root}/tools/live-nwc-test/expected_capabilities.example.json";
}
$expected = json_decode((string) file_get_contents($expectedPath), true, 512, JSON_THROW_ON_ERROR);

function redact(string $text): string
{
    return preg_replace('/([?&]secret=)[^&\s"\'`<>]+/', '$1[REDACTED]', $text) ?? '[REDACTED]';
}

try {
    $parsed = Uri::parse($nwc);
    echo 'PHP NWC URI parsed for wallet profile: ' . $expected['wallet_profile'] . "\n";
    echo 'Wallet pubkey prefix: ' . substr($parsed['wallet_pubkey'], 0, 8) . "...\n";
    echo 'Relay count: ' . count($parsed['relays']) . "\n";
    echo 'Connection: ' . $parsed['redacted'] . "\n";
    echo 'Expected methods: ' . implode(', ', $expected['required_methods']) . "\n";

    $client = new NostrPhpNwcReceiveClient($nwc);
    $summary = Info::summarize($client->preflight());
    $missing = array_values(array_diff($expected['required_methods'], $summary['methods']));
    if ($missing !== []) {
        fwrite(STDERR, 'PHP NWC preflight missing required methods: ' . implode(', ', $missing) . "\n");
        exit(1);
    }
    echo "PHP NWC preflight ready: true\n";
    echo 'Advertised method count: ' . count($summary['methods']) . "\n";
    echo 'Encryption: ' . ($summary['encryption'] ?? 'none') . "\n";

    if (getenv('OPENRECEIVE_LIVE_CREATE_INVOICE') !== '1') {
        echo "OPENRECEIVE_LIVE_CREATE_INVOICE is not 1; skipping PHP invoice creation.\n";
        exit(0);
    }

    // The capability check above already ran; a spend-capable wallet is warned
    // about, not refused, matching the JS smoke's warn-and-continue behavior.
    $service = new Service($client, false, [], ['USD'], null, true);
    $invoice = $client->makeInvoice([
        'amount_msats' => (int) (getenv('OPENRECEIVE_LIVE_AMOUNT_MSATS') ?: 1000),
        'description' => 'OpenReceive PHP live smoke',
    ]);
    echo 'Created PHP live invoice payment hash prefix: ' . substr($invoice['payment_hash'], 0, 8) . "...\n";

    $check = static function () use ($service, $invoice): array {
        // Settlement is proven through the PRODUCTION reconcile path, never a hand-rolled query.
        $checked = $service->reconcilePayments(['attempts' => [['payment_hash' => $invoice['payment_hash'], 'created_at' => $invoice['created_at'] ?? time()]]]);
        return $checked[0] ?? ['payment_hash' => $invoice['payment_hash'], 'status' => 'scan_incomplete'];
    };
    $status = $check()['status'];
    echo "Initial PHP payment status via production reconcile: {$status}\n";
    if (getenv('OPENRECEIVE_LIVE_WAIT_FOR_PAYMENT') !== '1') {
        echo "Set OPENRECEIVE_LIVE_WAIT_FOR_PAYMENT=1 to poll the production reconcile until settlement.\n";
        exit(0);
    }
    $expiresAt = $invoice['expires_at'] ?? (($invoice['created_at'] ?? time()) + 900);
    while (!in_array($status, ['settled', 'expired', 'failed'], true)) {
        if (time() > $expiresAt) {
            echo "Final PHP outcome: expired (local_expiry_elapsed)\n";
            exit(1);
        }
        sleep(2);
        $status = $check()['status'];
        echo "PHP workflow transition: {$status}\n";
    }
    echo "Final PHP outcome: {$status}\n";
    exit($status === 'settled' ? 0 : 1);
} catch (\Throwable $e) {
    fwrite(STDERR, redact(Reconciler::sanitizeFailureMessage($e)) . "\n");
    exit(1);
}
