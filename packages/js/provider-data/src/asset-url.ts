declare const __filename: string | undefined;

const moduleUrl =
  typeof import.meta.url === "string" && import.meta.url.length > 0
    ? import.meta.url
    : fileUrlFromPath(__filename as string);

const HOST_ASSETS_JS = /\/assets\/[^/]+\.js$/i;
const PACKAGED_ASSET_PREFIX = "./assets/";

function fileUrlFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${encodeURI(absolute).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
}

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
 * to a bundled package asset URL, working under both ESM (`import.meta.url`)
 * and CJS (`__filename`) module resolution.
 */
export function assetUrl(path: string): string {
  return new URL(resolveOpenReceiveAssetPath(path, moduleUrl), moduleUrl).href;
}
