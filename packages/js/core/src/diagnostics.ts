import type { ErrorBody } from "./errors/index.ts";

export function sanitizeLogValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(sanitizeLogValue);
  if (typeof value !== "object" || value === null) return value;

  const clean: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isSensitiveLogKey(key)) {
      clean[key] = "[REDACTED]";
    } else {
      clean[key] = sanitizeLogValue(nested);
    }
  }
  return clean;
}

/**
 * Field names whose VALUE never belongs in a log line, whatever it holds:
 * wallet and provider credentials, the settlement preimage (proof of payment),
 * the raw invoice (`bolt11` payloads carried inside provider errors), and the
 * server-only swap recovery blob (`swap_data` holds the provider order token).
 */
export function isSensitiveLogKey(key: string): boolean {
  // `*_present` fields are deliberate presence flags (`preimage_present`) — the
  // safe thing to log instead of the value.
  if (/_present$/i.test(key)) return false;
  return /secret|token|authorization|cookie|nwc|dsn|preimage|invoice|bolt11|swap_?data|(?:private|api)[_-]?key|^key$|api[_-]?sign/i.test(
    key,
  );
}

export function redactSecrets(value: string): string {
  return (
    value
      // Scheme only, no slashes: parseNwcUri accepts both
      // "nostr+walletconnect://pubkey?..." and the slashless
      // "nostr+walletconnect:pubkey?...", and the secret rides in the query
      // either way.
      .replace(/nostr\+walletconnect:[^\s"'`<>]+/gi, "[REDACTED_NWC]")
      // Lightning Swap Connect credential URI: host, key, and secret in one string.
      .replace(/lightning\+swapconnect:[^\s"'`<>]+/gi, "[REDACTED_LSC]")
      // `key=` is half an LSC credential pair on its own, so it is redacted
      // wherever it appears in a query string, not only inside a full URI.
      .replace(
        /([?&](?:_or_evt|token|provider_token|secret|key|api_key|api-sign|api_sign)=)[^&\s"'`<>]+/gi,
        "$1[REDACTED]",
      )
  );
}

/** A public error has only the canonical fields, never raw causes, stacks or configuration. */
export function publicErrorBody(body: ErrorBody): ErrorBody {
  return {
    code: body.code,
    message: redactSecrets(body.message),
    ...(body.retryable === undefined ? {} : { retryable: body.retryable }),
    ...(body.request_id === undefined ? {} : { request_id: redactSecrets(body.request_id) }),
    ...(body.details === undefined ? {} : { details: publicErrorDetails(body.details) }),
  };
}
function publicErrorDetails(details: Record<string, unknown>): Record<string, unknown> {
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clean);
    if (value === null || typeof value !== "object") return sanitizeLogValue(value);
    if (value instanceof Error) return undefined;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/^(cause|stack|config|configuration)$/i.test(key))
        .map(([key, nested]) => [key, isSensitiveLogKey(key) ? "[REDACTED]" : clean(nested)]),
    );
  };
  return clean(details) as Record<string, unknown>;
}
