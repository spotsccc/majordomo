import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";

/** No Next.js imports here: the e2e fixture loads this module outside Next. */
export const SESSION_COOKIE = "majordomo_session";

/** Lax, not Strict: with Strict a link from Telegram would open the login page. */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: 400 * 24 * 60 * 60,
} as const;

/**
 * Derived from the owner token, so nothing is stored and changing `MAJORDOMO_API_TOKEN` signs
 * out every browser.
 */
export function sessionValue(): string {
  return createHmac("sha256", config.MAJORDOMO_API_TOKEN)
    .update("majordomo session v1")
    .digest("base64url");
}

export function isOwnerToken(token: string): boolean {
  return sameSecret(token, config.MAJORDOMO_API_TOKEN);
}

export function isOwnerSession(value: string | undefined): boolean {
  return value !== undefined && sameSecret(value, sessionValue());
}

/** Compares hashes of both sides: equal lengths for `timingSafeEqual`, no length leak. */
export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
