// Payment icon URLs, resolved against this module's own URL so the same code
// works from source, from the packaged dist, and from a host bundler's chunk.
import { lazyAssetUrlTable, warnOnFileAssetUrl } from "@openreceive/provider-data";
import type { PaymentMethod } from "./checkout-types.ts";

const OPENRECEIVE_PAYMENT_ICON_IDS = [
  "btc",
  "crypto",
  "eth",
  "lightning",
  "ltc",
  "sol",
  "trx",
  "usdc",
  "usdt",
  "xmr",
  "xrp",
] as const;
export type PaymentIconId = (typeof OPENRECEIVE_PAYMENT_ICON_IDS)[number];

/** Packaged location of the icon files inside `@openreceive/browser`. */
const PACKAGED_ICON_PREFIX = "assets/icons/";

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
 * Resolve a payment icon against this module's URL.
 *
 * - Source (`src/internal/`, where this module lives): `../assets/icons/`
 * - Packaged `dist/*.js`: `./assets/icons/`
 * - Host Vite/Rollup app chunks under `/assets/*.js`: `./icons/` (demos copy
 *   package icons next to the emitted JS so URLs are `/assets/icons/*.svg`)
 */
function paymentIconRoot(): string {
  if (moduleUrl.includes("/src/internal/")) return "../assets/icons/";
  try {
    const { pathname } = new URL(moduleUrl);
    if (/\/assets\/[^/]+\.js$/i.test(pathname)) return "./icons/";
  } catch {
    // ignore invalid module URLs and fall through
  }
  return "./assets/icons/";
}

function paymentIconUrl(file: string): string {
  const resolved = new URL(`${paymentIconRoot()}${file}`, moduleUrl).href;
  warnOnFileAssetUrl(`${PACKAGED_ICON_PREFIX}${file}`, resolved);
  return resolved;
}

/**
 * The packaged PATH of each icon, independent of how (or whether) this module
 * managed to resolve it to a URL. A host whose bundler leaves
 * `import.meta.url` alone serves these files itself and maps them by path —
 * see `AssetUrlResolver`.
 */
export const paymentIconPaths: Readonly<Record<PaymentIconId, string>> = Object.fromEntries(
  OPENRECEIVE_PAYMENT_ICON_IDS.map((id) => [id, `${PACKAGED_ICON_PREFIX}${id}.svg`]),
) as Readonly<Record<PaymentIconId, string>>;

// Lazy, like the two tables in @openreceive/provider-data: reading a packaged
// URL is what the file: warning is about, so importing this module must not
// count as reading one. See lazyAssetUrlTable.
export const paymentIconUrls: Readonly<Record<PaymentIconId, string>> = lazyAssetUrlTable(
  OPENRECEIVE_PAYMENT_ICON_IDS,
  (id) => paymentIconUrl(`${id}.svg`),
);

export const paymentMethodIconIds: Readonly<Record<PaymentMethod, PaymentIconId>> = {
  bitcoin: "btc",
} as const;

export const assetIconIds: Readonly<Record<string, PaymentIconId>> = {
  btc: "btc",
  eth: "eth",
  ltc: "ltc",
  sol: "sol",
  trx: "trx",
  usdc: "usdc",
  usdt: "usdt",
  xmr: "xmr",
  xrp: "xrp",
} as const;
