<?php

declare(strict_types=1);

namespace OpenReceive\Nwc;

use OpenReceive\Kernel;
use OpenReceive\Money\Money;
use OpenReceive\Support\Integers;
use OpenReceive\Support\Records;

/**
 * NIP-47 request building and reply normalization for the two receive
 * methods. Pinned by nwc-request-response, make-invoice-validation and
 * amount-boundaries. Everything here throws InvalidArgumentException on a
 * malformed input, which the service maps to a 400 at the payer boundary and
 * to a wallet contract failure past it.
 */
final class Requests
{
    /** The transaction states OpenReceive recognizes (the JS TransactionState union). */
    public const TRANSACTION_STATES = ['pending', 'settled', 'expired', 'failed', 'accepted'];

    /** @return array<string, mixed> */
    public static function makeInvoiceRequest(mixed $request): array
    {
        $data = Records::asArray($request);
        if (self::present($data['description'] ?? null) && self::present($data['description_hash'] ?? null)) {
            throw new \InvalidArgumentException('description and description_hash cannot both be set');
        }
        if (array_key_exists('description_hash', $data)
            && preg_match(Kernel::HEX_64_PATTERN, (string) self::scalarText($data['description_hash'])) !== 1) {
            throw new \InvalidArgumentException('description_hash must be 64 hex characters');
        }
        if (!array_key_exists('amount_msats', $data)) {
            throw new \InvalidArgumentException('amount_msats is required');
        }
        $result = ['amount' => Money::boundedMsats($data['amount_msats'])];
        if (array_key_exists('description', $data)) {
            $result['description'] = $data['description'];
        }
        if (array_key_exists('description_hash', $data)) {
            $result['description_hash'] = $data['description_hash'];
        }
        if (array_key_exists('expiry', $data)) {
            $result['expiry'] = Integers::parse($data['expiry'], 'expiry');
        }
        if (array_key_exists('metadata', $data)) {
            $encoded = json_encode($data['metadata'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            if ($encoded === false || strlen($encoded) > Kernel::NWC_METADATA_MAX_BYTES) {
                throw new \InvalidArgumentException('metadata is too large');
            }
            $result['metadata'] = $data['metadata'];
        }
        return $result;
    }

    /** @return array<string, mixed> */
    public static function normalizeMakeInvoiceResponse(mixed $response): array
    {
        $data = Records::asArray(self::unwrap($response));
        if (!isset($data['invoice']) || !is_string($data['invoice'])) {
            throw new \InvalidArgumentException('make_invoice response is missing invoice');
        }
        $hash = $data['payment_hash'] ?? $data['paymentHash'] ?? null;
        return Records::compact([
            'invoice' => $data['invoice'],
            'payment_hash' => strtolower((string) self::scalarText($hash)),
            'amount_msats' => Integers::parse($data['amount_msats'] ?? $data['amount'] ?? null, 'amount_msats'),
            'created_at' => Integers::optional($data['created_at'] ?? $data['createdAt'] ?? null, 'created_at'),
            'expires_at' => Integers::optional($data['expires_at'] ?? $data['expiresAt'] ?? null, 'expires_at'),
        ]);
    }

    /** @return array<string, mixed> */
    public static function listTransactionsRequest(mixed $request): array
    {
        $data = Records::asArray($request);
        $result = [];
        foreach (['from', 'until', 'offset', 'limit'] as $key) {
            if (array_key_exists($key, $data)) {
                $result[$key] = Integers::parse($data[$key], $key);
            }
        }
        if (array_key_exists('type', $data)) {
            $result['type'] = $data['type'];
        }
        if (array_key_exists('unpaid', $data)) {
            $result['unpaid'] = $data['unpaid'];
        }
        // Mirrors JS: limit must be a positive integer; callers' limits pass
        // through (the engine's own scans use the kernel page limit).
        if (array_key_exists('limit', $result) && $result['limit'] <= 0) {
            throw new \InvalidArgumentException('limit must be a positive integer');
        }
        return $result;
    }

    /**
     * A non-empty reply in a shape we do not recognize must NOT read as an
     * empty scan: an empty-looking scan at/after expiry+grace closes pending
     * attempts as expired. One quirky row never rejects the whole scan
     * (skipped and counted), but ALL rows unusable is the unrecognized-shape
     * case wearing a different hat. Mirrors the JS normalizeListTransactionsResult.
     *
     * @return array{transactions: list<array<string, mixed>>, skipped_rows?: int}
     */
    public static function normalizeListTransactionsResponse(mixed $response): array
    {
        $unwrapped = self::unwrap($response);
        $data = Records::asArray($unwrapped);
        if (isset($data['transactions']) && is_array($data['transactions'])) {
            $rows = array_values($data['transactions']);
        } elseif (is_array($unwrapped) && array_is_list($unwrapped)) {
            $rows = $unwrapped;
        } elseif ($unwrapped === null || (Records::isRecord($unwrapped) && $data === [])) {
            $rows = [];
        } else {
            throw new \InvalidArgumentException('list_transactions returned an unrecognized result shape');
        }
        $transactions = [];
        $skipped = 0;
        foreach ($rows as $row) {
            try {
                $transactions[] = self::normalizeTransaction($row);
            } catch (\InvalidArgumentException) {
                $skipped++;
            }
        }
        if ($transactions === [] && $skipped > 0) {
            throw new \InvalidArgumentException('list_transactions returned no usable rows');
        }
        $result = ['transactions' => $transactions];
        if ($skipped > 0) {
            $result['skipped_rows'] = $skipped;
        }
        return $result;
    }

    /** @return array<string, mixed> */
    public static function normalizeTransaction(mixed $transaction): array
    {
        $data = Records::asArray($transaction);
        return Records::compact([
            'type' => $data['type'] ?? null,
            'invoice' => $data['invoice'] ?? null,
            'payment_hash' => self::optionalPaymentHash($data['payment_hash'] ?? $data['paymentHash'] ?? null),
            'amount_msats' => Integers::optional($data['amount_msats'] ?? $data['amount'] ?? null, 'amount_msats'),
            'transaction_state' => self::transactionState($data),
            'created_at' => Integers::optional($data['created_at'] ?? $data['createdAt'] ?? null, 'created_at'),
            'expires_at' => Integers::optional($data['expires_at'] ?? $data['expiresAt'] ?? null, 'expires_at'),
            'settled_at' => Integers::optional($data['settled_at'] ?? $data['settledAt'] ?? null, 'settled_at'),
            'fees_paid_msats' => Integers::optional($data['fees_paid'] ?? $data['feesPaid'] ?? null, 'fees_paid'),
            'preimage' => $data['preimage'] ?? null,
        ]);
    }

    /**
     * Recognized states pass through lowercased; a wallet that signals
     * settlement only via boolean settled/paid flags maps to "settled".
     *
     * @param array<string, mixed> $data
     */
    public static function transactionState(array $data): ?string
    {
        $raw = $data['transaction_state'] ?? $data['transactionState'] ?? $data['state'] ?? null;
        if (is_string($raw) && in_array(strtolower($raw), self::TRANSACTION_STATES, true)) {
            return strtolower($raw);
        }
        if (($data['settled'] ?? null) === true || ($data['paid'] ?? null) === true) {
            return 'settled';
        }
        return null;
    }

    /** A NIP-47 envelope's `result`, or the value itself when it is already the payload. */
    public static function unwrap(mixed $value): mixed
    {
        $data = Records::asArray($value);
        return array_key_exists('result', $data) ? $data['result'] : $value;
    }

    /**
     * ABSENT means absent — a row minted by another app through the same
     * wallet legitimately carries no hash. PRESENT but not 64 hex is a row we
     * do not understand; it throws so the scan skips and counts it.
     */
    public static function optionalPaymentHash(mixed $value): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }
        $hash = strtolower((string) self::scalarText($value));
        if (preg_match(Kernel::LOWER_HEX_64_PATTERN, $hash) !== 1) {
            throw new \InvalidArgumentException('payment_hash must be 64 hexadecimal characters');
        }
        return $hash;
    }

    private static function present(mixed $value): bool
    {
        return $value !== null && $value !== '';
    }

    private static function scalarText(mixed $value): string
    {
        if (is_scalar($value)) {
            return (string) $value;
        }
        if ($value === null) {
            return '';
        }
        throw new \InvalidArgumentException('expected a scalar value');
    }
}
