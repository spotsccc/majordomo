import type { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { GET } from "../src/app/api/cron/openai-refresh/route";
import { config } from "../src/lib/config";

const SECRET = config.CRON_SECRET;

function request(authorization?: string): NextRequest {
  return new Request("https://example.test/api/cron/openai-refresh", {
    headers: authorization ? { authorization } : {},
  }) as NextRequest;
}

describe("GET /api/cron/openai-refresh", () => {
  it("rejects calls without the cron secret", async () => {
    for (const authorization of [undefined, "Bearer wrong", SECRET]) {
      const response = await GET(request(authorization), {
        params: Promise.resolve({}),
      });
      expect(response.status).toBe(401);
    }
  });
});
