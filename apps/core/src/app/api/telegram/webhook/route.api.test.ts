import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeTelegram,
  stubNetwork,
  textMessage,
  webhookRequest,
} from "@/lib/telegram/telegram.test-utils";
import { POST } from "./route";

const CHAT = 902;

function post(handler: typeof POST, request: Request): Promise<Response> {
  return handler(request as NextRequest, { params: Promise.resolve({}) });
}

beforeEach(() => {
  stubNetwork(new FakeTelegram(), (url) => {
    throw new Error(`Неожиданный запрос: ${url}`);
  });
});

describe("POST /api/telegram/webhook", () => {
  it("answers 401 to a request without the secret token", async () => {
    const response = await post(
      POST,
      webhookRequest(textMessage(CHAT, "ping"), null),
    );
    expect(response.status).toBe(401);
  });

  it("answers 401 to a wrong secret token", async () => {
    const response = await post(
      POST,
      webhookRequest(textMessage(CHAT, "ping"), "wrong-secret"),
    );
    expect(response.status).toBe(401);
  });

  it("answers 400 to a body that is not JSON", async () => {
    const response = await post(POST, webhookRequest('{"update_id":'));
    expect(response.status).toBe(400);
  });

  it("answers 500 when the bot is not configured", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    vi.resetModules();
    const route = await import("./route");

    const response = await post(
      route.POST,
      webhookRequest(textMessage(CHAT, "ping")),
    );
    expect(response.status).toBe(500);
  });
});
