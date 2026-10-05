import { zstdDecompressSync } from "node:zlib";
import { NotLoggedInError } from "@repo/openai-subscription";
import type { TextStreamPart, ToolSet, UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentTurn } from "../src/lib/agent";
import { CODEX_URL, codexAnswer, signIn, signOut, urlOf } from "./chatgpt";

const messages: UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "ping" }] },
];

async function textOf(
  stream: AsyncIterable<TextStreamPart<ToolSet>>,
): Promise<string> {
  let text = "";
  for await (const part of stream) {
    if (part.type === "text-delta") text += part.text;
  }
  return text;
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

    const errors: unknown[] = [];
    for await (const part of turn.stream) {
      if (part.type === "error") errors.push(part.error);
    }
    expect(errors).toEqual([expect.any(NotLoggedInError)]);
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

    expect(await textOf(turn.stream)).toBe("pong");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(CODEX_URL);
    expect(requests[0]?.body).toContain('"ping"');
  });
});
