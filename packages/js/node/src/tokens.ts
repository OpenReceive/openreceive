import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { TokenKey } from "./service/types.ts";

export type StatelessTokenPurpose = "cap" | "swap" | "confirm";

export interface StatelessTokenPayload {
  readonly version: 1;
  readonly purpose: StatelessTokenPurpose;
  readonly issuedAt: number;
  readonly expiresAt?: number;
}

export interface StatelessTokenManager {
  seal(purpose: StatelessTokenPurpose, payload: object): string;
  open<T extends object>(purpose: StatelessTokenPurpose, token: string): T & StatelessTokenPayload;
}

export interface StatelessTokenManagerOptions {
  readonly keys: readonly TokenKey[];
  readonly clock?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
}

export class InvalidOpenReceiveTokenError extends Error {
  constructor(message = "Invalid or expired OpenReceive token.") {
    super(message);
    this.name = "InvalidOpenReceiveTokenError";
  }
}

/**
 * Portable encrypt-then-MAC token keyring. Independent AES-256-CBC and
 * HMAC-SHA256 keys are derived from each 256-bit master key. The first key
 * seals new tokens; every key can open existing tokens, which makes rotation
 * safe for in-flight checkouts and swaps.
 */
export function createStatelessTokenManager(
  options: StatelessTokenManagerOptions,
): StatelessTokenManager {
  if (options.keys.length === 0) {
    throw new TypeError("OpenReceive requires at least one token key.");
  }
  const keys = new Map<string, Buffer>();
  for (const entry of options.keys) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(entry.id)) {
      throw new TypeError("OpenReceive token key id must be 1-32 URL-safe characters.");
    }
    if (keys.has(entry.id)) throw new TypeError(`Duplicate OpenReceive token key id: ${entry.id}`);
    keys.set(entry.id, decodeKey(entry.key));
  }
  const current = options.keys[0];
  const clock = options.clock ?? currentUnixSeconds;
  const random = options.randomBytes ?? randomBytes;

  return {
    seal(purpose, payload) {
      const iv = random(16);
      const masterKey = keys.get(current.id) as Buffer;
      const { encryptionKey, authenticationKey } = deriveKeys(masterKey);
      const prefix = tokenPrefix(purpose);
      const cipher = createCipheriv("aes-256-cbc", encryptionKey, iv);
      const plaintext = Buffer.from(
        JSON.stringify({ ...payload, version: 1, purpose, issuedAt: clock() }),
        "utf8",
      );
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = authenticate(authenticationKey, prefix, current.id, iv, encrypted);
      return [prefix, current.id, iv.toString("base64url"), encrypted.toString("base64url"), tag.toString("base64url")].join(".");
    },
    open<T extends object>(purpose: StatelessTokenPurpose, token: string): T & StatelessTokenPayload {
      try {
        const [prefix, keyId, ivText, encryptedText, tagText, extra] = token.split(".");
        if (extra !== undefined || prefix !== tokenPrefix(purpose)) throw new Error("prefix");
        const masterKey = keys.get(keyId);
        if (masterKey === undefined) throw new Error("key");
        const iv = Buffer.from(ivText, "base64url");
        const encrypted = Buffer.from(encryptedText, "base64url");
        const tag = Buffer.from(tagText, "base64url");
        if (iv.length !== 16 || tag.length !== 32) throw new Error("shape");
        const { encryptionKey, authenticationKey } = deriveKeys(masterKey);
        const expectedTag = authenticate(authenticationKey, prefix, keyId, iv, encrypted);
        if (!timingSafeEqual(tag, expectedTag)) throw new Error("authentication");
        const decipher = createDecipheriv("aes-256-cbc", encryptionKey, iv);
        const plaintext = Buffer.concat([
          decipher.update(encrypted),
          decipher.final(),
        ]).toString("utf8");
        const payload = JSON.parse(plaintext) as T & StatelessTokenPayload;
        if (
          payload.version !== 1 ||
          payload.purpose !== purpose ||
          !Number.isSafeInteger(payload.issuedAt)
        ) throw new Error("shape");
        if (payload.expiresAt !== undefined && payload.expiresAt <= clock()) throw new Error("expired");
        return payload;
      } catch (error) {
        if (error instanceof InvalidOpenReceiveTokenError) throw error;
        throw new InvalidOpenReceiveTokenError();
      }
    },
  };
}

function deriveKeys(masterKey: Buffer): {
  readonly encryptionKey: Buffer;
  readonly authenticationKey: Buffer;
} {
  return {
    encryptionKey: createHmac("sha256", masterKey)
      .update("openreceive:token:encryption:v1")
      .digest(),
    authenticationKey: createHmac("sha256", masterKey)
      .update("openreceive:token:authentication:v1")
      .digest(),
  };
}

function authenticate(
  key: Buffer,
  prefix: string,
  keyId: string,
  iv: Buffer,
  encrypted: Buffer,
): Buffer {
  return createHmac("sha256", key)
    .update(`${prefix}.${keyId}.`, "utf8")
    .update(iv)
    .update(encrypted)
    .digest();
}

/** Parse `kid:key,kid:key` keyrings. The first entry is the current sealing key. */
export function parseTokenKeyring(value: string): readonly TokenKey[] {
  const keys = value.split(",").map((part) => {
    const separator = part.indexOf(":");
    if (separator <= 0) throw new TypeError("Token keys must use kid:key entries.");
    return { id: part.slice(0, separator), key: part.slice(separator + 1) };
  });
  if (keys.length === 0) throw new TypeError("OpenReceive token keyring is empty.");
  return keys;
}

function tokenPrefix(purpose: StatelessTokenPurpose): string {
  return `or_${purpose}_v1`;
}

function decodeKey(value: string): Buffer {
  let decoded: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    decoded = Buffer.from(value, "hex");
  } else {
    decoded = Buffer.from(value, value.includes("+") || value.includes("/") || value.endsWith("=") ? "base64" : "base64url");
  }
  if (decoded.length !== 32) throw new TypeError("OpenReceive token keys must decode to 32 bytes.");
  return decoded;
}

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
