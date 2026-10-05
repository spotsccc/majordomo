import { createHandler } from "@repo/handler";
import {
  createUIMessageStreamResponse,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { agentErrorCode, runAgentTurn } from "@/lib/agent";
import { requireOwner } from "@/lib/auth";

/** Vercel Hobby allows at most 300 s per function. */
export const maxDuration = 300;

const AgentRequest = z.object({
  messages: z.array(z.custom<UIMessage>()).min(1),
});

/**
 * Agent turn in the AI SDK UI message format (`useChat` compatible):
 * `{ messages: UIMessage[] }` in, a UI message stream out. Without a working
 * ChatGPT session, before or during the turn, the stream ends with an
 * `openai_login_required` error chunk, which `chat.tsx` answers by starting a
 * device login; other model failures end it with `model_failed` (codes in
 * `@/lib/agent-errors`). The owner is checked before the body, so strangers
 * get 401, not the expected request shape.
 */
export const POST = createHandler(
  {
    guards: [requireOwner],
    body: AgentRequest,
  },
  async ({ signal, body }) => {
    const turn = await runAgentTurn({ messages: body.messages, signal });
    if (turn instanceof Error) throw turn;

    return createUIMessageStreamResponse({
      stream: toUIMessageStream({
        stream: turn.stream,
        onError: agentErrorCode,
      }),
    });
  },
);
