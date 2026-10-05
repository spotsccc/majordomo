import { createHash, timingSafeEqual } from "node:crypto";
import { UnauthenticatedError } from "@repo/handler";
import { config } from "./config";

/** Only the owner may call the API: `Authorization: Bearer $MAJORDOMO_API_TOKEN`. */
export function requireOwner(
  request: Request,
): UnauthenticatedError | undefined {
  if (!bearerMatches(request, config.MAJORDOMO_API_TOKEN)) {
    return new UnauthenticatedError();
  }
}

/** Vercel Cron calls with `Authorization: Bearer $CRON_SECRET`. */
export function requireCron(
  request: Request,
): UnauthenticatedError | undefined {
  if (!bearerMatches(request, config.CRON_SECRET)) {
    return new UnauthenticatedError();
  }
}

/** Compares hashes of both sides: equal lengths for `timingSafeEqual`, no length leak. */
function bearerMatches(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
