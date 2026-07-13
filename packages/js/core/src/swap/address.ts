/**
 * Coarse shape-check for swap deposit/refund addresses by network
 * (format guard, not full checksum validation). Shared by the Node
 * settlement engine and browser refund UI so address rules live in one place.
 */

export type OpenReceiveSwapAddressNetwork = "ETH" | "SOL" | "TRX";

export function isValidAddressForSwapNetwork(
  network: string,
  address: string,
): boolean {
  if (address.length > 200 || /\s/.test(address)) return false;
  if (network === "ETH") return /^0x[0-9a-fA-F]{40}$/.test(address);
  if (network === "SOL") {
    // Tron addresses are also base58 and often match a naive Solana length check.
    // Reject Tron-shaped values so refund UI can catch wrong-network pastes.
    if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false;
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  }
  if (network === "TRX" || network === "TRON") {
    return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
  }
  return address.length >= 5;
}

/**
 * Resolve the address network from an OpenReceive `pay_in_asset` code
 * (`USDT_ETH` → ETH, `USDT_TRON` → TRX, `SOL_SOL` → SOL).
 */
export function openReceiveSwapAddressNetworkForPayInAsset(
  payInAsset: string,
): OpenReceiveSwapAddressNetwork | undefined {
  const suffix = payInAsset.split("_").at(-1)?.toUpperCase();
  if (suffix === "ETH") return "ETH";
  if (suffix === "SOL") return "SOL";
  if (suffix === "TRON" || suffix === "TRX") return "TRX";
  return undefined;
}

export function isValidSwapAddressForPayInAsset(
  payInAsset: string,
  address: string,
): boolean {
  const network = openReceiveSwapAddressNetworkForPayInAsset(payInAsset);
  if (network === undefined) {
    return address.length >= 5 && address.length <= 200 && !/\s/.test(address);
  }
  return isValidAddressForSwapNetwork(network, address);
}

/**
 * User-facing refund address error, or `undefined` when the address is empty
 * (callers should keep HTML `required` / empty-field handling) or valid.
 */
export function getSwapRefundAddressError(
  payInAsset: string,
  address: string,
  networkLabel: string,
): string | undefined {
  const trimmed = address.trim();
  if (trimmed.length === 0) return undefined;
  if (isValidSwapAddressForPayInAsset(payInAsset, trimmed)) return undefined;
  const network = openReceiveSwapAddressNetworkForPayInAsset(payInAsset);
  if (network === "ETH") {
    return `That doesn't look like an ${networkLabel} address. Use a 0x address.`;
  }
  if (network === "TRX") {
    return `That doesn't look like a ${networkLabel} address. Use an address starting with T.`;
  }
  return `That doesn't look like a ${networkLabel} address.`;
}
