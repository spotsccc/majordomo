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
