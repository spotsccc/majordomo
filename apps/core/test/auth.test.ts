import { createHandler, UnauthenticatedError } from "@repo/handler";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireCron, requireOwner } from "../src/lib/auth";

const TOKEN = "owner-token-0123456789abcdef0123456789";

function request(authorization?: string): NextRequest {
  return new Request("https://example.test/api", {
    headers: authorization ? { authorization } : {},
  }) as NextRequest;
}

describe("requireOwner", () => {
  beforeEach(() => {
    process.env.MAJORDOMO_API_TOKEN = TOKEN;
    process.env.CRON_SECRET = "cron-secret-0123456789";
  });
  afterEach(() => {
    delete process.env.MAJORDOMO_API_TOKEN;
    delete process.env.CRON_SECRET;
  });

  it("lets the owner in and rejects everyone else", () => {
    expect(requireOwner(request(`Bearer ${TOKEN}`))).toBeUndefined();
    expect(requireOwner(request())).toBeInstanceOf(UnauthenticatedError);
    expect(requireOwner(request(`Bearer ${TOKEN}x`))).toBeInstanceOf(
      UnauthenticatedError,
    );
    expect(requireOwner(request(TOKEN))).toBeInstanceOf(UnauthenticatedError);
  });

  it("keeps the cron secret and the owner token apart", () => {
    expect(
      requireCron(request("Bearer cron-secret-0123456789")),
    ).toBeUndefined();
    expect(requireCron(request(`Bearer ${TOKEN}`))).toBeInstanceOf(
      UnauthenticatedError,
    );
    expect(
      requireOwner(request("Bearer cron-secret-0123456789")),
    ).toBeInstanceOf(UnauthenticatedError);
  });

  it("answers 401 through the handler", async () => {
    const response = await createHandler({}, async ({ request }) => {
      const denied = requireOwner(request);
      if (denied instanceof Error) throw denied;
      return Response.json({ ok: true });
    })(request("Bearer wrong"), { params: Promise.resolve({}) });
    expect(response.status).toBe(401);
  });

  it("reports a missing or weak token as a misconfiguration", async () => {
    process.env.MAJORDOMO_API_TOKEN = "short";
    const response = await createHandler({}, async ({ request }) => {
      const denied = requireOwner(request);
      if (denied instanceof Error) throw denied;
      return Response.json({ ok: true });
    })(request(`Bearer short`), { params: Promise.resolve({}) });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "MAJORDOMO_API_TOKEN должен быть не короче 32 символов",
    });
  });
});
