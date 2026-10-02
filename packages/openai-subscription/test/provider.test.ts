import { unwrap } from "@spotsccc/error-as-value";
import { describe, expect, it } from "vitest";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import {
  MemoryCredentialStore,
  OpenAISubscriptionAuth,
  ReauthRequiredError,
  createOpenAISubscription,
} from "../src/index.js";
import { ACCOUNT_ID, credential, fakeOAuthServer } from "./helpers.js";

function sse(events: unknown[]): Response {
  const body = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const answer = (text: string) => [
  { type: "response.created", response: { id: "resp_1", model: "gpt-test" } },
  {
    type: "response.output_text.delta",
    item_id: "msg_1",
    content_index: 0,
    delta: text,
  },
  {
    type: "response.completed",
    response: {
      id: "resp_1",
      usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
    },
  },
];

describe("createOpenAISubscription", () => {
  it("sends the stored token and retries once with a refreshed token after a 401", async () => {
    const oauth = fakeOAuthServer();
    const store = new MemoryCredentialStore(
      credential(Date.now() + 60 * 60_000),
    );
    const staleToken = unwrap(await store.load()).credential!.accessToken;
    const requests: {
      authorization: string | null;
      account: string | null;
      body: unknown;
    }[] = [];

    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://auth.openai.com/"))
        return oauth.fetch(input, init);
      const headers = new Headers(init?.headers);
      requests.push({
        authorization: headers.get("Authorization"),
        account: headers.get("ChatGPT-Account-Id"),
        body: JSON.parse(String(init?.body)),
      });
      if (headers.get("Authorization") === `Bearer ${staleToken}`) {
        return new Response(
          JSON.stringify({ error: { code: "token_expired" } }),
          { status: 401 },
        );
      }
      return sse(answer("pong"));
    };

    const auth = new OpenAISubscriptionAuth({ store, fetchFn });
    const model = createOpenAISubscription({ auth, compression: false })(
      "gpt-test",
    );
    const result = await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
    });

    expect(result.content).toContainEqual(
      expect.objectContaining({ type: "text", text: "pong" }),
    );
    expect(oauth.refreshCalls).toEqual(["rt-0"]);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.authorization).toBe(`Bearer ${staleToken}`);
    const refreshed = unwrap(await store.load()).credential!;
    expect(requests[1]!.authorization).toBe(`Bearer ${refreshed.accessToken}`);
    expect(requests[1]!.account).toBe(ACCOUNT_ID);
    expect(requests[1]!.body).toEqual(requests[0]!.body);
    expect(requests[0]!.body).toMatchObject({
      model: "gpt-test",
      store: false,
      stream: true,
    });
  });

  it("streams through the 401 retry and reports a dead session with its type", async () => {
    const oauth = fakeOAuthServer();
    const store = new MemoryCredentialStore(
      credential(Date.now() + 60 * 60_000),
    );
    const fetchFn: typeof fetch = async (input, init) => {
      if (String(input).startsWith("https://auth.openai.com/"))
        return oauth.fetch(input, init);
      const authorization = new Headers(init?.headers).get("Authorization");
      const current = unwrap(await store.load()).credential?.accessToken;
      return authorization === `Bearer ${current}` && calls++ > 0
        ? sse(answer("pong"))
        : new Response("{}", { status: 401 });
    };
    let calls = 0;
    const auth = new OpenAISubscriptionAuth({ store, fetchFn });
    const model = createOpenAISubscription({ auth, compression: false })(
      "gpt-test",
    );
    const prompt = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "ping" }],
      },
    ];

    const parts = await readAll((await model.doStream({ prompt })).stream);
    expect(parts).toContainEqual(expect.objectContaining({ type: "finish" }));
    expect(
      parts
        .flatMap((part) => (part.type === "text-delta" ? [part.delta] : []))
        .join(""),
    ).toBe("pong");

    // The next 401 meets a refresh token that OpenAI no longer accepts.
    calls = 0;
    oauth.failNextRefresh(400, { error: "invalid_grant" });
    const failed = await readAll((await model.doStream({ prompt })).stream);
    const error = failed.find((part) => part.type === "error");
    expect(error && "error" in error && error.error).toBeInstanceOf(
      ReauthRequiredError,
    );
    await expect(model.doGenerate({ prompt })).rejects.toBeInstanceOf(
      ReauthRequiredError,
    );
  });
});

async function readAll(
  stream: ReadableStream<LanguageModelV4StreamPart>,
): Promise<LanguageModelV4StreamPart[]> {
  const parts: LanguageModelV4StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}
