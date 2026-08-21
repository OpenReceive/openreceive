import { OpenReceiveHttpError } from "./errors.ts";

export type MatchedRoute =
  | { readonly kind: "checkout.prepare" }
  | { readonly kind: "checkout.create" }
  | { readonly kind: "payment.check" }
  | { readonly kind: "swap.quote" }
  | { readonly kind: "swap.create" }
  | { readonly kind: "swap.read" }
  | { readonly kind: "swap.refund" }
  | { readonly kind: "rates" };

export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim();
  const value = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const withoutTrailing = value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
  // A bare "/" prefix means "mounted at the root": routes live at /checkouts
  // etc. (previously "/" could never match anything).
  return withoutTrailing === "/" ? "" : withoutTrailing;
}

// Built once, not per request.
const ROUTES: Readonly<Record<string, MatchedRoute>> = {
  "POST /checkouts/prepare": { kind: "checkout.prepare" },
  "POST /checkouts": { kind: "checkout.create" },
  "POST /payments/check": { kind: "payment.check" },
  "POST /swaps/quote": { kind: "swap.quote" },
  "POST /swaps": { kind: "swap.create" },
  "POST /swaps/status": { kind: "swap.read" },
  "POST /swaps/refunds": { kind: "swap.refund" },
  "GET /rates": { kind: "rates" },
};

const KNOWN_PATHS = new Set(Object.keys(ROUTES).map((key) => key.split(" ")[1] as string));

/** Path relative to the mount prefix, with any trailing slash removed. */
function routePath(prefix: string, pathname: string): string {
  const path = pathname === prefix ? "/" : pathname.slice(prefix.length);
  return path.replace(/\/$/, "") || "/";
}

/**
 * True when this pathname belongs to OpenReceive rather than the surrounding
 * app. A root mount (`prefix: "/"`, normalized to "") shares the URL space with
 * the host application, so it claims only the library's own paths — otherwise
 * every app route would get an OpenReceive JSON 404.
 */
export function openReceiveClaimsPath(prefix: string, pathname: string): boolean {
  if (prefix === "") return KNOWN_PATHS.has(routePath(prefix, pathname));
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Match a request to a route. Returns null when the path belongs to the
 * surrounding app (the caller composes with it); throws 404 for an unknown
 * path under the prefix and 405 for a known path with the wrong method.
 */
export function matchRoute(prefix: string, method: string, pathname: string): MatchedRoute | null {
  if (!openReceiveClaimsPath(prefix, pathname)) return null;
  const normalizedPath = routePath(prefix, pathname);
  const route = ROUTES[`${method.toUpperCase()} ${normalizedPath}`];
  if (route === undefined) {
    if (KNOWN_PATHS.has(normalizedPath)) {
      throw new OpenReceiveHttpError(
        405,
        "INVALID_REQUEST",
        "This OpenReceive route does not support that HTTP method.",
      );
    }
    throw new OpenReceiveHttpError(
      404,
      "NOT_FOUND",
      "No OpenReceive route matched this method and path.",
    );
  }
  return route;
}
