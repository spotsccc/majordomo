import { createHash, timingSafeEqual } from "node:crypto";
import { UnauthenticatedError } from "@repo/handler";
import { ConfigurationError, requiredEnv } from "./env";

/** Only the owner may call the API: `Authorization: Bearer $MAJORDOMO_API_TOKEN`. */
export function requireOwner(
  request: Request,
): ConfigurationError | UnauthenticatedError | undefined {
  const token = requiredEnv("MAJORDOMO_API_TOKEN");
  if (token instanceof Error) return token;
  if (token.length < 32) {
    return new ConfigurationError({
      message: "MAJORDOMO_API_TOKEN должен быть не короче 32 символов",
    });
  }
  if (!bearerMatches(request, token)) return new UnauthenticatedError();
}

/** Vercel Cron calls with `Authorization: Bearer $CRON_SECRET`. */
export function requireCron(
  request: Request,
): ConfigurationError | UnauthenticatedError | undefined {
  const secret = requiredEnv("CRON_SECRET");
  if (secret instanceof Error) return secret;
  if (!bearerMatches(request, secret)) return new UnauthenticatedError();
}

function bearerMatches(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  // Hash both sides: equal lengths for timingSafeEqual, no length leak.
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
