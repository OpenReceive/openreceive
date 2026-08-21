// A 32-byte value encoded as 64 hexadecimal characters (payment hash,
// description hash, wallet pubkey). Shared so the check lives in one place.
export const HEX_64 = /^[0-9a-fA-F]{64}$/;
