import { unwrap } from "@spotsccc/error-as-value";
import { clearDeviceLogin, PostgresCredentialStore } from "./openai-store";

export const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";

export const ACCOUNT_ID = "acct_test";

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

export async function signOut(): Promise<void> {
  unwrap(await new PostgresCredentialStore().replace(null));
  unwrap(await clearDeviceLogin());
}

function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

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

export function codexAnswer(text: string, failure?: string): Response {
  return new Response(answerStart(text) + answerEnd(failure), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** The events chatgpt.com sent for a tool call in the spike of 9 October 2026; `text` deltas come before the call. */
export function codexToolCall(
  name: string,
  args: unknown,
  { text = [] }: { text?: string[] } = {},
): Response {
  const call = crypto.randomUUID().slice(0, 8);
  const item = {
    type: "function_call",
    id: `fc_${call}`,
    call_id: `call_${call}`,
    name,
  };
  const argumentsText = JSON.stringify(args);
  const events = [
    {
      type: "response.created",
      response: { id: "resp_1", model: "gpt-test", output: [] },
    },
    ...text.map((delta) => ({
      type: "response.output_text.delta",
      item_id: "msg_1",
      content_index: 0,
      delta,
    })),
    {
      type: "response.output_item.added",
      output_index: text.length > 0 ? 1 : 0,
      item: { ...item, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      delta: argumentsText,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      arguments: argumentsText,
    },
    {
      type: "response.output_item.done",
      item: { ...item, arguments: argumentsText, status: "completed" },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        output: [],
        usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
      },
    },
  ];
  return new Response(events.map(sse).join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

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

export function urlOf(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}
