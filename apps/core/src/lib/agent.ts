import { isLoginRequired } from "@repo/openai-subscription";
import {
  convertToModelMessages,
  streamText,
  type ToolSet,
  type UIMessage,
} from "ai";
import type { AgentErrorCode } from "./agent-errors";
import { config } from "./config";
import { createOpenAISubscription } from "./openai";

const SYSTEM_PROMPT =
  "Ты Majordomo, личный ассистент владельца. Отвечай по делу, на языке вопроса.";

/**
 * Starts one agent turn over the conversation so far and returns the
 * `streamText` result as is. It is shared because there are two callers:
 * `POST /api/agent` and the Telegram handler (stage 3 of
 * docs/plans/telegram-channel.md).
 *
 * Model failures, including a missing or dead ChatGPT session, do not come
 * back as values: `streamText` does not throw, the error arrives as an
 * `error` part of `stream` and keeps its type, so `isLoginRequired` works on
 * it. Messages that cannot be converted for the model are returned as an
 * `Error`.
 *
 * The promises of the result (`responseMessages`, `finishReason` and the
 * like) reject: with the model error when the model fails before the first
 * step ends (`finishReason` with `NoOutputGeneratedError`), and with the abort
 * reason when `signal` aborts the turn. Reading one of them makes the SDK
 * consume the stream itself, so the model runs to the end even if nobody
 * reads `stream`.
 */
export async function runAgentTurn({
  messages,
  signal,
}: {
  messages: UIMessage[];
  signal?: AbortSignal;
}): Promise<Error | ReturnType<typeof streamText<ToolSet>>> {
  const modelMessages = await convertToModelMessages(messages).catch(
    (cause) => new Error("Сообщения не подходят для модели", { cause }),
  );
  if (modelMessages instanceof Error) return modelMessages;

  return streamText({
    model: createOpenAISubscription(config.OPENAI_MODEL),
    system: SYSTEM_PROMPT,
    messages: modelMessages,
    abortSignal: signal,
  });
}

/**
 * Code of a failed turn for the client (`errorText` of the UI stream error
 * chunk). Errors without their own code become `model_failed`, so their
 * messages never leave the server.
 */
export function agentErrorCode(error: unknown): AgentErrorCode {
  if (isLoginRequired(error)) return "openai_login_required";
  return "model_failed";
}
