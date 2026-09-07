/**
 * Django's CSRF token, made visible to the shared client.
 *
 * A template-rendered Django page writes `<meta name="csrf-token"
 * content="{{ csrf_token }}">` and is done. This SPA is served by Vite in
 * development and by WhiteNoise in the container — a static index.html with no
 * template pass — so it does what Django's own docs describe for AJAX: read
 * the `csrftoken` cookie the server set (`ensure_csrf_cookie` on
 * /shop/bootstrap) and send it back as the `X-CSRFToken` header.
 *
 * Both consumers read the meta tags rather than the cookie: the packaged
 * `<Checkout>` reads `csrf-token` (its `csrfHeader` prop names the header),
 * and shared/http.ts reads `csrf-token` plus the `csrf-header` name for the
 * shop's own POST. Django's header is `X-CSRFToken`; Rails' is `X-CSRF-Token`.
 */

export const DJANGO_CSRF_HEADER = "X-CSRFToken";

const readCookie = (name: string): string | undefined =>
  document.cookie
    .split(";")
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith(`${name}=`))
    ?.slice(name.length + 1);

const setMeta = (name: string, content: string): void => {
  let meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = name;
    document.head.appendChild(meta);
  }
  meta.content = content;
};

/** Call once the bootstrap response (and with it the cookie) has arrived. */
export const installDjangoCsrfMeta = (): void => {
  const token = readCookie("csrftoken");
  if (token) setMeta("csrf-token", decodeURIComponent(token));
  setMeta("csrf-header", DJANGO_CSRF_HEADER);
};
