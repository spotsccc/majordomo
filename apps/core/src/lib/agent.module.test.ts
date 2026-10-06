import { zstdDecompressSync } from "node:zlib";
import {
  NotLoggedInError,
  ReauthRequiredError,
} from "@repo/openai-subscription";
import type { TextStreamPart, ToolSet, UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentErrorCode, runAgentTurn } from "./agent";
import {
  CODEX_URL,
  codexAnswer,
  signIn,
  signOut,
  urlOf,
} from "./chatgpt.test-utils";

const messages: UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "ping" }] },
];

/** The streamed text and the errors of the `error` parts, in order. */
async function read(
  stream: AsyncIterable<TextStreamPart<ToolSet>>,
): Promise<{ text: string; errors: unknown[] }> {
  let text = "";
  const errors: unknown[] = [];
  for await (const part of stream) {
    if (part.type === "text-delta") text += part.text;
    if (part.type === "error") errors.push(part.error);
  }
  return { text, errors };
}

/** The request body as text; the provider compresses it with zstd. */
function bodyOf(init: RequestInit | undefined): string {
  return init?.body instanceof Uint8Array
    ? zstdDecompressSync(init.body).toString()
    : String(init?.body);
}

describe("runAgentTurn", () => {
  beforeEach(async () => {
    await signOut();
  });

  it("streams NotLoggedInError without a ChatGPT session and does not call the model", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchFn);

    const turn = await runAgentTurn({ messages });
    if (turn instanceof Error) throw turn;

    const { errors } = await read(turn.stream);
    expect(errors).toEqual([expect.any(NotLoggedInError)]);
    expect(errors.map(agentErrorCode)).toEqual(["openai_login_required"]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("streams the model answer to the conversation", async () => {
    await signIn();
    const requests: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: urlOf(input), body: bodyOf(init) });
        return codexAnswer("pong");
      },
    );

    const turn = await runAgentTurn({ messages });
    if (turn instanceof Error) throw turn;

    expect(await read(turn.stream)).toEqual({ text: "pong", errors: [] });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(CODEX_URL);
    expect(requests[0]?.body).toContain('"ping"');
  });

  it("streams ReauthRequiredError, a login error for the client, when the session dies during the turn", async () => {
    await signIn();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) =>
      urlOf(input).startsWith("https://auth.openai.com/")
        ? Response.json({ error: "invalid_grant" }, { status: 400 })
        : new Response("{}", { status: 401 }),
    );

    const turn = await runAgentTurn({ messages });
    if (turn instanceof Error) throw turn;

    const { errors } = await read(turn.stream);
    expect(errors).toEqual([expect.any(ReauthRequiredError)]);
    expect(errors.map(agentErrorCode)).toEqual(["openai_login_required"]);
  });

  it("streams the partial answer and a model_failed error when the model fails midway", async () => {
    await signIn();
    vi.stubGlobal("fetch", async () => codexAnswer("half", "overloaded"));

    const turn = await runAgentTurn({ messages });
    if (turn instanceof Error) throw turn;

    const { text, errors } = await read(turn.stream);
    expect(text).toBe("half");
    expect(errors).toHaveLength(1);
    expect(errors.map(agentErrorCode)).toEqual(["model_failed"]);
  });
});
