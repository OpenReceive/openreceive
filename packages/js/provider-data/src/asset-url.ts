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
export function resolveOpenReceiveAssetPath(path: string, fromModuleUrl: string): string {
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
  return new URL(resolveOpenReceiveAssetPath(path, moduleUrl), moduleUrl).href;
}
