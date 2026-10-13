import { isLoginRequired } from "@repo/openai-subscription";
import {
  convertToModelMessages,
  isStepCount,
  streamText,
  type UIMessage,
} from "ai";
import type { AgentErrorCode } from "./agent-errors";
import { config } from "./config";
import { listCategories, listCurrencies } from "./finance/finance-store";
import { financeTools } from "./finance/tools";
import { createOpenAISubscription } from "./openai";
import { formatOwnerDateTime, ownerIsoDateTime } from "./owner-time";

const RULES = [
  "Учёт денег владельца ведёшь тулами. Если id кошелька неизвестен, сначала вызови list_wallets.",
  "Записывай без подтверждения; переспрашивай, только если запрос неоднозначен. После записи назови, что записал, и новый остаток.",
  "Категорию траты выбирай из списка ниже; новую создавай, только если ни одна не подходит, и скажи об этом.",
  "Если тул ответил insufficient_funds, назови остаток и ничего не записывай частично.",
  "Суммы передавай строкой с точкой, без округления. Обмен валют — transfer в тот же кошелёк. Комиссию передавай в fee, а не уменьшай сумму перевода.",
  "Итог в одной валюте называй вместе с датой курсов; валюты без курса называй отдельно.",
];

/**
 * Model failures, including a dead ChatGPT session, arrive as typed `error` parts of `stream`,
 * not as values; `onError` gets the same errors, which Telegram needs because Chat SDK skips
 * `error` parts. The result's promises (`text`, `finishReason`) lose the error type and cannot
 * tell how the turn ended. A tool call left without a result would make the Responses API
 * reject every following turn, so such calls are dropped from the history.
 */
export async function runAgentTurn({
  messages,
  signal,
  onError,
}: {
  messages: UIMessage[];
  signal?: AbortSignal;
  onError?: (event: { error: unknown }) => void;
}): Promise<Error | ReturnType<typeof streamText<typeof financeTools>>> {
  const [modelMessages, system] = await Promise.all([
    convertToModelMessages(messages, { ignoreIncompleteToolCalls: true }).catch(
      (cause: unknown) =>
        new Error("Сообщения не подходят для модели", { cause }),
    ),
    systemPrompt(new Date()),
  ]);
  if (modelMessages instanceof Error) return modelMessages;
  if (system instanceof Error) return system;

  return streamText({
    model: createOpenAISubscription(config.OPENAI_MODEL),
    system,
    messages: modelMessages,
    tools: financeTools,
    stopWhen: isStepCount(10),
    abortSignal: signal,
    onError,
  });
}

/** Built every turn: the date moves and the owner adds currencies and categories. */
async function systemPrompt(now: Date): Promise<Error | string> {
  const [currencies, categories] = await Promise.all([
    listCurrencies(),
    listCategories(),
  ]);
  if (currencies instanceof Error) return currencies;
  if (categories instanceof Error) return categories;

  return [
    "Ты Majordomo, личный ассистент владельца. Отвечай по делу, на языке вопроса.",
    `Сейчас у владельца ${formatOwnerDateTime(now)}, ${ownerIsoDateTime(now)}, часовой пояс ${config.OWNER_TIME_ZONE}. «Сегодня», «вчера», «в сентябре» считай в этом поясе, occurredAt передавай с этим смещением.`,
    ...RULES,
    `Валюты: ${currencies
      .map(
        ({ code, name, kind, scale }) =>
          `${code} (${name}, ${kind === "fiat" ? "фиат" : "крипта"}, ${scale} знаков)`,
      )
      .join("; ")}.`,
    `Категории трат: ${categories.map(({ id, name }) => `${name} (${id})`).join("; ")}.`,
  ].join("\n");
}

/**
 * Errors without their own code become `model_failed`, so their messages never leave the
 * server.
 */
export function agentErrorCode(error: unknown): AgentErrorCode {
  if (isLoginRequired(error)) return "openai_login_required";
  return "model_failed";
}
