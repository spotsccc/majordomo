import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signOut } from "@/lib/chatgpt.test-utils";
import { config } from "@/lib/config";
import { GET, POST } from "./route";

const TOKEN = config.MAJORDOMO_API_TOKEN;

function call(
  handler: typeof GET | typeof POST,
  method: "GET" | "POST",
  authorization?: string,
): Promise<Response> {
  return handler(
    new Request("https://example.test/api/openai/login", {
      method,
      headers: authorization ? { authorization } : {},
    }) as NextRequest,
    { params: Promise.resolve({}) },
  );
}

describe("/api/openai/login", () => {
  beforeEach(async () => {
    await signOut();
  });

  it("answers 401 to a caller without the owner token", async () => {
    expect((await call(POST, "POST")).status).toBe(401);
    expect((await call(GET, "GET", "Bearer wrong")).status).toBe(401);
  });

  it("answers POST with the code and the link for the owner", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        device_auth_id: "dev_1",
        user_code: "ABCD-1234",
        interval: "5",
      }),
    );

    const response = await call(POST, "POST", `Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      verificationUrl: expect.any(String),
      userCode: "ABCD-1234",
      expiresAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      pollIntervalMs: expect.any(Number),
    });
  });

  it("answers POST with 409 device_login_unavailable when the account has device login disabled", async () => {
    vi.stubGlobal("fetch", async () => Response.json({}, { status: 404 }));

    const response = await call(POST, "POST", `Bearer ${TOKEN}`);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "device_login_unavailable",
      message: expect.any(String),
    });
  });

  it("answers GET with the login progress", async () => {
    const response = await call(GET, "GET", `Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "none" });
  });
});
