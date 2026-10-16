// The plugin's decisions that need neither Medusa nor a database, so tests
// can hold them to their contract directly.

/**
 * A session can still be paid: the buyer has not paid it and Medusa has not
 * closed it. Medusa's other statuses are authorized, captured, canceled and
 * pending_authorization.
 */
export function isPayableStatus(status: unknown): boolean {
  return status === "pending" || status === "requires_more" || status === "error";
}

/**
 * The session's amount as the decimal string OpenReceive prices with, in the
 * currency's own minor units. Medusa keeps amounts as decimals with more
 * places than a currency has (a tax line can leave 10.333), so this rounds
 * half up on the decimal string, never through a float. Prefers
 * `raw_amount.value`, Medusa's exact form, over the numeric `amount`.
 */
export function decimalAmount(
  session: { readonly amount?: unknown; readonly raw_amount?: unknown },
  currency: string,
): string | null {
  const raw = session.raw_amount;
  const exact =
    raw !== null && typeof raw === "object" && "value" in raw
      ? String((raw as { value: unknown }).value)
      : typeof session.amount === "number" || typeof session.amount === "string"
        ? String(session.amount)
        : "";
  const match = /^(\d+)(?:\.(\d+))?$/.exec(exact.trim());
  if (match === null) return null;
  const digits = currencyDigits(currency);
  const whole = match[1] as string;
  const fraction = match[2] ?? "";
  const scaled = BigInt(whole + fraction.padEnd(digits, "0").slice(0, digits));
  const roundUp = fraction.length > digits && Number(fraction[digits]) >= 5;
  const minor = scaled + (roundUp ? 1n : 0n);
  if (minor <= 0n) return null;
  if (digits === 0) return minor.toString();
  const text = minor.toString().padStart(digits + 1, "0");
  return `${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

/** Minor-unit digits for an ISO currency code (2 for USD, 0 for JPY, 3 for KWD). */
export function currencyDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en", {
        style: "currency",
        currency: currency.toUpperCase(),
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/**
 * The exact origins in Medusa's `storeCors` setting (`http.storeCors`,
 * comma-separated). A checkout on one of them may call the routes from
 * another site. Medusa also accepts patterns there; those are skipped,
 * because OpenReceive accepts a cross-site request only from an exact origin.
 */
export function exactOrigins(storeCors: unknown): string[] {
  if (typeof storeCors !== "string") return [];
  const origins = new Set<string>();
  for (const entry of storeCors.split(",")) {
    const candidate = entry.trim();
    if (!/^https?:\/\/[^/\s*]+$/i.test(candidate)) continue;
    try {
      const { origin } = new URL(candidate);
      if (origin === candidate.toLowerCase().replace(/\/$/, "")) origins.add(origin);
    } catch {
      // Not a URL: a pattern Medusa matches on its own.
    }
  }
  return [...origins];
}

/**
 * The Medusa payment session a provider call is about. Medusa puts the
 * session's id into the data it hands `initiatePayment`, which the plugin
 * keeps in the session's data, and passes it again as the idempotency key.
 */
export function sessionIdOf(
  data: Readonly<Record<string, unknown>> | undefined,
  context?: { readonly idempotency_key?: unknown },
): string | undefined {
  const fromData = data?.session_id;
  if (typeof fromData === "string" && fromData.length > 0) return fromData;
  const fromContext = context?.idempotency_key;
  return typeof fromContext === "string" && fromContext.length > 0 ? fromContext : undefined;
}

/**
 * An amount Medusa hands a provider, for a log line: a number, a string, or
 * one of its BigNumber objects, which serializes to its numeric value.
 */
export function formatAmount(amount: unknown): string {
  if (typeof amount === "number" || typeof amount === "string") return String(amount);
  if (amount !== null && typeof amount === "object") {
    const numeric = (amount as { numeric?: unknown }).numeric;
    if (typeof numeric === "number" || typeof numeric === "string") return String(numeric);
    try {
      const json = JSON.parse(JSON.stringify(amount)) as unknown;
      if (typeof json === "number" || typeof json === "string") return String(json);
    } catch {
      // Not serializable: the fallback below.
    }
  }
  return "an amount";
}

/** The settled attempt among a session's payment attempts, if any. */
export function settledAttempt<
  T extends {
    readonly status: string;
    readonly paymentHash: string;
    readonly paidAt: number | null;
  },
>(records: readonly T[]): T | undefined {
  return records.find((record) => record.status === "settled");
}
