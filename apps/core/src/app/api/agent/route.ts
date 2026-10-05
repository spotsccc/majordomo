import { createHandler, validateRequest } from "@repo/handler";
import {
  ReauthRequiredError,
  createOpenAISubscription,
  isLoginRequired,
} from "@repo/openai-subscription";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { requireOwner } from "@/lib/auth";
import { config } from "@/lib/config";
import { createOpenAIAuth } from "@/lib/openai";
import { loginRequiredResponse } from "@/lib/openai-login";

/** Vercel Hobby allows at most 300 s per function. */
export const maxDuration = 300;

const SYSTEM_PROMPT =
  "Ты Majordomo, личный ассистент владельца. Отвечай по делу, на языке вопроса.";

const AgentRequest = z.object({
  messages: z.array(z.custom<UIMessage>()).min(1),
});

/**
 * Agent turn in the AI SDK UI message format (`useChat` compatible):
 * `{ messages: UIMessage[] }` in, a UI message stream out. Without a ChatGPT
 * session it answers 409 with a login prompt instead of starting the stream:
 * the credential is checked before streaming, so the client gets a proper 409,
 * not a broken stream. The owner is checked before the body, so strangers get
 * 401, not the expected request shape.
 */
export const POST = createHandler({}, async ({ request, signal }) => {
  const denied = requireOwner(request);
  if (denied instanceof Error) throw denied;

  const { body } = await validateRequest(request, { body: AgentRequest });

  const auth = createOpenAIAuth();
  const credential = await auth.getCredential();
  if (isLoginRequired(credential)) {
    const response = await loginRequiredResponse(credential);
    if (response instanceof Error) throw response;
    return response;
  }
  if (credential instanceof Error) throw credential;

  const result = streamText({
    model: createOpenAISubscription({ auth })(config.OPENAI_MODEL),
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
