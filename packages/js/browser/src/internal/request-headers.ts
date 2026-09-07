/**
 * The headers every OpenReceive request carries: the JSON content type the
 * handler requires, the page's CSRF token when there is one, then whatever the
 * host passed (which wins on a clash).
 *
 * Rails (and frameworks sharing the convention) render the session's CSRF
 * token into `<meta name="csrf-token">`. Forwarding it lets a host's mount
 * inherit its framework's forgery protection with no extra wiring; on a page
 * without the meta tag nothing is added.
 *
 * The META TAG NAME is fixed — hosts render the token into it — but the header
 * NAME it is sent under is the framework's choice: Rails and Laravel read
 * `X-CSRF-Token` (the default), Django's CsrfViewMiddleware reads `X-CSRFToken`,
 * WordPress REST reads `X-WP-Nonce`. `csrfHeader` is that knob; every checkout
 * surface exposes it under the same name (`csrf-header` on the element).
 */
const DEFAULT_CSRF_HEADER = "X-CSRF-Token";

export function requestHeaders(
  host: Readonly<Record<string, string>> | undefined,
  csrfHeader: string = DEFAULT_CSRF_HEADER,
): Readonly<Record<string, string>> {
  return {
    "Content-Type": "application/json",
    ...csrfTokenHeader(csrfHeader),
    ...host,
  };
}

function csrfTokenHeader(csrfHeader: string): Readonly<Record<string, string>> {
  if (typeof document === "undefined") return {};
  const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute("content");
  return token ? { [csrfHeader]: token } : {};
}
