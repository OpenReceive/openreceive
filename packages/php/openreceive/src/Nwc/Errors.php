<?php

declare(strict_types=1);

namespace OpenReceive\Nwc;

use OpenReceive\Generated\Tables;
use OpenReceive\Support\Records;

/**
 * Wallet / library failure normalization into the canonical error body shape
 * shared with JS and Ruby (spec/test-vectors/error-normalization.json):
 * { code, message, retryable, request_id?, details? }.
 */
final class Errors
{
    public const ERROR_CODES = Tables::ERROR_CODES;
    public const RETRYABLE_ERROR_CODES = Tables::RETRYABLE_ERROR_CODES;

    /** Wallet/library spellings that map onto canonical codes (the JS NWC_ERROR_CODE_ALIASES). */
    public const ERROR_CODE_ALIASES = [
        'ABORT_ERROR' => 'TIMEOUT',
        'BAD_REQUEST' => 'INVALID_REQUEST',
        'CONNECTION_ERROR' => 'WALLET_UNAVAILABLE',
        'EXPIRED' => 'INVOICE_EXPIRED',
        'FETCH_ERROR' => 'WALLET_UNAVAILABLE',
        'FORBIDDEN' => 'RESTRICTED',
        'INVOICE_NOT_FOUND' => 'NOT_FOUND',
        'INVALID_PARAMETER' => 'INVALID_REQUEST',
        'INVALID_PARAMETERS' => 'INVALID_REQUEST',
        'INVALID_PARAMS' => 'INVALID_REQUEST',
        'METHOD_NOT_FOUND' => 'UNSUPPORTED_METHOD',
        'NETWORK_ERROR' => 'WALLET_UNAVAILABLE',
        'NIP47_NETWORK_ERROR' => 'WALLET_UNAVAILABLE',
        'NOSTR_NETWORK_ERROR' => 'WALLET_UNAVAILABLE',
        'NOT_AUTHORIZED' => 'UNAUTHORIZED',
        'NOT_SUPPORTED' => 'UNSUPPORTED_METHOD',
        'NOTFOUND' => 'NOT_FOUND',
        'PERMISSION_DENIED' => 'RESTRICTED',
        'RELAY_CONNECTION_ERROR' => 'WALLET_UNAVAILABLE',
        'REQUEST_TIMEOUT' => 'TIMEOUT',
        'SERVICE_UNAVAILABLE' => 'WALLET_UNAVAILABLE',
        'TIMED_OUT' => 'TIMEOUT',
        'TIMEOUT_ERROR' => 'TIMEOUT',
        'UNKNOWN_METHOD' => 'UNSUPPORTED_METHOD',
        'UNSUPPORTED' => 'UNSUPPORTED_METHOD',
        'UNSUPPORTED_ENCRYPTION_MODE' => 'UNSUPPORTED_ENCRYPTION',
        'WALLET_OFFLINE' => 'WALLET_UNAVAILABLE',
        'WALLET_UNREACHABLE' => 'WALLET_UNAVAILABLE',
    ];

    public const ERROR_MESSAGES = [
        'NOT_IMPLEMENTED' => 'NWC wallet service does not implement this method.',
        'RESTRICTED' => 'NWC wallet service restricted this request.',
        'UNAUTHORIZED' => 'NWC wallet service rejected authorization.',
        'FORBIDDEN' => 'The host application did not authorize this request.',
        'RATE_LIMITED' => 'NWC wallet service rate limited this request.',
        'QUOTA_EXCEEDED' => 'NWC wallet service quota was exceeded.',
        'INTERNAL' => 'NWC wallet service returned an internal error.',
        'UNSUPPORTED_ENCRYPTION' => 'NWC wallet service does not support the required encryption mode.',
        'OTHER' => 'NWC wallet service returned an unknown error.',
        'NOT_FOUND' => 'NWC wallet service could not find the requested resource.',
        'TIMEOUT' => 'NWC wallet service request timed out.',
        'INVALID_REQUEST' => 'OpenReceive sent an invalid NWC wallet request.',
        'WALLET_UNAVAILABLE' => 'NWC wallet service is unavailable.',
        'INVOICE_EXPIRED' => 'NWC wallet reported that the invoice is expired.',
        'UNSUPPORTED_METHOD' => 'NWC wallet service does not support the requested method.',
        'CONFLICT' => 'NWC wallet service reported a conflicting request.',
    ];

    /** @return array{code: string, message: string, retryable: bool, request_id?: string, details?: array<string, mixed>} */
    public static function normalizeWalletError(mixed $raw): array
    {
        $records = self::collectErrorRecords($raw);
        $code = self::errorCodeFromRecords($records)
            ?? (is_string($raw) ? self::normalizeErrorCode($raw) : null)
            ?? 'OTHER';
        $details = null;
        foreach ($records as $record) {
            if (isset($record['details']) && Records::isRecord($record['details'])) {
                $details = Records::asArray($record['details']);
                break;
            }
        }
        /** @var array{code: string, message: string, retryable: bool, request_id?: string, details?: array<string, mixed>} $result */
        $result = Records::compact([
            'code' => $code,
            'message' => self::errorMessageFrom($records, $raw, $code),
            'retryable' => self::firstBoolean($records, 'retryable') ?? in_array($code, self::RETRYABLE_ERROR_CODES, true),
            'request_id' => self::firstString($records, ['request_id', 'requestId']),
            'details' => $details,
        ]);
        return $result;
    }

    /**
     * Aliases first (mirrors JS): a wallet's own "FORBIDDEN" is a wallet
     * restriction (RESTRICTED), never the host application's FORBIDDEN.
     */
    public static function normalizeErrorCode(mixed $value): ?string
    {
        if (!is_string($value) || trim($value) === '') {
            return null;
        }
        $normalized = trim($value);
        $normalized = preg_replace('/([a-z0-9])([A-Z])/', '$1_$2', $normalized) ?? $normalized;
        $normalized = preg_replace('/[^a-zA-Z0-9]+/', '_', $normalized) ?? $normalized;
        $normalized = strtoupper(trim($normalized, '_'));
        if (isset(self::ERROR_CODE_ALIASES[$normalized])) {
            return self::ERROR_CODE_ALIASES[$normalized];
        }
        return in_array($normalized, self::ERROR_CODES, true) ? $normalized : null;
    }

    /** @param list<array<string, mixed>> $records */
    private static function errorCodeFromRecords(array $records): ?string
    {
        foreach ($records as $record) {
            $direct = null;
            foreach (['code', 'error_code', 'errorCode', 'type'] as $key) {
                $direct = self::normalizeErrorCode($record[$key] ?? null);
                if ($direct !== null) {
                    break;
                }
            }
            if ($direct !== null && $direct !== 'OTHER') {
                return $direct;
            }
            $name = self::normalizeErrorCode($record['name'] ?? null);
            if ($name !== null && $name !== 'OTHER') {
                return $name;
            }
            if ($direct !== null) {
                return $direct;
            }
        }
        return null;
    }

    /** @param list<array<string, mixed>> $records */
    private static function errorMessageFrom(array $records, mixed $raw, string $code): string
    {
        $message = self::firstString($records, ['message', 'description', 'reason']);
        if ($message !== null && self::normalizeErrorCode($message) !== $code) {
            return $message;
        }
        if (is_string($raw) && self::normalizeErrorCode($raw) === null && trim($raw) !== '') {
            return trim($raw);
        }
        return self::ERROR_MESSAGES[$code] ?? self::ERROR_MESSAGES['OTHER'];
    }

    /**
     * Every record a failure carries, outermost first: the throwable itself
     * (short class name as `name`, its message, a string `code` property when
     * it has one) and its previous chain, or the array plus its nested
     * `error` / `cause` / `data` records.
     *
     * @param list<mixed> $seen
     * @return list<array<string, mixed>>
     */
    private static function collectErrorRecords(mixed $value, array &$seen = []): array
    {
        if ($value === null || (is_object($value) && in_array($value, $seen, true))) {
            return [];
        }
        $records = [];
        if ($value instanceof \Throwable) {
            $seen[] = $value;
            $record = ['name' => (new \ReflectionClass($value))->getShortName(), 'message' => $value->getMessage()];
            if ($value instanceof CodedError) {
                $record['code'] = $value->errorCode();
            }
            $records[] = $record;
            if ($value->getPrevious() !== null) {
                $records = [...$records, ...self::collectErrorRecords($value->getPrevious(), $seen)];
            }
        } elseif (Records::isRecord($value)) {
            if (is_object($value)) {
                $seen[] = $value;
            }
            $record = Records::asArray($value);
            $records[] = $record;
            foreach (['error', 'cause', 'data'] as $key) {
                if (isset($record[$key])) {
                    $records = [...$records, ...self::collectErrorRecords($record[$key], $seen)];
                }
            }
        }
        return $records;
    }

    /** @param list<array<string, mixed>> $records @param list<string> $keys */
    private static function firstString(array $records, array $keys): ?string
    {
        foreach ($records as $record) {
            foreach ($keys as $key) {
                $value = $record[$key] ?? null;
                if (is_string($value) && $value !== '') {
                    return $value;
                }
            }
        }
        return null;
    }

    /** @param list<array<string, mixed>> $records */
    private static function firstBoolean(array $records, string $key): ?bool
    {
        foreach ($records as $record) {
            $value = $record[$key] ?? null;
            if (is_bool($value)) {
                return $value;
            }
        }
        return null;
    }
}
