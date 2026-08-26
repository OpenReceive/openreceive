const moduleUrl = import.meta.url;

const HOST_ASSETS_JS = /\/assets\/[^/]+\.js$/i;
const PACKAGED_ASSET_PREFIX = "./assets/";

/**
 * Rewrite a packaged `./assets/…` path when this module is inlined into a host
 * Vite/Rollup chunk served as `/assets/*.js`. Otherwise `new URL("./assets/…",
 * import.meta.url)` becomes `/assets/assets/…`. Demos copy provider-data assets
 * next to that chunk so `/assets/provider-icons/…` and `/assets/pay_tutorials/…`
 * resolve.
 */
export function resolveAssetPath(path: string, fromModuleUrl: string): string {
  if (!path.startsWith(PACKAGED_ASSET_PREFIX)) return path;
  try {
    const { pathname } = new URL(fromModuleUrl);
    if (HOST_ASSETS_JS.test(pathname)) {
      return `./${path.slice(PACKAGED_ASSET_PREFIX.length)}`;
    }
  } catch {
    // ignore invalid module URLs and fall through
  }
  return path;
}

/**
 * Resolve a repo-local asset path (e.g. `./assets/provider-icons/strike.png`)
 * to a bundled package asset URL relative to this ESM module's
 * `import.meta.url`.
 */
export function assetUrl(path: string): string {
  const resolved = new URL(resolveAssetPath(path, moduleUrl), moduleUrl).href;
  warnOnFileAssetUrl(path, resolved);
  return resolved;
}

/**
 * A host-supplied rewrite of a packaged asset path
 * (`assets/provider-icons/strike.png`) into a URL the browser can load.
 *
 * The packaged resolution below only works for a Vite/Rollup chunk served from
 * `/assets/*.js`. Every other bundler needs one of these, because the files
 * themselves have to be copied or served by the host either way.
 */
export type AssetUrlResolver = (packagedPath: string) => string;

/**
 * Turn "wherever I serve the packages' `dist/assets` trees" into an
 * {@link AssetUrlResolver}.
 *
 * Every packaged key is a relative path under one `assets/` root
 * (`assets/icons/…`, `assets/provider-icons/…`, `assets/pay_tutorials/…`), so
 * the merged layout this implies is exactly what the demos' copy plugin already
 * produces — a plain join is the whole rule. A string can cross an HTML
 * attribute, which a function cannot, so this is the seam the custom element
 * and the Vue/Svelte/Angular wrappers reach.
 *
 * The base is used verbatim apart from its trailing slashes, so it can be a
 * path (`/assets`, `/`) or an absolute origin (`https://cdn.example.com/or`).
 */
export function createAssetBaseUrlResolver(baseUrl: string): AssetUrlResolver {
  // Trim to the empty string on a bare "/" so the join below contributes
  // exactly one separator and `/assets/icons/btc.svg` does not become
  // `//assets/icons/btc.svg`.
  const base = baseUrl.trim().replace(/\/+$/, "");
  return (packagedPath) => `${base}/${packagedPath.replace(/^\/+/, "")}`;
}

let warnedFileAssetUrl = false;

/**
 * Shout once when a packaged asset resolved to `file:`.
 *
 * Under webpack (and anything else that replaces `import.meta.url` at build
 * time with the module's own on-disk URL) every entry in the packaged icon and
 * tutorial maps comes out as `file:///…/node_modules/@openreceive/…`. That is
 * unloadable in a browser AND it publishes the server's directory layout, and
 * it fails silently: blank images, no request, no error. One warning naming the
 * path turns that into a five-minute fix.
 *
 * Node and SSR are not the failure — `import.meta.url` IS a file URL there, and
 * nothing is being painted — so the check only fires in a document.
 */
export function warnOnFileAssetUrl(packagedPath: string, resolved: string): void {
  if (warnedFileAssetUrl) return;
  if (!resolved.startsWith("file:")) return;
  if (globalThis.window === undefined || globalThis.document === undefined) return;
  warnedFileAssetUrl = true;
  globalThis.console?.warn(
    `[openreceive] Packaged asset "${packagedPath}" resolved to ${resolved}. This bundler did ` +
      "not rewrite import.meta.url, so provider icons, pay tutorials and payment icons cannot " +
      "load (and the path leaks the server's layout). Copy the packaged assets next to your " +
      "bundle — see the demos' copy-openreceive-payment-icons-plugin.ts — or serve them yourself " +
      "and point at them — asset-base-url on <openreceive-checkout> (or the assetBaseUrl " +
      "prop on any wrapper), or resolveAssetUrl for a custom mapping. " +
      "docs/guides/provider-registry.md has all three.",
  );
}
