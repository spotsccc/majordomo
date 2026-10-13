import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { signOut } from "@/lib/chatgpt.test-utils";
import { SESSION_COOKIE, sessionValue } from "@/lib/owner-session";
import { config } from "@/lib/config";
import { POST } from "./route";

const TOKEN = config.MAJORDOMO_API_TOKEN;

function post(authorization?: string): Promise<Response> {
  return POST(
    new Request("https://example.test/api/openai/logout", {
      method: "POST",
      headers: authorization ? { authorization } : {},
    }) as NextRequest,
    { params: Promise.resolve({}) },
  );
}

describe("POST /api/openai/logout", () => {
  beforeEach(async () => {
    await signOut();
  });

  it("answers 401 to a caller without the owner token", async () => {
    expect((await post("Bearer wrong")).status).toBe(401);
  });

  it("answers logged_out", async () => {
    const response = await post(`Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "logged_out" });
  });

  it("takes the session cookie from the owner's origin and refuses another origin (E12)", async () => {
    const withSession = (origin: string) =>
      POST(
        new Request("https://example.test/api/openai/logout", {
          method: "POST",
          headers: { cookie: `${SESSION_COOKIE}=${sessionValue()}`, origin },
        }) as NextRequest,
        { params: Promise.resolve({}) },
      );

    expect((await withSession("https://example.test")).status).toBe(200);
    expect((await withSession("https://evil.test")).status).toBe(403);
  });
});
