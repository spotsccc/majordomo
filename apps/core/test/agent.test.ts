import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/agent/route";
import { config } from "../src/lib/config";
import { codexAnswer, signIn, signOut, urlOf } from "./chatgpt";

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

  it("checks the owner before the body", async () => {
    const response = await post("{}");
    expect(response.status).toBe(401);
  });

  it("rejects a turn without messages", async () => {
    const response = await post('{"messages":[]}', `Bearer ${TOKEN}`);
    expect(response.status).toBe(400);
  });

  it("ends the stream with a login error and does not call the model when there is no ChatGPT session", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchFn);

    const response = await post(TURN, `Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(await chunksOf(response)).toContainEqual({
      type: "error",
      errorText: "openai_login_required",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("streams the model answer as UI message chunks", async () => {
    await signIn();
    vi.stubGlobal("fetch", async () => codexAnswer("pong"));

    const response = await post(TURN, `Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    const chunks = await chunksOf(response);
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: "text-delta", delta: "pong" }),
    );
    expect(chunks).toContainEqual({ type: "finish", finishReason: "stop" });
  });

  it("ends the stream with a login error when the session dies during the turn", async () => {
    await signIn();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      urlOf(input).startsWith("https://auth.openai.com/")
        ? Response.json({ error: "invalid_grant" }, { status: 400 })
        : new Response("{}", { status: 401 }),
    );

    const response = await post(TURN, `Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(await chunksOf(response)).toContainEqual({
      type: "error",
      errorText: "openai_login_required",
    });
  });

  it("ends the stream with model_failed when the model fails midway", async () => {
    await signIn();
    vi.stubGlobal("fetch", async () => codexAnswer("half", "overloaded"));

    const response = await post(TURN, `Bearer ${TOKEN}`);

    const chunks = await chunksOf(response);
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: "text-delta", delta: "half" }),
    );
    expect(chunks).toContainEqual({
      type: "error",
      errorText: "model_failed",
    });
  });
});
