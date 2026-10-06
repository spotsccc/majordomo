import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { codexAnswer, signIn, signOut } from "@/lib/chatgpt.test-utils";
import { config } from "@/lib/config";
import { POST } from "./route";

const TOKEN = config.MAJORDOMO_API_TOKEN;

const TURN = JSON.stringify({
  messages: [
    { id: "u1", role: "user", parts: [{ type: "text", text: "ping" }] },
  ],
});

function request(body: string, authorization?: string): NextRequest {
  return new Request("https://example.test/api/agent", {
    method: "POST",
    headers: authorization ? { authorization } : {},
    body,
  }) as NextRequest;
}

function post(body: string, authorization?: string): Promise<Response> {
  return POST(request(body, authorization), { params: Promise.resolve({}) });
}

/** The chunks of a UI message stream response (server-sent events). */
async function chunksOf(response: Response): Promise<unknown[]> {
  return (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

describe("POST /api/agent", () => {
  beforeEach(async () => {
    await signOut();
  });

  it("answers 401 to a caller without the owner token before reading the body", async () => {
    const response = await post("{}");
    expect(response.status).toBe(401);
  });

  it("answers 400 to a turn without messages", async () => {
    const response = await post('{"messages":[]}', `Bearer ${TOKEN}`);
    expect(response.status).toBe(400);
  });

  it("answers 400 to a body that is not JSON", async () => {
    const response = await post('{"messages":', `Bearer ${TOKEN}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Некорректное JSON тело запроса",
    });
  });

  it("streams the answer as UI message chunks", async () => {
    await signIn();
    vi.stubGlobal("fetch", async () => codexAnswer("pong"));

    const response = await post(TURN, `Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const chunks = await chunksOf(response);
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: "text-delta", delta: "pong" }),
    );
    expect(chunks).toContainEqual({ type: "finish", finishReason: "stop" });
  });

  it("ends the stream with the model_failed error code and keeps the model's message on the server", async () => {
    await signIn();
    vi.stubGlobal("fetch", async () => codexAnswer("half", "overloaded"));

    const response = await post(TURN, `Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    const chunks = await chunksOf(response);
    expect(chunks).toContainEqual({ type: "error", errorText: "model_failed" });
    expect(JSON.stringify(chunks)).not.toContain("overloaded");
  });

  it("ends the stream with the openai_login_required error code when there is no ChatGPT session", async () => {
    const response = await post(TURN, `Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(await chunksOf(response)).toContainEqual({
      type: "error",
      errorText: "openai_login_required",
    });
  });
});
