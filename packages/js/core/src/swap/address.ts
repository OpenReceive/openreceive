/**
 * Address shape checks for swap deposit/refund networks. Shared by the Node
 * settlement engine and browser refund UI so rules live in one place.
 *
 * Solana checks decode to a 32-byte ed25519 public key (not just charset/length),
 * so truncated pastes like a missing suffix are rejected. Ethereum/Tron remain
 * format guards (not full checksum validation).
 */

export type OpenReceiveSwapAddressNetwork = "ETH" | "SOL" | "TRX";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const BASE58_MAP: Readonly<Record<string, number>> = Object.fromEntries(
  [...BASE58_ALPHABET].map((char, index) => [char, index]),
);

/**
 * Bitcoin/Solana base58 decode. Returns `undefined` on invalid characters.
 * Leading `1` chars are treated as leading zero bytes.
 */
export function decodeBase58(value: string): Uint8Array | undefined {
  if (value.length === 0) return undefined;
  const bytes: number[] = [0];
  for (const char of value) {
    const digit = BASE58_MAP[char];
    if (digit === undefined) return undefined;
    let carry = digit;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of value) {
    if (char !== "1") break;
    bytes.push(0);
  }
  bytes.reverse();
  return Uint8Array.from(bytes);
}

function isValidSolanaAddress(address: string): boolean {
  // Typical encoded length is 32–44; still require a 32-byte pubkey decode.
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false;
  // Tron addresses are also base58; reject the common 34-char T… mainnet shape.
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false;
  const decoded = decodeBase58(address);
  return decoded !== undefined && decoded.length === 32;
}

export function isValidAddressForSwapNetwork(
  network: string,
  address: string,
): boolean {
  if (address.length > 200 || /\s/.test(address)) return false;
  if (network === "ETH") return /^0x[0-9a-fA-F]{40}$/.test(address);
  if (network === "SOL") return isValidSolanaAddress(address);
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
  return `That doesn't look like a ${networkLabel} address. Check you pasted the full address.`;
}
