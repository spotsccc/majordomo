import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signIn } from "@/lib/chatgpt.test-utils";
import { config } from "@/lib/config";
import {
  FakeTelegram,
  resetChats,
  stubNetwork,
} from "@/lib/telegram/telegram.test-utils";
import { GET } from "./route";

const SECRET = config.CRON_SECRET;

function get(authorization?: string): Promise<Response> {
  return GET(
    new Request("https://example.test/api/cron/memory", {
      headers: authorization ? { authorization } : {},
    }) as NextRequest,
    { params: Promise.resolve({}) },
  );
}

beforeEach(async () => {
  await resetChats();
  await signIn();
});

describe("GET /api/cron/memory", () => {
  it("answers 401 to calls without the cron secret and does not run the pass", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    for (const authorization of [undefined, "Bearer wrong", SECRET]) {
      const response = await get(authorization);
      expect(response.status).toBe(401);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("answers 200 with the counters of the pass", async () => {
    stubNetwork(new FakeTelegram(), (url) => {
      throw new Error(`Неожиданный запрос ${url}`);
    });

    const response = await get(`Bearer ${SECRET}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      conversations: expect.any(Number),
      expired: expect.any(Number),
      merged: expect.any(Number),
      moved: expect.any(Number),
      refused: expect.any(Object),
      failed: expect.any(Number),
      reported: expect.any(Number),
      unfinished: expect.any(Boolean),
      warnings: expect.any(Array),
    });
  });
});
