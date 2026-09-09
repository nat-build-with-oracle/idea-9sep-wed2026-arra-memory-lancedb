import { kvDelete, kvGet, kvPut } from "./kv";
import {
  base64UrlEncode,
  nowSeconds,
  randomToken,
  timingSafeEqual,
} from "./utils";

/**
 * The owner's browser session.
 *
 * A signed token, not a JWT — there is exactly one issuer and one audience, so
 * the algorithm-negotiation surface a JWT brings is cost with no benefit.
 *
 *   <issuedAtSeconds>.<sessionId>.<HMAC-SHA256 over the first two>
 *
 * The signature proves the token was minted here. The KV row proves it has not
 * been revoked since: signing alone cannot express "logged out", because a
 * validly-signed token stays validly signed forever. Logout deletes the row and
 * the next request fails even though the signature still verifies.
 */

const COOKIE_NAME = "arra_memory_session";
const MAX_AGE_SECONDS = 12 * 60 * 60; // 12 hours
const CLOCK_SKEW_SECONDS = 60;
const MESSAGE_PREFIX = "arra-memory-owner-session-v2";

const sessionKey = (id: string) => `owner-session:${id}`;

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function sign(secret: string, message: string): Promise<string> {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

/** Mints a session and records it as live. Returns the cookie value. */
export async function issueSession(secret: string): Promise<string> {
  const issuedAt = nowSeconds();
  const sessionId = randomToken(18);
  const signature = await sign(secret, `${MESSAGE_PREFIX}:${issuedAt}:${sessionId}`);

  await kvPut(sessionKey(sessionId), String(issuedAt), {
    // The KV row outlives the token by design: the row is what revocation
    // deletes, and it must not lapse before the token it governs.
    expirationTtl: MAX_AGE_SECONDS + CLOCK_SKEW_SECONDS,
  });

  return `${issuedAt}.${sessionId}.${signature}`;
}

/**
 * Verifies a cookie value. Every failure returns false — a caller must never be
 * able to tell a bad signature from an expired one from a revoked one.
 */
export async function verifySession(
  secret: string,
  token: string | null,
): Promise<boolean> {
  if (!token) return false;

  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [issuedAtRaw, sessionId, signature] = parts;

  const issuedAt = Number(issuedAtRaw);
  if (!Number.isInteger(issuedAt)) return false;

  // Age is checked before the HMAC so an ancient token costs no crypto.
  const age = nowSeconds() - issuedAt;
  if (age < -CLOCK_SKEW_SECONDS || age > MAX_AGE_SECONDS) return false;

  const expected = await sign(secret, `${MESSAGE_PREFIX}:${issuedAt}:${sessionId}`);
  if (!(await timingSafeEqual(signature, expected))) return false;

  // Signature is good, but only the KV row can say it has not been revoked.
  return (await kvGet(sessionKey(sessionId))) !== null;
}

/** Revokes one session. The token stays validly signed and stops working anyway. */
export async function revokeSession(token: string | null): Promise<void> {
  if (!token) return;
  const sessionId = token.split(".")[1];
  if (sessionId) await kvDelete(sessionKey(sessionId));
}

export function sessionCookie(value: string, secure: boolean): string {
  // SameSite=Lax rather than Strict: the OAuth approval flow returns here via a
  // top-level redirect, and Strict withholds the cookie on exactly that hop.
  // HttpOnly keeps it away from any script; Secure is dropped only for the
  // plain-http LAN/ingress case, where the connection never leaves the house.
  const flags = [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${MAX_AGE_SECONDS}`,
  ];
  if (secure) flags.push("Secure");
  return flags.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  const flags = [`${COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) flags.push("Secure");
  return flags.join("; ");
}

export { COOKIE_NAME as SESSION_COOKIE_NAME, MAX_AGE_SECONDS as SESSION_MAX_AGE_SECONDS };
