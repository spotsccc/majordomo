/** A handler never throws: Chat SDK would only log the error, and the owner would get no answer. */
import { createXai } from "@ai-sdk/xai";
import { isLoginRequired } from "@repo/openai-subscription";
import {
  isTextUIPart,
  isToolUIPart,
  toUIMessageStream,
  transcribe,
  type UIMessage,
} from "ai";
import type {
  Attachment,
  Message,
  Postable,
  PostableMessage,
  SentMessage,
  SlashCommandEvent,
  Thread,
} from "chat";
import { runAgentTurn } from "../agent";
import {
  awaitLogin,
  beginTurn,
  closeTelegramConversation,
  failTurn,
  finishTurn,
  loadHistory,
  openTelegramConversation,
} from "../chat-store";
import { config } from "../config";

const REPLY = {
  failed: "Не получилось ответить, попробуйте ещё раз.",
  cutOff: "⚠️ Ответ оборвался, попробуйте ещё раз.",
  loginRequired: "Нужно войти в ChatGPT: войдите в веб-версии Majordomo.",
  unsupported:
    "Понимаю только текст и голосовые, остальные вложения пропускаю.",
  voiceOff: "Распознавание голосовых не настроено.",
  voiceTooLong: "Голосовое слишком длинное, разбейте на части.",
  voiceFailed: "Не смог распознать голосовое, повторите текстом или ещё раз.",
  newConversation: "Начали новый диалог.",
  greeting:
    "Привет! Я Majordomo. Пишите, что нужно; /new начинает новый диалог.",
  unknownCommand: "Не знаю такой команды. /new начинает новый диалог.",
};

/** The Bot API does not hand out larger files (`getFile`). */
const VOICE_MAX_BYTES = 20 * 2 ** 20;

const TRANSCRIBE_TIMEOUT_MS = 30_000;

/** The adapter edits the message at most once per 1100 ms, and only when a new chunk arrives. */
const QUIET_MS = 1200;

export async function handleOwnerMessages(
  thread: Thread,
  series: Message[],
): Promise<void> {
  const ownerMessages: UIMessage[] = [];
  const notices = new Set<string>();

  for (const message of series) {
    const read = await readOwnerMessage(message);
    for (const notice of read.notices) notices.add(notice);
    if (read.text) ownerMessages.push(toUIMessage(message, read.text));
  }

  for (const notice of notices) await post(thread, notice);

  const [first, ...rest] = ownerMessages;
  if (!first) return;

  const conversationId = await openTelegramConversation(thread.id);
  if (conversationId instanceof Error) return fail(thread, conversationId);

  const turnId = await beginTurn(conversationId, [first, ...rest]);
  if (turnId instanceof Error) return fail(thread, turnId);

  await answerTurn(thread, conversationId, turnId);
}

/** The transcript is not logged: it is the owner's speech. */
async function readOwnerMessage(
  message: Message,
): Promise<{ text: string; notices: string[] }> {
  const parts: string[] = [];
  const notices: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type !== "audio") {
      notices.push(REPLY.unsupported);
    } else if (!config.XAI_API_KEY) {
      notices.push(REPLY.voiceOff);
    } else if ((attachment.size ?? 0) > VOICE_MAX_BYTES) {
      notices.push(REPLY.voiceTooLong);
    } else {
      const transcript = await transcribeVoice(attachment, config.XAI_API_KEY);
      if (transcript instanceof Error) {
        console.error("Telegram: голосовое не распознано", transcript);
        notices.push(REPLY.voiceFailed);
      } else {
        parts.push(transcript);
      }
    }
  }
  parts.push(message.text);
  const text = parts
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join("\n\n");
  if (!text && notices.length === 0) notices.push(REPLY.unsupported);
  return { text, notices };
}

/** The audio goes as it is: xAI detects the format. `transcribe` retries a 5xx and a 429 twice. */
async function transcribeVoice(
  voice: Attachment,
  apiKey: string,
): Promise<Error | string> {
  if (!voice.fetchData) {
    return new Error("Telegram не дал способа скачать голосовое");
  }
  const audio = await voice
    .fetchData()
    .catch(
      (cause: unknown) => new Error("Не удалось скачать голосовое", { cause }),
    );
  if (audio instanceof Error) return audio;

  const result = await transcribe({
    model: createXai({ apiKey }).transcription("grok-voice-transcribe-2.0"),
    audio,
    abortSignal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
  }).catch(
    (cause: unknown) => new Error("Не удалось распознать голосовое", { cause }),
  );
  if (result instanceof Error) return result;
  return result.text;
}

/**
 * Chat SDK skips `error` parts of the stream, so `thread.post` succeeds even when the model
 * fails: how the turn ended comes from `onError` and from a rejected `thread.post`. The answer
 * with its tool calls comes from `onEnd` of the UI message stream, which fires only once that
 * stream is read to the end.
 */
async function answerTurn(
  thread: Thread,
  conversationId: string,
  turnId: string,
): Promise<void> {
  const history = await loadHistory(conversationId);
  if (history instanceof Error) return fail(thread, history, turnId);

  let failure: unknown;
  const turn = await runAgentTurn({
    messages: history,
    onError: ({ error }) => {
      failure ??= error;
    },
  });
  if (turn instanceof Error) return fail(thread, turn, turnId);

  let answer: UIMessage | undefined;
  const [sent] = await Promise.all([
    thread.post(withHeartbeat(turn.fullStream)).catch((error: unknown) => {
      failure ??= error;
      return undefined;
    }),
    toUIMessageStream({
      stream: turn.stream,
      generateMessageId: () => crypto.randomUUID(),
      onEnd: ({ responseMessage }) => {
        answer = responseMessage;
      },
    })
      .pipeTo(new WritableStream())
      .catch((error: unknown) => {
        failure ??= error;
      }),
  ]);

  if (failure === undefined) {
    const finished = await finishTurn(
      turnId,
      answer ?? {
        id: crypto.randomUUID(),
        role: "assistant",
        parts: [{ type: "text", text: "" }],
      },
    );
    if (finished instanceof Error) {
      console.error("Telegram: ответ агента не сохранён в истории", finished);
    }
    return;
  }

  const partial = answer && ranTools(answer) ? answer : undefined;
  if (isLoginRequired(failure)) {
    const marked = await awaitLogin(turnId, partial);
    if (marked instanceof Error) {
      console.error("Telegram: ожидание входа не записано", marked);
    }
    return replace(thread, sent, REPLY.loginRequired);
  }

  const error = toError(failure);
  console.error("Telegram: ход агента не удался", error);
  const failed = await failTurn(turnId, error, partial);
  if (failed instanceof Error) {
    console.error("Telegram: сбой хода не записан", failed);
  }
  const text = answer ? textOf(answer) : "";
  return replace(
    thread,
    sent,
    text ? { markdown: `${text}\n\n${REPLY.cutOff}` } : REPLY.failed,
  );
}

/**
 * While tools run nothing new arrives, so the adapter would keep showing only the first chunk of
 * the text before them; an empty chunk after a pause makes it edit in the text it holds back.
 */
async function* withHeartbeat<T>(
  stream: AsyncIterable<T>,
): AsyncGenerator<T | ""> {
  const iterator = stream[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let next = iterator.next();
    while (true) {
      const quiet = new Promise<"quiet">((resolve) => {
        timer = setTimeout(() => resolve("quiet"), QUIET_MS);
      });
      const result = await Promise.race([next, quiet]);
      clearTimeout(timer);
      if (result === "quiet") {
        yield "";
        continue;
      }
      if (result.done) return;
      yield result.value;
      next = iterator.next();
    }
  } finally {
    clearTimeout(timer);
    await iterator.return?.();
  }
}

function ranTools(message: UIMessage): boolean {
  return message.parts.some(
    (part) =>
      isToolUIPart(part) &&
      (part.state === "output-available" || part.state === "output-error"),
  );
}

/** Steps are joined the way Chat SDK shows them in Telegram. */
function textOf(message: UIMessage): string {
  return message.parts
    .filter(isTextUIPart)
    .map((part) => part.text)
    .filter((text) => text !== "")
    .join("\n\n");
}

/**
 * Chat SDK hands every message starting with `/` here, not to `onDirectMessage`. The event has
 * no thread, but the adapter gives the channel the thread id of the command's message, the key
 * of the owner's conversation.
 */
export async function handleSlashCommand(
  event: SlashCommandEvent,
): Promise<void> {
  if (event.command === "/new") {
    const closed = await closeTelegramConversation(event.channel.id);
    if (closed instanceof Error) return fail(event.channel, closed);
    return post(event.channel, REPLY.newConversation);
  }
  return post(
    event.channel,
    event.command === "/start" ? REPLY.greeting : REPLY.unknownCommand,
  );
}

/** Telegram's message id is for reference only: the history is ordered by `seq`. */
function toUIMessage(message: Message, text: string): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    metadata: { telegramMessageId: message.id },
    parts: [{ type: "text", text }],
  };
}

async function fail(
  target: Postable,
  error: Error,
  turnId?: string,
): Promise<void> {
  console.error("Telegram: не удалось ответить владельцу", error);
  if (turnId !== undefined) {
    const failed = await failTurn(turnId, error);
    if (failed instanceof Error) {
      console.error("Telegram: сбой хода не записан", failed);
    }
  }
  await post(target, REPLY.failed);
}

async function replace(
  thread: Thread,
  sent: SentMessage | undefined,
  content: PostableMessage,
): Promise<void> {
  const replaced = await (
    sent ? sent.edit(content) : thread.post(content)
  ).catch(toError);
  if (replaced instanceof Error) {
    console.error("Telegram: сообщение не исправлено", replaced);
  }
}

/** A failure is only logged: there is nobody else to tell. */
async function post(target: Postable, message: string): Promise<void> {
  const sent = await target.post(message).catch(toError);
  if (sent instanceof Error) {
    console.error("Telegram: сообщение не отправлено", sent);
  }
}

function toError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error("Сбой без объекта ошибки", { cause: value });
}
