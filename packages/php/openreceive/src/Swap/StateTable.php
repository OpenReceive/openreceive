<?php

declare(strict_types=1);

namespace OpenReceive\Swap;

use OpenReceive\Generated\Tables;

/**
 * FixedFloat status + emergency block + refund-tx presence → state and
 * reasons: an INTERPRETER of spec/data/swap-state-table.json (rendered into
 * Generated\Tables), first-match-wins. Pinned across engines by
 * spec/test-vectors/swap-state.json; how to read the rows lives in the JSON.
 */
final class StateTable
{
    /**
     * @param array<string, mixed> $emergency
     * @return array{state: string, attention?: bool, attention_reason?: string, refund_reason?: string}
     */
    public static function normalizeStatus(string $status, array $emergency, ?string $refundTxId): array
    {
        $normalized = strtoupper($status);
        $refundTxPresent = $refundTxId !== null;
        $rawChoice = $emergency['choice'] ?? null;
        $choice = is_string($rawChoice) && $rawChoice !== '' ? strtoupper($rawChoice) : null;
        $row = null;
        foreach (Tables::SWAP_STATUS_ROWS as $candidate) {
            if ($candidate['status'] === '*') {
                $statusMatches = $candidate['status_contains'] === null || str_contains($normalized, $candidate['status_contains']);
            } else {
                $statusMatches = $candidate['status'] === $normalized;
            }
            $refundMatches = $candidate['refund_tx_present'] === 'any' || $candidate['refund_tx_present'] === $refundTxPresent;
            $choiceMatches = $candidate['choice'] === 'any'
                || ($choice === null ? $candidate['choice'] === 'absent' : $candidate['choice'] === $choice);
            if ($statusMatches && $refundMatches && $choiceMatches) {
                $row = $candidate;
                break;
            }
        }
        if ($row === null) {
            throw new \LogicException('swap-state table has no catch-all row');
        }
        $result = ['state' => $row['state']];
        if ($row['attention_reason'] !== null) {
            $result['attention'] = true;
            $result['attention_reason'] = $row['attention_reason'];
        }
        if ($row['refund_reason_from_emergency']) {
            $reason = self::refundReasonFromEmergencyStatuses(self::stringList($emergency['status'] ?? null));
            if ($reason !== null) {
                $result['refund_reason'] = $reason;
            }
        }
        return $result;
    }

    /** @param list<string> $statuses */
    public static function refundReasonFromEmergencyStatuses(array $statuses): ?string
    {
        $present = array_map(static function (string $item): string {
            $upper = strtoupper($item);
            return Tables::SWAP_EMERGENCY_STATUS_ALIASES[$upper] ?? $upper;
        }, $statuses);
        foreach (Tables::SWAP_REFUND_REASON_ROWS as $row) {
            if (array_diff($row['all_of'], $present) === []) {
                return $row['refund_reason'];
            }
        }
        return null;
    }

    public static function isRefundPathState(string $state): bool
    {
        return in_array($state, ['refund_required', 'refund_pending', 'refunded'], true);
    }

    /** @return list<string> */
    private static function stringList(mixed $value): array
    {
        if (is_array($value)) {
            return array_values(array_filter(array_map(static fn (mixed $item): ?string => is_scalar($item) ? (string) $item : null, $value), static fn (?string $item): bool => $item !== null && $item !== ''));
        }
        return is_scalar($value) && (string) $value !== '' ? [(string) $value] : [];
    }
}
