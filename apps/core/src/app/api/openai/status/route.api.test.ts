import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { ACCOUNT_ID, signIn, signOut } from "@/lib/chatgpt.test-utils";
import { SESSION_COOKIE, sessionValue } from "@/lib/owner-session";
import { config } from "@/lib/config";
import { GET } from "./route";

const TOKEN = config.MAJORDOMO_API_TOKEN;

function get(authorization?: string): Promise<Response> {
  return GET(
    new Request("https://example.test/api/openai/status", {
      headers: authorization ? { authorization } : {},
    }) as NextRequest,
    { params: Promise.resolve({}) },
  );
}

describe("GET /api/openai/status", () => {
  beforeEach(async () => {
    await signOut();
  });

  it("answers 401 to a caller without the owner token", async () => {
    expect((await get()).status).toBe(401);
  });

  it("takes the session cookie on a GET without an origin", async () => {
    const response = await GET(
      new Request("https://example.test/api/openai/status", {
        headers: { cookie: `${SESSION_COOKIE}=${sessionValue()}` },
      }) as NextRequest,
      { params: Promise.resolve({}) },
    );

    expect(response.status).toBe(200);
  });

  it("answers logged_out without a ChatGPT session", async () => {
    const response = await get(`Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "logged_out" });
  });

  it("answers with the state and the account of a ChatGPT session", async () => {
    await signIn();

    const response = await get(`Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "active",
      accountId: ACCOUNT_ID,
      email: "owner@example.com",
      planType: "pro",
    });
  });
});
