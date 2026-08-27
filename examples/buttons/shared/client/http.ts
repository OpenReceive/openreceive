/**
 * One fetch for everything the shop and the OpenReceive engine send.
 *
 * The Rails host inherits `protect_from_forgery`, so every body-bearing
 * request needs the `X-CSRF-Token` the layout's `csrf_meta_tags` rendered —
 * including the engine's own routes, which are mounted inside that app. The
 * browser packages take a `fetch` rather than a header map on some calls, so
 * wrapping fetch once covers the checkout routes, the swap routes and this
 * app's /shop routes with one rule.
 *
 * On a host with no CSRF meta tag (the Node stacks) there is no token to find,
 * the header is simply not set, and this degrades to `window.fetch` with
 * same-origin credentials — which is what those stacks want anyway. That is
 * why this file, not a Rails-specific one, is what the stores import.
 */

export const csrfToken = (): string =>
  document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? "";

export const csrfFetch: typeof globalThis.fetch = (input, init) => {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return window.fetch(input, init);

  const headers = new Headers(init?.headers);
  if (!headers.has("X-CSRF-Token")) {
    const token = csrfToken();
    if (token) headers.set("X-CSRF-Token", token);
  }

  return window.fetch(input, { ...init, headers, credentials: "same-origin" });
};

/**
 * The server's `{ error: "…" }` is preferred over a bare status code, because
 * "Your cart is empty." is a sentence a payer can act on and "Request failed
 * (422)" is not.
 */
export const postJson = async <T>(path: string, body: unknown): Promise<T> => {
  const response = await csrfFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
  return payload as T;
};

/**
 * `fresh: true` REVALIDATES; it does not skip the cache.
 *
 * The recent-orders feed answers `Cache-Control: public, max-age=10`, which is
 * right for a poll and wrong for a push: a broadcast that lands inside those
 * ten seconds would re-read the browser's cached copy and the row that caused
 * the push would not appear. So the ONE caller that knows the data changed —
 * a settlement push, or a person pressing Refresh — asks for a revalidation,
 * and everybody else keeps the cached read.
 *
 * `no-cache` (not `no-store`, not `reload`) is the exact behaviour wanted: the
 * request still carries the cache's validators, so an unchanged feed can come
 * back as a 304 and a shared cache in front of the app still does its job.
 */
export const getJson = async <T>(path: string, { fresh = false } = {}): Promise<T> => {
  const response = await window.fetch(path, {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
    ...(fresh ? { cache: "no-cache" as RequestCache } : {}),
  });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return (await response.json()) as T;
};
