/**
 * Payment icons as webpack asset-module imports, and the three lookups the
 * method grid needs over them.
 *
 * This is the demo's copy of the packaged getOpenReceivePaymentMethodIcon /
 * getOpenReceiveAssetIcon / getOpenReceiveNetworkIcon, and unlike the other
 * duplications in this port it is PERMANENT: the packaged versions read
 * openReceivePaymentIconUrls, which resolves `new URL(..., import.meta.url)`,
 * and webpack freezes that into a build-machine file:// path that 404s in the
 * browser. Static imports let webpack emit and fingerprint the SVGs instead.
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
