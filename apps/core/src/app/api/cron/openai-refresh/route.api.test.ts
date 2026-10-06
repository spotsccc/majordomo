import type { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { signOut } from "@/lib/chatgpt.test-utils";
import { config } from "@/lib/config";
import { GET } from "./route";

const SECRET = config.CRON_SECRET;

function get(authorization?: string): Promise<Response> {
  return GET(
    new Request("https://example.test/api/cron/openai-refresh", {
      headers: authorization ? { authorization } : {},
    }) as NextRequest,
    { params: Promise.resolve({}) },
  );
}

describe("GET /api/cron/openai-refresh", () => {
  it("answers 401 to calls without the cron secret", async () => {
    for (const authorization of [undefined, "Bearer wrong", SECRET]) {
      const response = await get(authorization);
      expect(response.status).toBe(401);
    }
  });

  it("answers 200 with the refresh check", async () => {
    await signOut();

    const response = await get(`Bearer ${SECRET}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "logged_out" });
  });
});
