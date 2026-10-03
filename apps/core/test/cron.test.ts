import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "../src/app/api/cron/openai-refresh/route";

const SECRET = "cron-secret-0123456789";

function request(authorization?: string): NextRequest {
  return new Request("https://example.test/api/cron/openai-refresh", {
    headers: authorization ? { authorization } : {},
  }) as NextRequest;
}

describe("GET /api/cron/openai-refresh", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("rejects calls without the cron secret", async () => {
    for (const authorization of [undefined, "Bearer wrong", SECRET]) {
      const response = await GET(request(authorization), {
        params: Promise.resolve({}),
      });
      expect(response.status).toBe(401);
    }
  });

  it("fails as a misconfiguration when the secret is not set", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(request(`Bearer ${SECRET}`), {
      params: Promise.resolve({}),
    });
    expect(response.status).toBe(500);
  });
});
