import { ForbiddenError, UnauthenticatedError } from "@repo/handler";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { config } from "./config";
import { isOwnerSession, SESSION_COOKIE, sameSecret } from "./owner-session";

/**
 * A cookie rides along with requests from other sites, so a write with it must come from the
 * owner's own origin; a bearer token is not sent by the browser on its own and needs no such
 * check.
 */
export function requireOwner(
  request: Request,
): UnauthenticatedError | ForbiddenError | undefined {
  if (bearerMatches(request, config.MAJORDOMO_API_TOKEN)) return undefined;
  if (!isOwnerSession(cookieOf(request, SESSION_COOKIE))) {
    return new UnauthenticatedError();
  }
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  if (!sameOrigin(request)) return new ForbiddenError();
}

/** `redirect` throws by Next's contract, so it must never run inside a `catch` or `tryFn`. */
export async function requireOwnerSession(): Promise<void> {
  if (!(await hasOwnerSession())) redirect("/login");
}

export async function hasOwnerSession(): Promise<boolean> {
  return isOwnerSession((await cookies()).get(SESSION_COOKIE)?.value);
}

export function requireCron(
  request: Request,
): UnauthenticatedError | undefined {
  if (!bearerMatches(request, config.CRON_SECRET)) {
    return new UnauthenticatedError();
  }
}

function bearerMatches(request: Request, secret: string): boolean {
  return sameSecret(
    request.headers.get("authorization") ?? "",
    `Bearer ${secret}`,
  );
}

function cookieOf(request: Request, name: string): string | undefined {
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = pair.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  const host =
    request.headers.get("x-forwarded-host") ?? new URL(request.url).host;
  return URL.canParse(origin) && new URL(origin).host === host;
}
