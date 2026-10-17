/** A handler never throws: Chat SDK would only log the error, and the owner would get no answer. */
import { createXai } from "@ai-sdk/xai";
import type { CoreSection, EntryKind } from "@repo/db";
import { isLoginRequired } from "@repo/openai-subscription";
import { waitUntil } from "@vercel/functions";
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
import type { Turn } from "../capability";
import {
  awaitLogin,
  beginTurn,
  closeTelegramConversation,
  failTurn,
  finishTurn,
  lastMessageAt,
  openTelegramConversation,
  unprocessedCount,
} from "../chat-store";
import { config } from "../config";
import { listActive, type CoreFact, type Entry } from "../memory/memory-store";
import { processConversation } from "../memory/process-conversation";
import { ownerDayRange, ownerIsoDateTime } from "../owner-time";

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
  privateOnly: "Только в личном чате.",
};

const CORE_SECTIONS: [CoreSection, string][] = [
  ["instructions", "Указания"],
  ["profile", "О владельце"],
];

const ENTRY_KINDS: [EntryKind, string][] = [
  ["person", "Люди"],
  ["preference", "Предпочтения"],
  ["fact", "Факты"],
  ["plan", "Планы"],
];

/** The adapter cuts a longer text with an ellipsis (`truncateForTelegram`), counting UTF-16 units. */
const MESSAGE_MAX = 4096;

const PAUSE_MS = 3 * 3_600_000;

const UNPROCESSED_MAX = 40;

const pastDay = new Intl.DateTimeFormat("ru-RU", {
  timeZone: config.OWNER_TIME_ZONE,
  day: "numeric",
  month: "long",
});

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

  const paused = await closeAfterPause(thread);
  if (paused instanceof Error) return fail(thread, paused);

  const conversationId = await openTelegramConversation(thread.id);
  if (conversationId instanceof Error) return fail(thread, conversationId);

  const begun = await beginTurn(conversationId, [first, ...rest]);
  if (begun instanceof Error) return fail(thread, begun);

  await answerTurn(
    thread,
    { conversationId, messageId: begun.ownerMessageId },
    begun.turnId,
  );

  const unprocessed = await unprocessedCount(conversationId);
  if (unprocessed instanceof Error) {
    console.error(
      "Telegram: не удалось проверить, пора ли обработать диалог",
      unprocessed,
    );
  } else if (unprocessed > UNPROCESSED_MAX) {
    processInBackground(conversationId, { whole: false });
  }
}

/** The notice of the pause (П18) goes as a message of its own: the answer after it is a stream. */
async function closeAfterPause(thread: Thread): Promise<Error | undefined> {
  const last = await lastMessageAt(thread.id);
  if (last instanceof Error) return last;
  if (!last || Date.now() - last.at.getTime() <= PAUSE_MS) return;

  const closed = await closeTelegramConversation(thread.id);
  if (closed instanceof Error) return closed;
  if (closed) processInBackground(closed, { whole: true });
  const day = dayName(last.at);
  await post(
    thread,
    last.title
      ? `Новый разговор. Прошлый — ${day}, «${last.title}».`
      : `Новый разговор. Прошлый — ${day}.`,
  );
}

function dayName(instant: Date): string {
  const day = ownerIsoDateTime(instant).slice(0, 10);
  const today = ownerIsoDateTime(new Date()).slice(0, 10);
  if (day === today) return "сегодня";
  const yesterday = ownerIsoDateTime(
    new Date(ownerDayRange(today).from.getTime() - 1),
  ).slice(0, 10);
  return day === yesterday ? "вчера" : pastDay.format(instant);
}

/**
 * The processing runs after the answer, outside the handler: Chat SDK holds the thread's lock until
 * the handler ends, and the owner's next message would wait for it (fact 7). `waitUntil` keeps the
 * function alive until the processing ends; outside Vercel it does nothing, and the processing
 * runs on its own (spike results, item 1).
 */
function processInBackground(
  conversationId: string,
  { whole }: { whole: boolean },
): void {
  waitUntil(processConversation(conversationId, { whole }));
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
  turn: Turn,
  turnId: string,
): Promise<void> {
  let failure: unknown;
  const run = await runAgentTurn({
    turn,
    onError: ({ error }) => {
      failure ??= error;
    },
  });
  if (run instanceof Error) return fail(thread, run, turnId);

  let answer: UIMessage | undefined;
  const [sent] = await Promise.all([
    thread.post(withHeartbeat(run.fullStream)).catch((error: unknown) => {
      failure ??= error;
      return undefined;
    }),
    toUIMessageStream({
      stream: run.stream,
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
    if (closed) processInBackground(closed, { whole: true });
    return post(event.channel, REPLY.newConversation);
  }
  if (event.command === "/memory") return showMemory(event.channel);
  return post(
    event.channel,
    event.command === "/start" ? REPLY.greeting : REPLY.unknownCommand,
  );
}

/**
 * Commands come from every chat with the bot, and the allowlist checks only their author: in a
 * group the owner's memory would reach the other members. A private chat has the id of its user,
 * a group a negative one.
 */
async function showMemory(
  channel: SlashCommandEvent["channel"],
): Promise<void> {
  if (channel.id !== `telegram:${config.TELEGRAM_OWNER_ID}`) {
    return post(channel, REPLY.privateOnly);
  }
  const memory = await listActive();
  if (memory instanceof Error) return fail(channel, memory);
  for (const part of splitByLines(memoryText(memory), MESSAGE_MAX)) {
    await post(channel, part);
  }
}

function memoryText(memory: { core: CoreFact[]; entries: Entry[] }): string {
  const core = grouped(
    CORE_SECTIONS,
    memory.core,
    (fact) => fact.section,
    (fact) => fact.text,
  );
  const entries = grouped(
    ENTRY_KINDS,
    memory.entries,
    (entry) => entry.kind,
    (entry) => `${entry.title} — ${entry.text}`,
  );
  return [
    "Ядро",
    ...(core.length > 0 ? core : ["пусто"]),
    "Записи",
    ...(entries.length > 0 ? entries : ["пусто"]),
  ].join("\n");
}

function grouped<T, K>(
  groups: [K, string][],
  items: T[],
  keyOf: (item: T) => K,
  textOf: (item: T) => string,
): string[] {
  return groups.flatMap(([key, label]) => {
    const inGroup = items.filter((item) => keyOf(item) === key);
    return inGroup.length === 0
      ? []
      : [`${label}:`, ...inGroup.map((item) => `• ${textOf(item)}`)];
  });
}

function splitByLines(text: string, limit: number): string[] {
  const parts: string[] = [];
  let part = "";
  for (const line of text.split("\n")) {
    if (part && part.length + 1 + line.length > limit) {
      parts.push(part);
      part = line;
    } else {
      part = part ? `${part}\n${line}` : line;
    }
  }
  parts.push(part);
  return parts;
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
