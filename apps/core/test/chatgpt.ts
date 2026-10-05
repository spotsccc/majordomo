/**
 * ChatGPT for tests: a saved session in the test database and Codex/OAuth
 * responses for `vi.stubGlobal("fetch", ...)`. Shared by the route and the
 * agent turn tests.
 */
import { PostgresCredentialStore, PostgresDeviceLoginStore } from "@repo/db";
import { unwrap } from "@spotsccc/error-as-value";
import { config } from "../src/lib/config";
import { db } from "../src/lib/db";

/** Where the provider sends model requests. */
export const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";

/** Saves a valid ChatGPT session, as a finished login does. */
export async function signIn(): Promise<void> {
  const expiresAt = Date.now() + 60 * 60_000;
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const accessToken = [
    encode({ alg: "none" }),
    encode({
      exp: Math.floor(expiresAt / 1000),
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_test" },
    }),
    "signature",
  ].join(".");
  unwrap(
    await new PostgresCredentialStore(
      db,
      config.SECRETS_ENCRYPTION_KEYS,
    ).replace({
      accessToken,
      refreshToken: "rt-0",
      expiresAt,
      accountId: "acct_test",
    }),
  );
}

/** Removes the session and any device login in progress. */
export async function signOut(): Promise<void> {
  unwrap(
    await new PostgresCredentialStore(
      db,
      config.SECRETS_ENCRYPTION_KEYS,
    ).replace(null),
  );
  unwrap(
    await new PostgresDeviceLoginStore(
      db,
      config.SECRETS_ENCRYPTION_KEYS,
    ).clear(),
  );
}

/**
 * A Codex streaming response that writes `text`. With `failure` the response
 * fails after the text, as an overloaded backend does.
 */
export function codexAnswer(text: string, failure?: string): Response {
  const events = [
    { type: "response.created", response: { id: "resp_1", model: "gpt-test" } },
    {
      type: "response.output_text.delta",
      item_id: "msg_1",
      content_index: 0,
      delta: text,
    },
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
  ];
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

/** The URL of a `fetch` call. */
export function urlOf(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}
