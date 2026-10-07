/**
 * ChatGPT for tests: a saved session in the test database and Codex/OAuth
 * responses, for `vi.stubGlobal("fetch", ...)` in Vitest and for the fake
 * OpenAI of the e2e tests. Shared by the route API tests, the agent turn
 * module test and the e2e tests.
 */
import { unwrap } from "@spotsccc/error-as-value";
import { clearDeviceLogin, PostgresCredentialStore } from "./openai-store";

/** Where the provider sends model requests. */
export const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";

/** The ChatGPT account of the test session. */
export const ACCOUNT_ID = "acct_test";

/**
 * An unsigned access token of the test account (owner@example.com, plan
 * `pro`) that expires at `expiresAt`, with the claims the provider reads.
 */
export function accessToken(expiresAt: number): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return [
    encode({ alg: "none" }),
    encode({
      exp: Math.floor(expiresAt / 1000),
      "https://api.openai.com/auth": {
        chatgpt_account_id: ACCOUNT_ID,
        chatgpt_plan_type: "pro",
      },
      "https://api.openai.com/profile": { email: "owner@example.com" },
    }),
    "signature",
  ].join(".");
}

/** Saves a valid ChatGPT session with refresh token `rt-0`, as a finished login does. */
export async function signIn(): Promise<void> {
  const expiresAt = Date.now() + 60 * 60_000;
  unwrap(
    await new PostgresCredentialStore().replace({
      accessToken: accessToken(expiresAt),
      refreshToken: "rt-0",
      expiresAt,
      accountId: ACCOUNT_ID,
    }),
  );
}

/** Removes the session and any device login in progress. */
export async function signOut(): Promise<void> {
  unwrap(await new PostgresCredentialStore().replace(null));
  unwrap(await clearDeviceLogin());
}

/** A Codex server-sent event. */
function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** The Codex events that start an answer and write `text`. */
function answerStart(text: string): string {
  return (
    sse({
      type: "response.created",
      response: { id: "resp_1", model: "gpt-test" },
    }) +
    sse({
      type: "response.output_text.delta",
      item_id: "msg_1",
      content_index: 0,
      delta: text,
    })
  );
}

/** The Codex event that ends an answer, or fails it with `failure`. */
function answerEnd(failure?: string): string {
  return sse(
    failure
      ? {
          type: "response.failed",
          response: { error: { code: "server_error", message: failure } },
        }
      : {
          type: "response.completed",
          response: {
            id: "resp_1",
            usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
          },
        },
  );
}

/**
 * A Codex streaming response that writes `text`. With `failure` the response
 * fails after the text, as an overloaded backend does.
 */
export function codexAnswer(text: string, failure?: string): Response {
  return new Response(answerStart(text) + answerEnd(failure), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * A Codex streaming response that writes `text` and then holds the answer
 * open until `release` is called, as a model that is still thinking does.
 */
export function heldCodexAnswer(text: string): {
  response: Response;
  release: () => void;
} {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(answerStart(text)));
      await released;
      controller.enqueue(encoder.encode(answerEnd()));
      controller.close();
    },
  });
  return {
    response: new Response(body, {
      headers: { "Content-Type": "text/event-stream" },
    }),
    release,
  };
}

/** The URL of a `fetch` call. */
export function urlOf(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}
