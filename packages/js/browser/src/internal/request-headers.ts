/**
 * The headers every OpenReceive request carries: the JSON content type the
 * handler requires, the page's CSRF token when there is one, then whatever the
 * host passed (which wins on a clash).
 *
 * Rails (and frameworks sharing the convention) render the session's CSRF
 * token into `<meta name="csrf-token">`. Forwarding it as `X-CSRF-Token`
 * lets a host's mount inherit its framework's forgery protection with no
 * extra wiring; on a page without the meta tag nothing is added.
 */
export function requestHeaders(
  host: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  return {
    "Content-Type": "application/json",
    ...csrfTokenHeader(),
    ...host,
  };
}

function csrfTokenHeader(): Readonly<Record<string, string>> {
  if (typeof document === "undefined") return {};
  const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute("content");
  return token ? { "X-CSRF-Token": token } : {};
}
