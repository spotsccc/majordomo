import { createHandler, validateRequest } from "@repo/handler";
import { ReauthRequiredError } from "@repo/openai-subscription";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { requireOwner } from "@/lib/auth";
import { isLoginRequired, loginRequiredResponse } from "@/lib/openai-login";
import { services } from "@/lib/services";

// Vercel Hobby allows at most 300 s per function.
export const maxDuration = 300;

const SYSTEM_PROMPT =
  "Ты Majordomo, личный ассистент владельца. Отвечай по делу, на языке вопроса.";

const AgentRequest = z.object({
  messages: z.array(z.custom<UIMessage>()).min(1),
});

/**
 * Agent turn in the AI SDK UI message format (`useChat` compatible):
 * `{ messages: UIMessage[] }` in, a UI message stream out. Without a ChatGPT
 * session it answers 409 with a login prompt instead of starting the stream.
 */
export const POST = createHandler({}, async ({ request, signal }) => {
  requireOwner(request);
  // After the owner check: strangers get 401, not the expected request shape.
  const { body } = await validateRequest(request, { body: AgentRequest });

  const current = services();
  try {
    // Fail before streaming: the client gets a proper 409, not a broken stream.
    await current.auth.getCredential();
  } catch (error) {
    if (isLoginRequired(error)) return loginRequiredResponse(current, error);
    throw error;
  }

  const result = streamText({
    model: current.openai(current.model),
    system: SYSTEM_PROMPT,
    messages: await convertToModelMessages(body.messages),
    abortSignal: signal,
  });
  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      onError: (error) =>
        error instanceof ReauthRequiredError
          ? `openai_login_required: ${error.message}`
          : "Модель не ответила. Попробуйте ещё раз.",
    }),
  });
});
