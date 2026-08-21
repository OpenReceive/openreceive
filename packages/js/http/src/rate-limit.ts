import { unixSeconds } from "@openreceive/core";
import type {
  OpenReceiveAuthorizeAction,
  OpenReceiveAuthorizeContext,
  OpenReceiveRateLimit,
} from "./authorize.ts";
import { OpenReceiveHttpError } from "./errors.ts";

// Built-in per-IP invoice rate limiting. OFF unless the host opts in via the handler's
// `rateLimiting` option: any per-IP cap is wrong for shared-IP deployments (point-of-sale
// terminals, kiosks, venues behind one NAT), so enabling it must be a deliberate choice.
//
// There is no separate counter table — and deliberately no in-memory fallback. Every
// minted invoice is already persisted as an `openreceive_payments` row carrying
// `client_ip`, so the limit is a COUNT over rows the host stores anyway. A repository
// that cannot count fails construction instead: a security control must not silently
// degrade to per-process counting that resets on restart and multiplies per instance
// behind a load balancer.

export interface OpenReceiveIpRateLimitConfig {
  /** Maximum invoice creations per IP per rolling hour. Default 60. */
  readonly limitPerHour?: number;
  /** Optional additional cap per rolling 24 hours. Unset = hourly cap only. */
  readonly limitPerDay?: number;
  /** Payer-facing message on the 429 response. */
  readonly message?: string;
  /**
   * Actions to throttle. Default: both invoice-minting actions. Only
   * `checkout.create` and `swap.create` are accepted — attempt-row counting counts
   * mints, so a throttle on any other action could never trigger. Police other
   * actions with a custom `rateLimitHook` instead.
   */
  readonly actions?: readonly OpenReceiveAuthorizeAction[];
  /**
   * Client IP extractor. The default reads `native.ip` (Express/Fastify request).
   * Returning undefined allows the request — the limiter fails open rather than
   * blocking payers the host cannot attribute, and warns once per limiter so an
   * adapter that never supplies an IP is visible.
   */
  readonly ip?: (context: OpenReceiveAuthorizeContext) => string | undefined;
  /**
   * Count invoice attempts for this IP at or after `sinceUnixSeconds`. The handler
   * wires this to the payment repository's `countAttemptsFromIp` automatically.
   * Required: without a counter, construction throws — there is no ephemeral
   * in-process fallback.
   */
  readonly countAttemptsFromIp?: (
    clientIp: string,
    sinceUnixSeconds: number,
  ) => number | Promise<number>;
  /** Clock in unix seconds; override in tests. */
  readonly now?: () => number;
}

export const OPENRECEIVE_DEFAULT_IP_RATE_LIMIT_PER_HOUR = 60;

const HOUR_SECONDS = 3_600;
const DAY_SECONDS = 86_400;
const MINT_ACTIONS: ReadonlySet<OpenReceiveAuthorizeAction> = new Set([
  "checkout.create",
  "swap.create",
]);
const DEFAULT_ACTIONS: readonly OpenReceiveAuthorizeAction[] = ["checkout.create", "swap.create"];
const DEFAULT_MESSAGE = "Too many payment attempts. Please try again later.";

/**
 * Build the per-IP invoice rate limit behind the handler's `rateLimiting` option.
 * Hosts composing their own policy can call this directly and pass the result as
 * `rateLimitHook`. Over-limit requests fail with `429 RATE_LIMITED` and a retryable,
 * payer-facing message; requests with no attributable IP are always allowed.
 * Fails closed at construction when no `countAttemptsFromIp` counter is supplied.
 */
export function createOpenReceiveIpRateLimit(
  config: OpenReceiveIpRateLimitConfig = {},
): OpenReceiveRateLimit {
  const limitPerHour = config.limitPerHour ?? OPENRECEIVE_DEFAULT_IP_RATE_LIMIT_PER_HOUR;
  const limitPerDay = config.limitPerDay;
  if (!Number.isSafeInteger(limitPerHour) || limitPerHour < 1) {
    throw new TypeError("rateLimiting limitPerHour must be an integer >= 1.");
  }
  if (limitPerDay !== undefined && (!Number.isSafeInteger(limitPerDay) || limitPerDay < 1)) {
    throw new TypeError("rateLimiting limitPerDay must be an integer >= 1.");
  }
  const actions = new Set(config.actions ?? DEFAULT_ACTIONS);
  for (const action of actions) {
    if (!MINT_ACTIONS.has(action)) {
      throw new TypeError(
        `rateLimiting actions only accept the invoice-minting actions ` +
          `(checkout.create, swap.create); got "${action}". Attempt-row counting counts ` +
          `mints, so a throttle on other actions could never trigger. Use a custom ` +
          `rateLimitHook to police other actions.`,
      );
    }
  }
  const count = config.countAttemptsFromIp;
  if (count === undefined) {
    throw new TypeError(
      "rateLimiting requires persistent counting. Implement countAttemptsFromIp on the " +
        "payment repository (the built-in SQL repository already does), pass " +
        "countAttemptsFromIp in the rateLimiting config, or disable rateLimiting and use " +
        "a custom rateLimitHook backed by your own store. There is deliberately no " +
        "in-memory fallback: per-process counts reset on restart and multiply per " +
        "instance behind a load balancer.",
    );
  }
  const message = config.message ?? DEFAULT_MESSAGE;
  const extractIp = config.ip ?? openReceiveClientIp;
  const now = config.now ?? unixSeconds;
  let warnedUnattributable = false;

  return async (context) => {
    if (!actions.has(context.action)) return true;
    const extracted = extractIp(context);
    const ip = extracted === undefined ? undefined : openReceiveClientIpBucket(extracted);
    if (ip === undefined || ip.length === 0) {
      // Fail open by design (shared-IP note above) — but say so once, loudly: an
      // adapter that never supplies an IP silently disables the whole control.
      if (!warnedUnattributable) {
        warnedUnattributable = true;
        console.warn(
          "[openreceive] rateLimiting allowed a request with no attributable client IP " +
            "(fail-open). If every request logs no IP, the adapter is not supplying one " +
            "and rate limiting is inactive — see the rate limiting guide.",
        );
      }
      return true;
    }
    const at = now();
    if ((await count(ip, at - HOUR_SECONDS)) >= limitPerHour) {
      throw tooManyAttempts(message);
    }
    if (limitPerDay !== undefined && (await count(ip, at - DAY_SECONDS)) >= limitPerDay) {
      throw tooManyAttempts(message);
    }
    return true;
  };
}

/**
 * The `rateLimiting` slice of the handler options an adapter passes on when the
 * host opted into a trusted forwarded IP header. Shared by @openreceive/express,
 * /fastify and /next so the three adapters cannot drift on a security control.
 *
 * `trustProxyIpHeader` is `true` for `x-forwarded-for`, or the name of another
 * header YOUR reverse proxy sets; the extracted first hop becomes the limiter's
 * `ip` unless the host supplied its own extractor.
 *
 * `requireIpSource` names the adapter for adapters whose native request carries
 * NO socket IP (Next: a web Request has none). Those must fail loud at
 * construction rather than build a limiter that can never attribute a request;
 * adapters that do have a socket-IP fallback (Express/Fastify `req.ip`) leave it
 * unset and simply keep the default limiter when no header is trusted.
 */
export function createProxyRateLimitingConfig(
  rateLimiting: boolean | OpenReceiveIpRateLimitConfig | undefined,
  trustProxyIpHeader: boolean | string | undefined,
  options: { readonly requireIpSource?: string } = {},
): { readonly rateLimiting?: boolean | OpenReceiveIpRateLimitConfig } {
  if (rateLimiting === undefined || rateLimiting === false) return {};
  const headerName =
    trustProxyIpHeader === true
      ? "x-forwarded-for"
      : typeof trustProxyIpHeader === "string"
        ? trustProxyIpHeader.toLowerCase()
        : undefined;
  const headerIp =
    headerName === undefined
      ? undefined
      : (context: OpenReceiveAuthorizeContext): string | undefined => {
          const value = context.request.headers.get(headerName);
          const first = value?.split(",")[0]?.trim();
          return first !== undefined && first.length > 0 ? first : undefined;
        };
  const { requireIpSource } = options;
  if (headerIp === undefined && requireIpSource === undefined) return {};
  const config = rateLimiting === true ? {} : rateLimiting;
  if (headerIp === undefined && config.ip === undefined && requireIpSource !== undefined) {
    // Fail loud at construction: without an IP source every request would be
    // unattributable and the security control would silently do nothing.
    throw new TypeError(
      `rateLimiting on the ${requireIpSource} adapter needs a client IP source: a web Request has no ` +
        "socket IP. Pass trustProxyIpHeader: true to read x-forwarded-for (only behind " +
        "your own reverse proxy), name another trusted header, or supply a custom " +
        "rateLimiting.ip extractor.",
    );
  }
  return { rateLimiting: { ...config, ip: config.ip ?? headerIp } };
}

/**
 * Client IP the adapter attributed to this request: `native.ip` (Express/Fastify).
 * Undefined when no adapter IP is available — callers must treat that as
 * "unattributable", never as an error.
 */
export function openReceiveClientIp(
  context: Pick<OpenReceiveAuthorizeContext, "native">,
): string | undefined {
  const native = context.native as { ip?: unknown } | null | undefined;
  const ip = native?.ip;
  return typeof ip === "string" && ip.length > 0 ? ip : undefined;
}

/**
 * Normalize an extracted IP into the bucket the limiter counts (and the
 * handler stores as `client_ip`):
 *
 * - IPv4-mapped IPv6 (`::ffff:a.b.c.d`) collapses to the plain IPv4, so the
 *   same client never gets two independent budgets.
 * - IPv6 buckets to its /64 (`2001:db8:1:2::/64`): privacy extensions rotate
 *   the low 64 bits freely, so per-address budgets would hand every IPv6
 *   payer an unlimited stream of fresh budgets (and grow the attempts table).
 * - IPv4 and already-bucketed values pass through unchanged (idempotent).
 * - Unparsable input passes through as-is — an odd value still gets SOME
 *   consistent bucket rather than disabling the limit.
 */
export function openReceiveClientIpBucket(ip: string): string {
  let value = ip.trim().toLowerCase();
  if (value.startsWith("::ffff:") && value.includes(".")) value = value.slice("::ffff:".length);
  if (!value.includes(":")) return value;
  if (value.endsWith("/64")) return value;
  const [address] = value.split("%");
  const hextets = expandIpv6(address ?? "");
  if (hextets === undefined) return value;
  return `${hextets.slice(0, 4).join(":")}::/64`;
}

function expandIpv6(value: string): readonly string[] | undefined {
  const parts = value.split("::");
  if (parts.length > 2 || value.length === 0) return undefined;
  const toHextets = (segment: string): readonly string[] | undefined => {
    if (segment === "") return [];
    const groups: string[] = [];
    for (const group of segment.split(":")) {
      if (/^[0-9a-f]{1,4}$/.test(group)) {
        groups.push(group.replace(/^0+(?=.)/, ""));
      } else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(group)) {
        // Embedded IPv4 tail expands to two hextets.
        const octets = group.split(".").map(Number);
        if (octets.some((octet) => octet > 255)) return undefined;
        groups.push(
          (((octets[0] as number) << 8) | (octets[1] as number)).toString(16),
          (((octets[2] as number) << 8) | (octets[3] as number)).toString(16),
        );
      } else {
        return undefined;
      }
    }
    return groups;
  };
  const head = toHextets(parts[0] ?? "");
  const tail = parts.length === 2 ? toHextets(parts[1] ?? "") : [];
  if (head === undefined || tail === undefined) return undefined;
  if (parts.length === 1) return head.length === 8 ? head : undefined;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return undefined;
  return [...head, ...Array.from({ length: missing }, () => "0"), ...tail];
}

function tooManyAttempts(message: string): OpenReceiveHttpError {
  // The precise wait depends on when the oldest counted row ages out of the
  // window; 60s is a conservative, honest floor for a rolling-hour budget.
  return new OpenReceiveHttpError(429, "RATE_LIMITED", message, {
    retryable: true,
    retryAfterSeconds: 60,
  });
}
