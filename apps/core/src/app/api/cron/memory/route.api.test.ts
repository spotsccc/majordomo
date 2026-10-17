import { unwrap } from "@spotsccc/error-as-value";
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signIn } from "@/lib/chatgpt.test-utils";
import { config } from "@/lib/config";
import { saveEntry } from "@/lib/memory/memory-store";
import { ownerTurn } from "@/lib/memory/memory.test-utils";
import {
  FakeTelegram,
  OWNER_ID,
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

  it("answers 200 with the result of the pass", async () => {
    unwrap(
      await saveEntry(
        {
          kind: "plan",
          title: "Мадрид",
          text: "командировка",
          validUntil: new Date(Date.now() - 24 * 3_600_000),
        },
        await ownerTurn("Запомни: командировка в Мадрид"),
      ),
    );
    const telegram = new FakeTelegram();
    stubNetwork(telegram, (url) => {
      throw new Error(`Неожиданный запрос ${url}`);
    });

    const response = await get(`Bearer ${SECRET}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      conversations: 0,
      expired: 1,
      merged: 0,
      moved: 0,
      refused: {},
      failed: 0,
      reported: 1,
      unfinished: false,
      warnings: [],
    });
    expect(telegram.textsIn(OWNER_ID)).toHaveLength(1);
  });
});
