// The plugin's decisions that need neither Vendure nor a database, so tests
// can hold them to their contract directly.

/**
 * An amount Vendure stores, an integer in units of 10^-precision (2 unless
 * the shop's MoneyStrategy says otherwise, whatever the currency), as the
 * decimal string OpenReceive prices with, in the currency's own minor units.
 * Vendure keeps a yen price with two places too, so 100050 at precision 2 is
 * 1000.50 JPY and prices as 1001: half up, on the digits, never a float.
 */
export function decimalAmount(stored: number, precision: number, currency: string): string | null {
  if (!Number.isSafeInteger(stored) || stored <= 0) return null;
  if (!Number.isInteger(precision) || precision < 0 || precision > 12) return null;
  const digits = currencyDigits(currency);
  const text = String(stored).padStart(precision + 1, "0");
  const whole = text.slice(0, text.length - precision);
  const fraction = text.slice(text.length - precision);
  const scaled = BigInt(whole + fraction.padEnd(digits, "0").slice(0, digits));
  const roundUp = fraction.length > digits && Number(fraction[digits]) >= 5;
  const minor = scaled + (roundUp ? 1n : 0n);
  if (minor <= 0n) return null;
  if (digits === 0) return minor.toString();
  const out = minor.toString().padStart(digits + 1, "0");
  return `${out.slice(0, -digits)}.${out.slice(-digits)}`;
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
 * An order a buyer can still start paying: Vendure's checkout states before
 * an order is placed. Every other state means it is paid, placed or gone.
 */
export function isOpenOrderState(state: unknown): boolean {
  return state === "AddingItems" || state === "ArrangingPayment";
}

/**
 * What is still due on an order: its total with tax, less what payments in
 * the given states already cover, net of their settled refunds, as Vendure's
 * own totalCoveredByPayments counts them.
 */
export function amountDue(order: {
  readonly totalWithTax: number;
  readonly payments?: readonly {
    readonly state: string;
    readonly amount: number;
    readonly refunds?: readonly { readonly state: string; readonly total: number }[];
  }[];
}): number {
  let covered = 0;
  for (const payment of order.payments ?? []) {
    if (payment.state !== "Authorized" && payment.state !== "Settled") continue;
    const refunded = (payment.refunds ?? [])
      .filter((refund) => refund.state === "Settled")
      .reduce((sum, refund) => sum + refund.total, 0);
    covered += payment.amount - refunded;
  }
  return order.totalWithTax - covered;
}

/**
 * The exact origins in Vendure's `apiOptions.cors.origin`. A checkout on one
 * of them may call the routes from the browser on another site. A pattern,
 * `true` (any origin, Vendure's dev setting) or a function is skipped,
 * because OpenReceive accepts a cross-site request only from an exact origin.
 */
export function exactOrigins(cors: unknown): string[] {
  const origin =
    cors !== null && typeof cors === "object" ? (cors as { origin?: unknown }).origin : undefined;
  const entries =
    typeof origin === "string" ? origin.split(",") : Array.isArray(origin) ? origin : [];
  const origins = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const candidate = entry.trim();
    if (!/^https?:\/\/[^/\s*]+$/i.test(candidate)) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.origin === candidate.toLowerCase()) origins.add(parsed.origin);
    } catch {
      // Not a URL: Vendure matches it as it sees fit.
    }
  }
  return [...origins];
}

/**
 * The SQL dialect OpenReceive speaks to the database Vendure runs on, or
 * undefined for SQLite and sql.js: TypeORM shares their single connection
 * between Vendure and the plugin, which cannot serialize OpenReceive's
 * settlement transactions against Vendure's own.
 */
export function sqlDialect(type: unknown): "postgres" | "mysql" | undefined {
  if (type === "postgres") return "postgres";
  if (type === "mysql" || type === "mariadb") return "mysql";
  return undefined;
}

/** The settled attempt among a reference's payment attempts, if any. */
export function settledAttempt<
  T extends {
    readonly status: string;
    readonly paymentHash: string;
    readonly paidAt: number | null;
  },
>(records: readonly T[]): T | undefined {
  return records.find((record) => record.status === "settled");
}
