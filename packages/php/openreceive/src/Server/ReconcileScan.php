<?php

declare(strict_types=1);

namespace OpenReceive\Server;

use OpenReceive\Settlement\Settlement;

/** Durable bounded wallet slices; checkpoints never contain wallet payloads or credentials. */
final class ReconcileScan
{
    public static function newWindow(array $attempts, int $now, int $overlap): array
    {
        if ($attempts === []) throw new \InvalidArgumentException('A reconciliation window requires pending attempts.');
        $timestamps = array_column($attempts, 'created_at');
        if ($timestamps === []) throw new \InvalidArgumentException('A reconciliation window requires creation timestamps.');
        $trusted = count(array_filter($attempts, static fn (array $attempt): bool => ($attempt['created_at_source'] ?? 'host') !== 'wallet')) === 0;
        return ['attempts' => $attempts,
            'from' => $trusted ? max(0, min($timestamps) - $overlap) : 0,
            'until' => $trusted ? max($timestamps) + $overlap : null,
            'view' => 'default', 'offset' => 0, 'anchor_offset' => null, 'fingerprint' => null,
            'started_at' => $now, 'absence_safe' => true, 'observations' => []];
    }

    /** @return array{checks: list<array<string, mixed>>, complete: bool, stalled: bool} */
    public static function slice(Service $service, array &$window, int $maxPages, float $deadline, ?callable $onPositive = null): array
    {
        $results = [];
        $expected = array_fill_keys(array_column($window['attempts'], 'payment_hash'), true);
        $used = 0;
        $resumed = $window['offset'] > 0 || $window['view'] !== 'default';
        // Offset membership can move between passes. Stable boundaries alone
        // cannot prove that unseen earlier entries did not change.
        if ($resumed) $window['absence_safe'] = false;
        $anchor = $resumed ? $window['anchor_offset'] : null;
        $previous = $window['fingerprint'];
        $replayingAnchor = $anchor !== null;
        while ($used < $maxPages && hrtime(true) / 1e9 < $deadline) {
            $offset = $replayingAnchor ? $anchor : $window['offset'];
            $request = ['type' => 'incoming', 'limit' => 20, 'offset' => $offset, 'from' => $window['from']];
            if ($window['until'] !== null) $request['until'] = $window['until'];
            if ($window['view'] === 'inclusive') $request['unpaid'] = true;
            $request['_deadline'] = microtime(true) + max(0, $deadline - hrtime(true) / 1e9);
            $page = $service->reconciliationPage($request);
            $used++;
            $rows = $page['transactions'];
            $physical = count($rows) + ($page['skipped_rows'] ?? 0);
            $fingerprint = hash('sha256', json_encode(array_column($rows, 'payment_hash'), JSON_THROW_ON_ERROR));
            foreach ($rows as $row) {
                $hash = $row['payment_hash'] ?? null;
                if (!isset($expected[$hash]) || !in_array($row['type'] ?? null, [null, 'incoming'], true)) continue;
                $status = Settlement::status($row);
                if (($window['observations'][$hash]['status'] ?? null) === 'settled') continue;
                // Wallet evidence remains observed even if its host transaction rolls back.
                // Otherwise the end of this same sweep could invent absence for a paid hash.
                $window['observations'][$hash] = ['status' => $status, 'transaction_state' => $row['transaction_state'] ?? null];
                if (in_array($status, ['settled', 'expired', 'failed'], true)) {
                    $checked = $service->paymentResult($hash, $row);
                    // Commit evidence while this page is available. A later page
                    // failure cannot erase already authenticated wallet finality.
                    if ($onPositive !== null && !$onPositive($checked)) continue;
                    $results[$hash] = $checked;
                }
            }
            if ($replayingAnchor) {
                $replayingAnchor = false;
                $window['offset'] = $offset + $physical;
                $previous = $fingerprint;
                if ($physical > 0) {
                    $window['anchor_offset'] = $offset;
                    $window['fingerprint'] = $fingerprint;
                    continue;
                }
            }
            if ($physical === 0) {
                if ($window['view'] === 'default') {
                    $window['view'] = 'inclusive';
                    $window['offset'] = 0;
                    $window['anchor_offset'] = null;
                    $window['fingerprint'] = null;
                    $previous = null;
                    continue;
                }
                if ($window['absence_safe']) {
                    foreach (array_keys($expected) as $hash) {
                        $observation = $window['observations'][$hash] ?? null;
                        if (isset($results[$hash]) || in_array($observation['status'] ?? null, ['settled', 'expired', 'failed'], true)) continue;
                        $checked = ['payment_hash' => $hash, 'status' => $observation['status'] ?? 'not_found', '_coverage_started_at' => $window['started_at']];
                        if ($observation !== null) $checked['details'] = ['transaction' => ['transaction_state' => $observation['transaction_state']]];
                        $results[$hash] = $checked;
                    }
                }
                return ['checks' => array_values($results), 'complete' => true, 'stalled' => false];
            }
            if ($fingerprint === $previous) return ['checks' => array_values($results), 'complete' => false, 'stalled' => true];
            $window['anchor_offset'] = $offset;
            $window['fingerprint'] = $fingerprint;
            $window['offset'] = $offset + $physical;
            $previous = $fingerprint;
            $outstanding = array_filter(array_keys($expected), static fn (string $hash): bool => !in_array($window['observations'][$hash]['status'] ?? null, ['settled', 'expired', 'failed'], true));
            if ($outstanding === []) return ['checks' => array_values($results), 'complete' => true, 'stalled' => false];
        }
        return ['checks' => array_values($results), 'complete' => false, 'stalled' => false];
    }
}
