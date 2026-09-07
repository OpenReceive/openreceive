<?php

/**
 * The storage-free cross-language conformance harness for the PHP engine (the
 * ruby-crosslang.rb twin): every shared vector family runs against the
 * production functions — never a re-implementation — and the first drift
 * exits non-zero. `tools/ci/php-tests.sh` runs it after the PHPUnit suites.
 * Run from the repository root: php tools/conformance/php-crosslang.php
 */

declare(strict_types=1);

$root = dirname(__DIR__, 2);
$autoload = "{$root}/packages/php/openreceive/vendor/autoload.php";
if (!is_file($autoload)) {
    fwrite(STDERR, "php-crosslang: run `composer install` in packages/php/openreceive first.\n");
    exit(1);
}
require $autoload;

use OpenReceive\Money\Money;
use OpenReceive\Nwc\Errors;
use OpenReceive\Nwc\Info;
use OpenReceive\Nwc\NwcUriParseError;
use OpenReceive\Nwc\ReceiveNwcClient;
use OpenReceive\Nwc\Requests;
use OpenReceive\Nwc\Uri;
use OpenReceive\Payments\Reconciliation;
use OpenReceive\Server\Service;
use OpenReceive\Settlement\Settlement;
use OpenReceive\Storage\PaymentsSchema;
use OpenReceive\Storage\PdoConnection;
use OpenReceive\Storage\SqlPaymentRepository;
use OpenReceive\Storage\Timestamps;
use OpenReceive\Swap\LscUri;
use OpenReceive\Swap\StateTable;
use OpenReceive\Swap\SwapAddress;

/** @return array<string, mixed> */
function vector(string $name): array
{
    global $root;
    return json_decode((string) file_get_contents("{$root}/spec/test-vectors/{$name}.json"), true, 512, JSON_THROW_ON_ERROR | JSON_BIGINT_AS_STRING);
}

function fail(string $message): never
{
    fwrite(STDERR, "php-crosslang: {$message}\n");
    exit(1);
}

function same(mixed $expected, mixed $actual): bool
{
    $canonical = static function (mixed $value) use (&$canonical): mixed {
        if (!is_array($value)) {
            return $value;
        }
        $value = array_map($canonical, $value);
        if (!array_is_list($value)) {
            ksort($value);
        }
        return $value;
    };
    return $canonical($expected) === $canonical($actual);
}

// fiat-to-msats: every quote case must match the shared ceil-to-whole-sat rule.
$fiat = vector('fiat-to-msats.usd');
foreach ($fiat['cases'] as $case) {
    $msats = Money::quoteFiatToMsats($case['fiat']['value'], $fiat['btc_fiat_price']);
    if ($msats !== $case['expected']['amount_msats']) {
        fail("fiat-to-msats parity failed: {$case['name']} (got {$msats})");
    }
}
foreach ($fiat['invalid_cases'] ?? [] as $case) {
    try {
        $got = Money::quoteFiatToMsats($case['fiat']['value'], $fiat['btc_fiat_price']);
        fail("fiat-to-msats parity failed: {$case['name']} was accepted (got {$got})");
    } catch (\InvalidArgumentException) {
        // Refused, as required.
    }
}

// amount-boundaries: bounded msats acceptance must match exactly.
foreach (vector('amount-boundaries')['cases'] as $case) {
    try {
        Money::boundedMsats($case['amount_msats']);
        $valid = true;
    } catch (\InvalidArgumentException) {
        $valid = false;
    }
    if ($valid !== $case['valid']) {
        fail("amount-boundaries parity failed: {$case['name']}");
    }
}

// rate-limit-window: the per-IP budget windows on the same immutable column,
// through the production repository query on sqlite in memory.
$rateLimit = vector('rate-limit-window');
if ($rateLimit['column'] !== 'inserted_at') {
    fail("rate-limit-window parity failed: unexpected column {$rateLimit['column']}");
}
$db = new PdoConnection(new PDO('sqlite::memory:'));
PaymentsSchema::migrate($db);
$repository = new SqlPaymentRepository($db);
foreach ($rateLimit['cases'] as $index => $case) {
    $ip = "10.9.0.{$index}";
    $attempt = $case['attempt'];
    $db->execute(
        'INSERT INTO openreceive_payments (reference, payment_hash, status, expires_at, checkout_data, client_ip, inserted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ["ref-{$index}", str_pad((string) $index, 64, '0', STR_PAD_LEFT), 'pending', Timestamps::toDb(99_999), '{}', $ip,
            Timestamps::toDb($attempt['inserted_at']), Timestamps::toDb($attempt['created_at']), Timestamps::toDb($attempt['updated_at'])]
    );
    $counted = $repository->countAttemptsFromIp($ip, $case['now'] - $case['window_seconds']) === 1;
    if ($counted !== $case['expected']['counted']) {
        fail("rate-limit-window parity failed: {$case['name']}");
    }
}

// swap-address: a checksum, not a shape guard.
foreach (vector('swap-address')['cases'] as $case) {
    $actual = SwapAddress::isValidForNetwork($case['network'], $case['address']);
    if ($actual !== $case['expected']['valid']) {
        fail("swap-address parity failed: {$case['name']}");
    }
}

// settlement-detection: the shared finality rule (never a preimage alone) and the 4-way status.
foreach (vector('settlement-detection')['cases'] as $case) {
    if (Settlement::isSettled($case['transaction']) !== $case['expected']['settled']) {
        fail("settlement-detection parity failed: {$case['name']}");
    }
    if (isset($case['expected']['status']) && Settlement::status($case['transaction']) !== $case['expected']['status']) {
        fail("settlement-detection parity failed: {$case['name']} status");
    }
}

// make-invoice-validation: request validation before any wallet call.
foreach (vector('make-invoice-validation')['cases'] as $case) {
    $request = $case['request'];
    if (isset($request['metadata_note_length'])) {
        $request['metadata'] = ['note' => str_repeat('x', $request['metadata_note_length'])];
        unset($request['metadata_note_length']);
    }
    try {
        Requests::makeInvoiceRequest($request);
        $valid = true;
    } catch (\InvalidArgumentException) {
        $valid = false;
    }
    if ($valid !== $case['expected']['valid']) {
        fail("make-invoice-validation parity failed: {$case['name']}");
    }
}

// nwc-request-response: NIP-47 request mapping and response normalization.
foreach (vector('nwc-request-response')['cases'] as $case) {
    if ($case['method'] === 'make_invoice') {
        if (!same($case['expected_nip47_request'], Requests::makeInvoiceRequest($case['openreceive_request']))) {
            fail("nwc-request-response parity failed: {$case['name']} request");
        }
        if (isset($case['expected_openreceive_response'])) {
            $actual = Requests::normalizeMakeInvoiceResponse($case['raw_response']);
            foreach ($case['expected_openreceive_response'] as $key => $value) {
                if (($actual[$key] ?? null) !== $value) {
                    fail("nwc-request-response parity failed: {$case['name']} response {$key}");
                }
            }
        }
        continue;
    }
    if (!same($case['expected_nip47_request'], Requests::listTransactionsRequest($case['openreceive_request']))) {
        fail("nwc-request-response parity failed: {$case['name']} request");
    }
    if (isset($case['expected_openreceive_response'])) {
        $actual = Requests::normalizeListTransactionsResponse($case['raw_response']);
        $expected = $case['expected_openreceive_response'];
        if (count($actual['transactions']) !== count($expected['transactions'])) {
            fail("nwc-request-response parity failed: {$case['name']} row count");
        }
        foreach ($expected['transactions'] as $index => $row) {
            foreach ($row as $key => $value) {
                if (($actual['transactions'][$index][$key] ?? null) !== $value) {
                    fail("nwc-request-response parity failed: {$case['name']} row {$index} {$key}");
                }
            }
        }
    }
}

// nwc-info: capabilities, encryption mode, spend detection, receive readiness.
foreach (vector('nwc-info')['cases'] as $case) {
    $summary = Info::summarize($case['raw_info']);
    $expected = $case['expected'];
    $warned = [];
    foreach ($summary['warnings'] as $warning) {
        if (preg_match("/'([^']+)'/", $warning, $match) === 1) {
            $warned[] = $match[1];
        }
    }
    $checks = [
        'methods' => $summary['methods'] === $expected['methods'],
        'encryption' => $summary['encryption'] === $expected['encryption'],
        'spend_capability_advertised' => $summary['spend_capability_advertised'] === $expected['spend_capability_advertised'],
        'receive_checkout_ready' => $summary['receive_checkout_ready'] === $expected['receive_checkout_ready'],
        'warning_methods' => $warned === $expected['warning_methods'],
    ];
    $failed = array_keys(array_filter($checks, static fn (bool $ok): bool => !$ok));
    if ($failed !== []) {
        fail("nwc-info parity failed: {$case['name']} (" . implode(', ', $failed) . ')');
    }
}

// nwc-uri-parse: identical parse results and error codes.
foreach (vector('nwc-uri-parse')['cases'] as $case) {
    if (isset($case['expected_error'])) {
        try {
            Uri::parse($case['uri']);
            fail("nwc-uri-parse parity failed: {$case['name']} did not raise");
        } catch (NwcUriParseError $e) {
            if ($e->errorCode !== $case['expected_error']) {
                fail("nwc-uri-parse parity failed: {$case['name']} raised {$e->errorCode}");
            }
        }
        continue;
    }
    $parsed = Uri::parse($case['uri']);
    $expected = $case['expected'];
    $checks = [
        'wallet_pubkey' => $parsed['wallet_pubkey'] === $expected['wallet_pubkey'],
        'relays' => $parsed['relays'] === $expected['relays'],
        'secret_present' => ($parsed['client_secret'] !== '') === $expected['secret_present'],
        'lud16' => ($parsed['lud16'] ?? null) === $expected['lud16'],
        'redacted' => $parsed['redacted'] === $expected['redacted'],
    ];
    $failed = array_keys(array_filter($checks, static fn (bool $ok): bool => !$ok));
    if ($failed !== []) {
        fail("nwc-uri-parse parity failed: {$case['name']} (" . implode(', ', $failed) . ')');
    }
}

// error-normalization: wallet failures map to canonical codes + retryable.
foreach (vector('error-normalization')['cases'] as $case) {
    $actual = Errors::normalizeWalletError($case['raw_error']);
    foreach ($case['expected'] as $key => $value) {
        if (($actual[$key] ?? null) !== $value) {
            fail("error-normalization parity failed: {$case['name']} {$key}");
        }
    }
}

// lsc-uri: parse expectations and refusals.
$lsc = vector('lsc-uri');
foreach ($lsc['valid'] as $case) {
    if (!same($case['expected'], LscUri::parse($case['uri']))) {
        fail("lsc-uri parity failed: {$case['name']}");
    }
}
foreach ($lsc['invalid'] as $case) {
    try {
        LscUri::parse($case['uri']);
        fail("lsc-uri parity failed: {$case['name']} was accepted");
    } catch (\InvalidArgumentException) {
        // Refused, as required.
    }
}

// swap-state: through the production interpreter of the generated decision table.
$swapState = vector('swap-state');
if ($swapState['provider'] !== 'fixedfloat') {
    fail('swap-state parity failed: unexpected provider');
}
foreach ($swapState['cases'] as $case) {
    $actual = StateTable::normalizeStatus($case['status'], $case['emergency'] ?? [], $case['refund_tx_present'] ? 'refund-tx' : null);
    if (!same($case['expected'], $actual)) {
        fail("swap-state parity failed: {$case['name']} (got " . json_encode($actual) . ')');
    }
}

if (Money::quoteFiatToMsats('10.00', '50000.00') !== 20_000_000) {
    fail('fiat parity failed');
}

// wallet-scan-truncation: through the production Service::reconcilePayments; a
// walk cut short must OMIT undecided hashes rather than report not_found.
$scanFamily = vector('wallet-scan-truncation');
$pageLimit = $scanFamily['page_limit'];
$fillerRow = static fn (int $page, int $index): array => [
    'type' => 'incoming', 'payment_hash' => str_repeat('f', 56) . sprintf('%08d', $page * 10_000 + $index),
    'amount_msats' => 1000, 'transaction_state' => 'settled', 'created_at' => 1000, 'settled_at' => 1100,
];
$buildPages = static function (?array $specs) use ($fillerRow): array {
    $pages = [];
    foreach ($specs ?? [] as $page => $spec) {
        $rows = $spec['rows'] ?? [];
        for ($index = 0; $index < ($spec['filler_rows'] ?? 0); $index++) {
            $rows[] = $fillerRow($page, $index);
        }
        $pages[] = $rows;
    }
    return $pages;
};
foreach ($scanFamily['cases'] as $case) {
    $walletSpec = $case['wallet'];
    $pages = $buildPages($walletSpec['pages']);
    $unpaidPages = isset($walletSpec['unpaid_pages']) ? $buildPages($walletSpec['unpaid_pages']) : $pages;
    $wallet = new class ($pages, $unpaidPages, (bool) ($walletSpec['ignores_offset'] ?? false), $pageLimit) implements ReceiveNwcClient {
        public function __construct(private readonly array $pages, private readonly array $unpaidPages, private readonly bool $ignoresOffset, private readonly int $pageLimit)
        {
        }

        public function makeInvoice(array $request): array
        {
            throw new \LogicException('not minted here');
        }

        public function listTransactions(array $request): array
        {
            $source = ($request['unpaid'] ?? false) === true ? $this->unpaidPages : $this->pages;
            $index = $this->ignoresOffset ? 0 : intdiv((int) ($request['offset'] ?? 0), $this->pageLimit);
            return ['transactions' => $source[$index] ?? []];
        }

        public function preflight(): array
        {
            return ['methods' => ['make_invoice', 'list_transactions'], 'encryption' => ['nip04']];
        }

        public function subscribeNotifications(callable $handler, ?callable $onIdle = null): void
        {
        }
    };
    $service = new Service($wallet, false, [], ['USD'], static fn (): int => $case['clock']);
    $input = ['attempts' => $case['attempts']];
    if (isset($case['max_pages'])) {
        $input['max_pages'] = $case['max_pages'];
    }
    $results = $service->reconcilePayments($input);
    $byHash = [];
    foreach ($results as $row) {
        $byHash[$row['payment_hash']] = $row['status'];
    }
    foreach ($case['expected']['results'] as $row) {
        if (($byHash[$row['payment_hash']] ?? null) !== $row['status']) {
            fail("wallet-scan-truncation parity failed: {$case['name']} {$row['payment_hash']}");
        }
    }
    foreach ($case['expected']['omitted'] as $hash) {
        if (isset($byHash[$hash])) {
            fail("wallet-scan-truncation parity failed: {$case['name']} {$hash} must be omitted");
        }
    }
    if (count($results) !== count($case['expected']['results'])) {
        fail("wallet-scan-truncation parity failed: {$case['name']} result count");
    }
}

// attempt-reconciliation: the closure decision table and the shared grace constant.
$reconciliation = vector('attempt-reconciliation');
if (Reconciliation::EXPIRY_GRACE_SECONDS !== $reconciliation['expiry_grace_seconds']) {
    fail('attempt expiry grace drifted from the shared vectors');
}
foreach ($reconciliation['vectors'] as $case) {
    $actual = Reconciliation::transition($case['attempt']['expires_at'], $case['status'], $case['observed_at'], $case['transaction_state'] ?? null);
    if ($actual !== $case['expected']) {
        fail("reconciliation parity failed: {$case['name']}");
    }
}

echo "php storage-free conformance: ok (fiat, amounts, settlement, make-invoice, nwc-info, nwc-uri, errors, reconciliation, rate-limit-window, lsc-uri, swap-address, swap-state, wallet-scan-truncation)\n";
