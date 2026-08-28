/**
 * Who this browser is: a SIGNED cookie holding a shop_users.id, and nothing
 * else. No email, no password, no account.
 *
 * Written by hand rather than pulled from `cookie-parser`, because "signed"
 * is the whole point of the file and it is worth being able to read what it
 * means: a payload, an HMAC of that payload under the app secret, and a
 * constant-time comparison on the way back in. A value someone typed by hand —
 * a raw uuid copied out of the public feed, say — fails the signature and reads
 * as absent, which is exactly why the feed can publish `public_ref` and the
 * cookie can carry `id`.
 *
 * The contract matches Rails' `cookies.signed` byte for byte in everything the
 * docs describe — name, lifetime, flags, rolling renewal — so identity can be
 * documented once for all four stacks.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SHOP_COOKIE = "shop_user_id";

/** One year, rewritten on every shop request, which is what makes it ROLLING. */
export const SHOP_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

const base64url = (buffer: Buffer): string => buffer.toString("base64url");

const sign = (value: string, secret: string): string =>
  base64url(createHmac("sha256", secret).update(value).digest());

/** `value.signature`. Both halves are base64url, so neither can contain a dot. */
export const signCookieValue = (value: string, secret: string): string =>
  `${base64url(Buffer.from(value, "utf8"))}.${sign(value, secret)}`;

/**
 * The signed value back, or undefined for anything that does not verify:
 * a tampered payload, a hand-written plain uuid, a cookie signed by another
 * app's secret. Every one of those lands in the same branch as "no cookie at
 * all", which is what keeps a bad value from being a 500.
 */
export const readSignedCookieValue = (
  signed: string | undefined,
  secret: string,
): string | undefined => {
  if (signed === undefined) return undefined;
  const dot = signed.lastIndexOf(".");
  if (dot <= 0) return undefined;

  const value = Buffer.from(signed.slice(0, dot), "base64url").toString("utf8");
  const presented = Buffer.from(signed.slice(dot + 1), "utf8");
  const expected = Buffer.from(sign(value, secret), "utf8");
  // Length differs on almost every forgery, and timingSafeEqual throws rather
  // than returning false when it does.
  if (presented.length !== expected.length) return undefined;
  return timingSafeEqual(presented, expected) ? value : undefined;
};

/** A Cookie header into a map. Values are percent-decoded; malformed pairs are skipped. */
export const parseCookieHeader = (header: string | undefined): Record<string, string> => {
  const jar: Record<string, string> = {};
  if (header === undefined) return jar;

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (name.length === 0 || name in jar) continue;
    try {
      jar[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // A value that is not valid percent-encoding is not one we wrote.
    }
  }
  return jar;
};

/**
 * The Set-Cookie line.
 *
 * `secure` follows THE REQUEST, not the environment — the same correction the
 * Rails host carries. A cookie marked secure is dropped by the browser on
 * plain HTTP, so keying it to "production" means the production-mode Docker
 * demo, served over http://localhost, mints a fresh visitor on every request
 * and every checkout 403s in `authorize`.
 */
export const serializeIdentityCookie = (input: {
  readonly value: string;
  readonly secret: string;
  readonly secure: boolean;
}): string =>
  [
    `${SHOP_COOKIE}=${encodeURIComponent(signCookieValue(input.value, input.secret))}`,
    `Max-Age=${SHOP_COOKIE_MAX_AGE_SECONDS}`,
    `Expires=${new Date(Date.now() + SHOP_COOKIE_MAX_AGE_SECONDS * 1_000).toUTCString()}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(input.secure ? ["Secure"] : []),
  ].join("; ");

/**
 * The app secret.
 *
 * `SHOP_COOKIE_SECRET` wins. Failing that, one is generated on first boot and
 * kept in the data directory beside the database — because the acceptance
 * demo is "close the browser, reopen it, the download still works", and a
 * secret regenerated per process would log every visitor out on every restart
 * and quietly turn the persistence demo into a session demo. This is the same
 * job Rails' tmp/local_secret.txt does in development.
 */
export const resolveCookieSecret = (dataDir: string, demoId: string): string => {
  const fromEnv = process.env.SHOP_COOKIE_SECRET;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;

  mkdirSync(dataDir, { recursive: true });
  const secretPath = path.join(dataDir, `${demoId}.secret`);
  if (existsSync(secretPath)) return readFileSync(secretPath, "utf8").trim();

  const secret = randomBytes(32).toString("hex");
  writeFileSync(secretPath, `${secret}\n`, { mode: 0o600 });
  return secret;
};
