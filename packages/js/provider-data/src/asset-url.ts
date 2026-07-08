declare const __filename: string | undefined;

const moduleUrl =
  typeof import.meta.url === "string" && import.meta.url.length > 0
    ? import.meta.url
    : fileUrlFromPath(__filename as string);

function fileUrlFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${encodeURI(absolute).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
}

/**
 * Resolve a repo-local asset path (e.g. `./assets/provider-icons/strike.png`)
 * to a bundled package asset URL, working under both ESM (`import.meta.url`)
 * and CJS (`__filename`) module resolution.
 */
export function assetUrl(path: string): string {
  return new URL(path, moduleUrl).href;
}
