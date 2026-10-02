import { createHash, timingSafeEqual } from "node:crypto";
import { UnauthenticatedError } from "@repo/handler";
import { ConfigurationError, requiredEnv } from "./env";

/** Only the owner may call the API: `Authorization: Bearer $MAJORDOMO_API_TOKEN`. */
export function requireOwner(request: Request): void {
  const token = requiredEnv("MAJORDOMO_API_TOKEN");
  if (token.length < 32) {
    throw new ConfigurationError(
      "MAJORDOMO_API_TOKEN должен быть не короче 32 символов",
    );
  }
  if (!bearerMatches(request, token)) throw new UnauthenticatedError();
}

/** Vercel Cron calls with `Authorization: Bearer $CRON_SECRET`. */
export function requireCron(request: Request): void {
  if (!bearerMatches(request, requiredEnv("CRON_SECRET"))) {
    throw new UnauthenticatedError();
  }
}

function bearerMatches(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  // Hash both sides: equal lengths for timingSafeEqual, no length leak.
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
