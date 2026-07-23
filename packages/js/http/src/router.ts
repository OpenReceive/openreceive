import { OpenReceiveHttpError } from "./errors.ts";

export type MatchedRoute =
  | { readonly kind: "checkout.create" }
  | { readonly kind: "payment.check" }
  | { readonly kind: "swap.quote" }
  | { readonly kind: "swap.create" }
  | { readonly kind: "swap.read" }
  | { readonly kind: "swap.refund.confirm" }
  | { readonly kind: "swap.refund" }
  | { readonly kind: "rates" };

export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim();
  const value = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
}

export function matchRoute(prefix: string, method: string, pathname: string): MatchedRoute | null {
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return null;
  const path = pathname === prefix ? "/" : pathname.slice(prefix.length);
  const key = `${method.toUpperCase()} ${path.replace(/\/$/, "") || "/"}`;
  const routes: Record<string, MatchedRoute> = {
    "POST /checkouts": { kind: "checkout.create" },
    "POST /payments/check": { kind: "payment.check" },
    "POST /swaps/quote": { kind: "swap.quote" },
    "POST /swaps": { kind: "swap.create" },
    "POST /swaps/status": { kind: "swap.read" },
    "POST /swaps/refund-confirmations": { kind: "swap.refund.confirm" },
    "POST /swaps/refunds": { kind: "swap.refund" },
    "GET /rates": { kind: "rates" },
  };
  const route = routes[key];
  if (route === undefined) {
    throw new OpenReceiveHttpError(404, "NOT_FOUND", "No OpenReceive route matched this method and path.");
  }
  return route;
}
