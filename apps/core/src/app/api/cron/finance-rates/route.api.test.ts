import type { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { config } from "@/lib/config";
import { GET } from "./route";

const SECRET = config.CRON_SECRET;

function get(authorization?: string): Promise<Response> {
  return GET(
    new Request("https://example.test/api/cron/finance-rates", {
      headers: authorization ? { authorization } : {},
    }) as NextRequest,
    { params: Promise.resolve({}) },
  );
}

describe("GET /api/cron/finance-rates", () => {
  it("answers 401 to calls without the cron secret and does not call CoinGecko", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    for (const authorization of [undefined, "Bearer wrong", SECRET]) {
      const response = await get(authorization);
      expect(response.status).toBe(401);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("answers 200 with the updated currencies and the ones left without a rate", async () => {
    vi.stubGlobal("fetch", async (input: string) =>
      input.includes("/exchange_rates")
        ? Response.json({
            rates: { usd: { value: 100 }, ars: { value: 200000 } },
          })
        : new Response("Throttled", { status: 429 }),
    );

    const response = await get(`Bearer ${SECRET}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      updated: ["ARS", "USD"],
      missing: [
        ...["BTC", "ETH"].map((currency) => ({
          currency,
          reason: "CoinGecko ответил 429",
        })),
        { currency: "GEL", reason: "В exchange_rates CoinGecko нет GEL" },
        { currency: "RUB", reason: "В exchange_rates CoinGecko нет RUB" },
        ...["USDC", "USDT"].map((currency) => ({
          currency,
          reason: "CoinGecko ответил 429",
        })),
      ],
    });
  });
});
