import { createHandler, UnauthenticatedError } from "@repo/handler";
import type { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { requireCron, requireOwner } from "../src/lib/auth";
import { config } from "../src/lib/config";

const TOKEN = config.MAJORDOMO_API_TOKEN;
const CRON_SECRET = config.CRON_SECRET;

function request(authorization?: string): NextRequest {
  return new Request("https://example.test/api", {
    headers: authorization ? { authorization } : {},
  }) as NextRequest;
}

describe("requireOwner", () => {
  it("lets the owner in and rejects everyone else", () => {
    expect(requireOwner(request(`Bearer ${TOKEN}`))).toBeUndefined();
    expect(requireOwner(request())).toBeInstanceOf(UnauthenticatedError);
    expect(requireOwner(request(`Bearer ${TOKEN}x`))).toBeInstanceOf(
      UnauthenticatedError,
    );
    expect(requireOwner(request(TOKEN))).toBeInstanceOf(UnauthenticatedError);
  });

  it("keeps the cron secret and the owner token apart", () => {
    expect(requireCron(request(`Bearer ${CRON_SECRET}`))).toBeUndefined();
    expect(requireCron(request(`Bearer ${TOKEN}`))).toBeInstanceOf(
      UnauthenticatedError,
    );
    expect(requireOwner(request(`Bearer ${CRON_SECRET}`))).toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it("answers 401 through the handler", async () => {
    const response = await createHandler({}, async ({ request }) => {
      const denied = requireOwner(request);
      if (denied instanceof Error) throw denied;
      return Response.json({ ok: true });
    })(request("Bearer wrong"), { params: Promise.resolve({}) });
    expect(response.status).toBe(401);
  });
});
