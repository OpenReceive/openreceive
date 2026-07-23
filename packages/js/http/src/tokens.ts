export interface CapabilityTokenKey {
  readonly id: string;
  readonly key: string;
}

export interface CapabilityTokenPayload {
  readonly version: 1;
  readonly orderId: string;
  readonly paymentHash: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface CapabilityTokenManager {
  mint(input: { readonly orderId: string; readonly paymentHash: string; readonly expiresAt: number }): Promise<string>;
  verify(token: string | null | undefined): Promise<CapabilityTokenPayload | null>;
}

export function createCapabilityTokenManager(input: {
  readonly keys: readonly CapabilityTokenKey[];
  readonly clock?: () => number;
}): CapabilityTokenManager {
  if (input.keys.length === 0) throw new TypeError("HTTP capability tokens require a keyring.");
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  const keys = new Map(input.keys.map((key) => [key.id, decodeKey(key.key)] as const));
  const current = input.keys[0];
  return {
    async mint(value) {
      const payload: CapabilityTokenPayload = {
        version: 1,
        orderId: value.orderId,
        paymentHash: value.paymentHash,
        issuedAt: clock(),
        expiresAt: value.expiresAt,
      };
      const encoded = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
      const signature = await sign(keys.get(current.id) as Uint8Array, `${current.id}.${encoded}`);
      return `or_cap_v1.${current.id}.${encoded}.${signature}`;
    },
    async verify(token) {
      if (typeof token !== "string") return null;
      try {
        const [prefix, keyId, encoded, signature, extra] = token.split(".");
        if (extra !== undefined || prefix !== "or_cap_v1") return null;
        const key = keys.get(keyId);
        if (key === undefined) return null;
        const expected = await sign(key, `${keyId}.${encoded}`);
        if (!constantTimeText(expected, signature)) return null;
        const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded))) as CapabilityTokenPayload;
        if (
          payload.version !== 1 ||
          typeof payload.orderId !== "string" ||
          !/^[0-9a-f]{64}$/.test(payload.paymentHash) ||
          !Number.isSafeInteger(payload.expiresAt) ||
          payload.expiresAt <= clock()
        ) return null;
        return payload;
      } catch {
        return null;
      }
    },
  };
}

async function sign(keyBytes: Uint8Array, text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return encodeBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text))));
}

function decodeKey(value: string): Uint8Array {
  const bytes = /^[0-9a-fA-F]{64}$/.test(value)
    ? Uint8Array.from(value.match(/../g) as string[], (byte) => Number.parseInt(byte, 16))
    : decodeBase64Url(value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  if (bytes.length !== 32) throw new TypeError("Capability token keys must decode to 32 bytes.");
  return bytes;
}

function constantTimeText(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
