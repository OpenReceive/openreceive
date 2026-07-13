import { OpenReceiveHttpError } from "./errors.ts";

/** A route matched under the mount prefix: its kind plus any decoded path parameters. */
export type MatchedRoute =
  | { readonly kind: "checkout.prepare" }
  | { readonly kind: "checkout.create" }
  | { readonly kind: "checkout.read"; readonly checkoutId: string }
  | { readonly kind: "order.action"; readonly orderId: string }
  | { readonly kind: "order.summary"; readonly orderId: string }
  | { readonly kind: "swap.options"; readonly orderId: string }
  | { readonly kind: "rates" }
  | { readonly kind: "invoice.sweep" };

/** Strip a trailing slash so `/openreceive/` and `/openreceive` behave identically. */
export function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim();
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.length > 1 && withLeadingSlash.endsWith("/")
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash;
}

/**
 * Resolve a request to a mounted route, or throw 404 when nothing under the prefix matches (including
 * a known path reached with the wrong method). Returns null when the path is outside the prefix
 * entirely, which the caller also treats as a 404.
 */
export function matchRoute(prefix: string, method: string, pathname: string): MatchedRoute | null {
  let path: string;
  if (pathname === prefix) {
    path = "/";
  } else if (pathname.startsWith(`${prefix}/`)) {
    path = pathname.slice(prefix.length);
  } else {
    return null;
  }

  const upperMethod = method.toUpperCase();
  const segments = path.split("/").filter((segment) => segment.length > 0);

  if (segments[0] === "prepare" && segments.length === 1 && upperMethod === "POST") {
    return { kind: "checkout.prepare" };
  }

  if (segments[0] === "checkouts") {
    if (segments.length === 1 && upperMethod === "POST") {
      return { kind: "checkout.create" };
    }
    if (segments.length === 2 && upperMethod === "GET") {
      return { kind: "checkout.read", checkoutId: decodeURIComponent(segments[1]) };
    }
    throw notFound();
  }

  if (segments[0] === "orders") {
    if (segments.length === 2 && upperMethod === "POST") {
      return { kind: "order.action", orderId: decodeURIComponent(segments[1]) };
    }
    if (segments.length === 3 && segments[2] === "summary" && upperMethod === "GET") {
      return { kind: "order.summary", orderId: decodeURIComponent(segments[1]) };
    }
    if (segments.length === 3 && segments[2] === "swap-options" && upperMethod === "GET") {
      return { kind: "swap.options", orderId: decodeURIComponent(segments[1]) };
    }
    throw notFound();
  }

  if (segments[0] === "rates" && segments.length === 1 && upperMethod === "GET") {
    return { kind: "rates" };
  }

  if (
    segments[0] === "admin" &&
    segments[1] === "sweep" &&
    segments.length === 2 &&
    upperMethod === "POST"
  ) {
    return { kind: "invoice.sweep" };
  }

  throw notFound();
}

function notFound(): OpenReceiveHttpError {
  return new OpenReceiveHttpError(
    404,
    "NOT_FOUND",
    "No OpenReceive route matched this method and path.",
  );
}
