/**
 * Address validation for swap deposit/refund networks. Shared by the Node
 * settlement engine and the browser refund UI so one rule set decides where a
 * refund may be sent.
 *
 * These are checksum checks, not shape guards: a refund address is typed or
 * pasted by a payer and a false accept sends money nowhere recoverable.
 * - `TRX` — Base58Check: 25 bytes, `0x41` mainnet prefix, double-SHA-256 tail.
 * - `ETH` — EIP-55 capitalization verified whenever the address carries mixed
 *   case. An all-lowercase or all-uppercase address carries no checksum bits,
 *   so it is accepted on shape alone (as every Ethereum tool does).
 * - `SOL` — decodes to exactly a 32-byte ed25519 public key, so a truncated
 *   paste is rejected. Solana addresses carry no separate checksum.
 *
 * A network OpenReceive does not know is rejected outright; there is no
 * "long enough" fallback that would accept nearly any string.
 */

import { keccak256, sha256 } from "./hash.ts";

export type SwapAddressNetwork = "ETH" | "SOL" | "TRX";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const BASE58_MAP: Readonly<Record<string, number>> = Object.fromEntries(
  [...BASE58_ALPHABET].map((char, index) => [char, index]),
);

const ETH_ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;
const TRON_ADDRESS_SHAPE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const SOLANA_ADDRESS_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Tron mainnet address version byte; testnet/other prefixes are not payable here. */
const TRON_ADDRESS_PREFIX = 0x41;
const BASE58CHECK_CHECKSUM_BYTES = 4;
const MAX_SWAP_ADDRESS_LENGTH = 200;

/**
 * Bitcoin/Solana base58 decode. Returns `undefined` on invalid characters.
 * Leading `1` chars are treated as leading zero bytes.
 */
function decodeBase58(value: string): Uint8Array | undefined {
  if (value.length === 0) return undefined;
  // Start empty: seeding with [0] added a spurious zero byte for inputs whose
  // big-number value is zero (e.g. the all-'1' Solana System Program address,
  // which must decode to exactly 32 zero bytes).
  const bytes: number[] = [];
  for (const char of value) {
    const digit = BASE58_MAP[char];
    if (digit === undefined) return undefined;
    let carry = digit;
    for (let i = 0; i < bytes.length; i += 1) {
      carry += (bytes[i] as number) * 58;
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

/**
 * Resolve an accepted network spelling, or `undefined` for one we cannot check.
 * `TRON` is the only alias: it is the suffix OpenReceive's `pay_in_asset` codes
 * use (`USDT_TRON`) for the network the rest of the code calls `TRX`.
 */
function normalizeSwapAddressNetwork(network: string): SwapAddressNetwork | undefined {
  if (network === "ETH") return "ETH";
  if (network === "SOL") return "SOL";
  if (network === "TRX" || network === "TRON") return "TRX";
  return undefined;
}

function isValidTronAddress(address: string): boolean {
  if (!TRON_ADDRESS_SHAPE.test(address)) return false;
  const decoded = decodeBase58(address);
  if (decoded === undefined || decoded.length !== 21 + BASE58CHECK_CHECKSUM_BYTES) return false;
  if (decoded[0] !== TRON_ADDRESS_PREFIX) return false;
  const payload = decoded.subarray(0, 21);
  const checksum = decoded.subarray(21);
  const expected = sha256(sha256(payload));
  for (let i = 0; i < BASE58CHECK_CHECKSUM_BYTES; i += 1) {
    if (checksum[i] !== expected[i]) return false;
  }
  return true;
}

function isValidEthereumAddress(address: string): boolean {
  if (!ETH_ADDRESS_SHAPE.test(address)) return false;
  const body = address.slice(2);
  const lowercase = body.toLowerCase();
  // No mixed case means no EIP-55 bits to verify — accept on shape, like every
  // Ethereum wallet does for an all-lower or all-upper address.
  if (body === lowercase || body === body.toUpperCase()) return true;
  const digest = keccak256(new TextEncoder().encode(lowercase));
  for (let i = 0; i < lowercase.length; i += 1) {
    const character = lowercase[i] as string;
    if (character < "a" || character > "f") continue;
    // EIP-55: nibble i of keccak256(lowercase hex) >= 8 means uppercase.
    const nibble =
      i % 2 === 0 ? (digest[i >> 1] as number) >> 4 : (digest[i >> 1] as number) & 0x0f;
    const shouldBeUpper = nibble >= 8;
    if (shouldBeUpper !== (body[i] === character.toUpperCase())) return false;
  }
  return true;
}

function isValidSolanaAddress(address: string): boolean {
  // Typical encoded length is 32–44; still require a 32-byte pubkey decode, so
  // a truncated paste (or a 25-byte Base58Check address) cannot slip through.
  if (!SOLANA_ADDRESS_SHAPE.test(address)) return false;
  const decoded = decodeBase58(address);
  return decoded !== undefined && decoded.length === 32;
}

/**
 * True when `address` is a payable address on `network`, checksum included.
 * `network` is an {@link SwapAddressNetwork} or the `TRON` alias;
 * any other string is rejected rather than waved through on length, so callers
 * resolve the network first (see
 * {@link swapAddressNetworkForPayInAsset}).
 */
export function isValidAddressForSwapNetwork(network: string, address: string): boolean {
  if (address.length > MAX_SWAP_ADDRESS_LENGTH || /\s/.test(address)) return false;
  const normalized = normalizeSwapAddressNetwork(network);
  if (normalized === "ETH") return isValidEthereumAddress(address);
  if (normalized === "SOL") return isValidSolanaAddress(address);
  if (normalized === "TRX") return isValidTronAddress(address);
  return false;
}

/**
 * The chain-network suffix of an OpenReceive `pay_in_asset` code, uppercased:
 * `USDT_ETH` → `"ETH"`, `SOL_SOL` → `"SOL"`, `USDT_TRON` → `"TRON"`. A code
 * with no suffix answers itself (`"lightning"` → `"LIGHTNING"`).
 *
 * ONE owner for this split. Four places used to re-derive it with four inline
 * network tables — the address checksum rule, the explorer link, the network
 * label, and the confirmation-wait hint — so a new rail meant finding all four.
 * Callers layer their own vocabulary on the result: this returns the raw
 * suffix, not any one of their enums.
 */
export function payInAssetNetwork(payInAsset: string): string | undefined {
  if (payInAsset === "") return undefined;
  return payInAsset.split("_").at(-1)?.toUpperCase();
}

/**
 * Resolve the address network from an OpenReceive `pay_in_asset` code
 * (`USDT_ETH` → ETH, `USDT_TRON` → TRX, `SOL_SOL` → SOL).
 */
export function swapAddressNetworkForPayInAsset(
  payInAsset: string,
): SwapAddressNetwork | undefined {
  const suffix = payInAssetNetwork(payInAsset);
  return suffix === undefined ? undefined : normalizeSwapAddressNetwork(suffix);
}

/**
 * True when `address` is payable for the asset's network. For an asset whose
 * network OpenReceive does not know, no checksum rule exists to apply, so the
 * check degrades to a bounded non-empty string — deliberately, and only there.
 */
export function isValidSwapAddressForPayInAsset(payInAsset: string, address: string): boolean {
  const network = swapAddressNetworkForPayInAsset(payInAsset);
  if (network === undefined) {
    return address.length >= 5 && address.length <= MAX_SWAP_ADDRESS_LENGTH && !/\s/.test(address);
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
  const network = swapAddressNetworkForPayInAsset(payInAsset);
  if (network === "ETH") {
    if (ETH_ADDRESS_SHAPE.test(trimmed)) {
      return `That ${networkLabel} address failed its checksum. Copy it again from your wallet.`;
    }
    return `That doesn't look like an ${networkLabel} address. Use a 0x address.`;
  }
  if (network === "TRX") {
    if (TRON_ADDRESS_SHAPE.test(trimmed)) {
      return `That ${networkLabel} address failed its checksum. Copy it again from your wallet.`;
    }
    return `That doesn't look like a ${networkLabel} address. Use an address starting with T.`;
  }
  return `That doesn't look like a ${networkLabel} address. Check you pasted the full address.`;
}
