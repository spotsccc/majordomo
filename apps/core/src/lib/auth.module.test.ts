import { ForbiddenError, UnauthenticatedError } from "@repo/handler";
import type { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { requireCron, requireOwner } from "./auth";
import { config } from "./config";
import { isOwnerToken, SESSION_COOKIE, sessionValue } from "./owner-session";

const TOKEN = config.MAJORDOMO_API_TOKEN;
const CRON_SECRET = config.CRON_SECRET;

function request({
  method = "GET",
  authorization,
  session,
  origin,
  forwardedHost,
}: {
  method?: string;
  authorization?: string;
  session?: string;
  origin?: string;
  forwardedHost?: string;
} = {}): NextRequest {
  const headers = new Headers();
  if (authorization) headers.set("authorization", authorization);
  if (session !== undefined) {
    headers.set("cookie", `theme=dark; ${SESSION_COOKIE}=${session}`);
  }
  if (origin) headers.set("origin", origin);
  if (forwardedHost) headers.set("x-forwarded-host", forwardedHost);
  return new Request("https://example.test/api", {
    method,
    headers,
  }) as NextRequest;
}

describe("requireOwner", () => {
  it("lets the owner in with the bearer token and rejects everyone else", () => {
    expect(
      requireOwner(request({ authorization: `Bearer ${TOKEN}` })),
    ).toBeUndefined();
    expect(requireOwner(request())).toBeInstanceOf(UnauthenticatedError);
    expect(
      requireOwner(request({ authorization: `Bearer ${TOKEN}x` })),
    ).toBeInstanceOf(UnauthenticatedError);
    expect(requireOwner(request({ authorization: TOKEN }))).toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it("lets the owner in with the session cookie and rejects a wrong one (E11)", () => {
    expect(requireOwner(request({ session: sessionValue() }))).toBeUndefined();
    expect(
      requireOwner(request({ session: `${sessionValue()}x` })),
    ).toBeInstanceOf(UnauthenticatedError);
    expect(requireOwner(request({ session: TOKEN }))).toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it("rejects the cookie of a previous owner token (E11)", async () => {
    const previous = sessionValue();
    vi.stubEnv("MAJORDOMO_API_TOKEN", "rotated-owner-token-0123456789abcdef");
    vi.resetModules();
    const { requireOwner: withNewToken } = await import("./auth");
    const { sessionValue: newSession } = await import("./owner-session");

    expect(withNewToken(request({ session: previous }))?.status).toBe(401);
    expect(withNewToken(request({ session: newSession() }))).toBeUndefined();
  });

  it("takes a write with the cookie only from the owner's own origin (E12)", () => {
    const write = (origin?: string, forwardedHost?: string) =>
      requireOwner(
        request({
          method: "POST",
          session: sessionValue(),
          origin,
          forwardedHost,
        }),
      );

    expect(write("https://example.test")).toBeUndefined();
    expect(write("https://majordomo.app", "majordomo.app")).toBeUndefined();
    expect(write("https://evil.test")).toBeInstanceOf(ForbiddenError);
    expect(write()).toBeInstanceOf(ForbiddenError);
    expect(write("null")).toBeInstanceOf(ForbiddenError);
    expect(write("not a url")).toBeInstanceOf(ForbiddenError);
  });

  it("does not check the origin of a write with the bearer token", () => {
    expect(
      requireOwner(
        request({
          method: "POST",
          authorization: `Bearer ${TOKEN}`,
          origin: "https://evil.test",
        }),
      ),
    ).toBeUndefined();
  });

  it("keeps the cron secret and the owner token apart", () => {
    expect(
      requireCron(request({ authorization: `Bearer ${CRON_SECRET}` })),
    ).toBeUndefined();
    expect(
      requireCron(request({ authorization: `Bearer ${TOKEN}` })),
    ).toBeInstanceOf(UnauthenticatedError);
    expect(
      requireOwner(request({ authorization: `Bearer ${CRON_SECRET}` })),
    ).toBeInstanceOf(UnauthenticatedError);
  });
});

describe("isOwnerToken", () => {
  it("accepts only the owner token itself", () => {
    expect(isOwnerToken(TOKEN)).toBe(true);
    expect(isOwnerToken(`${TOKEN} `)).toBe(false);
    expect(isOwnerToken("")).toBe(false);
  });
});
