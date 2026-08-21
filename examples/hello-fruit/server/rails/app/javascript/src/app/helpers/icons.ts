/**
 * Payment icons as webpack asset-module imports. The package's own
 * openReceivePaymentIconUrls resolves `new URL(..., import.meta.url)` at
 * runtime, which lands outside the packs output — static imports let webpack
 * emit and fingerprint the SVGs instead (same pattern as an ls-style
 * static icon registry).
 */

import bankIcon from "@openreceive/browser/assets/icons/bank.svg";
import bnbIcon from "@openreceive/browser/assets/icons/bnb.svg";
import btcIcon from "@openreceive/browser/assets/icons/btc.svg";
import cardIcon from "@openreceive/browser/assets/icons/card.svg";
import cryptoIcon from "@openreceive/browser/assets/icons/crypto.svg";
import dogeIcon from "@openreceive/browser/assets/icons/doge.svg";
import ethIcon from "@openreceive/browser/assets/icons/eth.svg";
import lightningIcon from "@openreceive/browser/assets/icons/lightning.svg";
import ltcIcon from "@openreceive/browser/assets/icons/ltc.svg";
import solIcon from "@openreceive/browser/assets/icons/sol.svg";
import trxIcon from "@openreceive/browser/assets/icons/trx.svg";
import usdcIcon from "@openreceive/browser/assets/icons/usdc.svg";
import usdtIcon from "@openreceive/browser/assets/icons/usdt.svg";
import xmrIcon from "@openreceive/browser/assets/icons/xmr.svg";
import xrpIcon from "@openreceive/browser/assets/icons/xrp.svg";
import type { OpenReceivePaymentMethod } from "@openreceive/browser/headless";

const iconUrls: Readonly<Record<string, string>> = {
  bank: bankIcon,
  bnb: bnbIcon,
  btc: btcIcon,
  card: cardIcon,
  crypto: cryptoIcon,
  doge: dogeIcon,
  eth: ethIcon,
  lightning: lightningIcon,
  ltc: ltcIcon,
  sol: solIcon,
  trx: trxIcon,
  usdc: usdcIcon,
  usdt: usdtIcon,
  xmr: xmrIcon,
  xrp: xrpIcon,
};

/** Icon for a payment-method tile (Bitcoin / Crypto). */
export function methodIcon(method: OpenReceivePaymentMethod): string {
  return method === "bitcoin" ? btcIcon : cryptoIcon;
}

/** Token/coin mark for a swap pay-in option card (USDT, USDC, SOL, …). */
export function assetIcon(symbol: string): string {
  return iconUrls[symbol.trim().toLowerCase()] ?? cryptoIcon;
}

/** Icon for a swap network label (Tron → trx, Solana → sol, Ethereum → eth). */
export function networkIcon(networkLabel: string): string {
  const key = networkLabel.trim().toLowerCase();
  if (key === "tron" || key === "trx") return trxIcon;
  if (key === "solana" || key === "sol") return solIcon;
  if (key === "ethereum" || key === "eth") return ethIcon;
  return cryptoIcon;
}

/** Bitcoin route icon: the Lightning bolt for lightning routes, coin marks otherwise. */
export function routeIcon(asset: { readonly route?: string; readonly symbol: string }): string {
  const routeId = asset.route ?? asset.symbol;
  if (asset.symbol === "btc" && routeId.includes("lightning")) return lightningIcon;
  return assetIcon(asset.symbol);
}

declare const __webpack_public_path__: string;

/**
 * Rewrite a provider-data runtime asset URL (provider icon / tutorial image)
 * onto the copies webpack emits next to the chunk (see CopyPlugin in
 * config/webpack/webpack.config.js). The packages resolve these against
 * `import.meta.url`, which webpack inlines as a build-machine file:// URL;
 * only the basename is trustworthy.
 */
export function packagedRuntimeAssetUrl(
  url: string,
  kind: "provider-icons" | "pay_tutorials",
): string {
  const name = url.split(/[/\\]/).pop() ?? url;
  return `${__webpack_public_path__}js/assets/${kind}/${name}`;
}
