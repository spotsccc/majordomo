import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "../src/app/api/agent/route";

const TOKEN = "owner-token-0123456789abcdef0123456789";

function request(body: string, authorization?: string): NextRequest {
  return new Request("https://example.test/api/agent", {
    method: "POST",
    headers: authorization ? { authorization } : {},
    body,
  }) as NextRequest;
}

describe("POST /api/agent", () => {
  beforeEach(() => {
    process.env.MAJORDOMO_API_TOKEN = TOKEN;
  });
  afterEach(() => {
    delete process.env.MAJORDOMO_API_TOKEN;
  });

  it("checks the owner before the body", async () => {
    const response = await POST(request("{}"), { params: Promise.resolve({}) });
    expect(response.status).toBe(401);
  });

  it("rejects a turn without messages", async () => {
    const response = await POST(request('{"messages":[]}', `Bearer ${TOKEN}`), {
      params: Promise.resolve({}),
    });
    expect(response.status).toBe(400);
  });
});
