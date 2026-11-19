import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// A guest shop: each buyer is a random id in a cookie, signed with the
// project's SESSION_SECRET so nobody can claim someone else's id.
const COOKIE = "widget_guest";
const YEAR_SECONDS = 365 * 24 * 60 * 60;

function sign(value) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("Set SESSION_SECRET in the project's environment variables.");
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function newGuest() {
  return randomUUID();
}

export function guestCookie(guest) {
  return `${COOKIE}=${guest}.${sign(guest)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${YEAR_SECONDS}`;
}

/** The guest id from a Cookie header, or undefined when it is missing or forged. */
export function guestFrom(cookieHeader) {
  const pair = (cookieHeader ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`));
  const [guest, signature] = (pair?.slice(COOKIE.length + 1) ?? "").split(".");
  if (!guest || !signature) return undefined;
  const expected = Buffer.from(sign(guest));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected) ? guest : undefined;
}
