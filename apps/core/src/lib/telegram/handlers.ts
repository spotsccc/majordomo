/**
 * Handlers of the Telegram bot (`./bot.ts`): the owner's messages and slash
 * commands. A handler never throws: Chat SDK would only log the error, and
 * the owner would get no answer. A failure is logged, marked on the turn when
 * the turn has started, and answered with a short message.
 */
import { createXai } from "@ai-sdk/xai";
import { isLoginRequired } from "@repo/openai-subscription";
import { transcribe, type UIMessage } from "ai";
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

/** What the bot says to the owner besides the agent's answers. */
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

/**
 * The largest voice message the bot transcribes: the Bot API does not hand
 * out larger files (`getFile`), so a larger one is turned down before the
 * download.
 */
const VOICE_MAX_BYTES = 20 * 2 ** 20;

/** How long a transcription may take, the download excluded. */
const TRANSCRIBE_TIMEOUT_MS = 30_000;

/**
 * Answers a series of the owner's messages: one message, or the messages
 * that queued up while the previous turn ran, oldest first. Each message
 * with text, a voice message or both becomes a message of one agent turn, in
 * the order of the series. Other attachments (photos, files, stickers) are
 * skipped. The owner gets a short notice for a skipped attachment and for a
 * voice message that was not transcribed, once per kind and before the
 * answer; a series with nothing left gets only the notices.
 */
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

/**
 * The text of the owner's message for the agent and the notices for the
 * owner. The text is the transcript of a voice message (`type: "audio"`),
 * then the message's own text or caption, separated by a blank line; empty
 * when there is neither. Without `XAI_API_KEY` or over `VOICE_MAX_BYTES` a
 * voice message is not downloaded. A failed transcription is logged; the
 * transcript itself is not, it is the owner's speech.
 */
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

/**
 * Downloads a voice message from Telegram and transcribes it with xAI. The
 * audio goes as it is, OGG/Opus for a voice message: xAI detects the format.
 * Returns an `Error` when the download fails, xAI fails or times out, or the
 * transcript is empty (`transcribe` throws `NoTranscriptGeneratedError`).
 * `transcribe` retries a 5xx and a 429 twice.
 */
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
 * Runs the agent over the conversation and posts its answer to Telegram.
 *
 * The Telegram adapter streams the answer by posting a "..." placeholder and
 * editing it about once a second; the placeholder stays when the stream has
 * no text. Chat SDK skips `error` parts of the stream, so `thread.post`
 * succeeds even when the model fails. How the turn ended therefore comes
 * from `onError` of the turn, which gets every model failure with its type,
 * and from a rejected `thread.post`, which is how a broken transport stream
 * or a Telegram failure shows up. A missing or dead ChatGPT session marks the
 * turn `awaiting_login`. Another failure marks it `failed` and keeps the text
 * that reached Telegram, with a note that the answer was cut off. Both
 * replace the placeholder instead of leaving it in the chat.
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

  const sent = await thread.post(turn.fullStream).catch((error: unknown) => {
    failure ??= error;
    return undefined;
  });
  const text = await turn.text.then(
    (value) => value,
    () => "",
  );

  if (failure === undefined) {
    const finished = await finishTurn(turnId, {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text }],
    });
    if (finished instanceof Error) {
      console.error("Telegram: ответ агента не сохранён в истории", finished);
    }
    return;
  }

  if (isLoginRequired(failure)) {
    const marked = await awaitLogin(turnId);
    if (marked instanceof Error) {
      console.error("Telegram: ожидание входа не записано", marked);
    }
    return replace(thread, sent, REPLY.loginRequired);
  }

  const error = toError(failure);
  console.error("Telegram: ход агента не удался", error);
  const failed = await failTurn(turnId, error);
  if (failed instanceof Error) {
    console.error("Telegram: сбой хода не записан", failed);
  }
  return replace(
    thread,
    sent,
    text ? { markdown: `${text}\n\n${REPLY.cutOff}` } : REPLY.failed,
  );
}

/**
 * Slash commands. Chat SDK hands every message that starts with `/` to them,
 * not to `onDirectMessage`, and ignores the command without a handler.
 * `/new` closes the conversation, so the next message opens a new one;
 * `/start` greets; any other command gets a short reply rather than silence.
 *
 * The event carries a channel but no thread. The Telegram adapter gives the
 * channel the thread id of the command's message (`telegram:<chat_id>`, with
 * the topic when there is one), the same key the conversation of the owner's
 * messages has.
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

/**
 * The owner's message for the history with `text`, its text and the
 * transcript of its voice message. Telegram's message id goes to the
 * metadata for reference only: the history is ordered by `seq`.
 */
function toUIMessage(message: Message, text: string): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    metadata: { telegramMessageId: message.id },
    parts: [{ type: "text", text }],
  };
}

/**
 * Handles a failure outside the model: logs it, marks the turn `failed` when
 * it has started, and tells the owner.
 */
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

/**
 * Replaces the streamed message, its "..." placeholder or a cut-off answer,
 * with `content`; posts `content` when nothing was sent.
 */
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

/** Sends a message. A failure is only logged: there is nobody else to tell. */
async function post(target: Postable, message: string): Promise<void> {
  const sent = await target.post(message).catch(toError);
  if (sent instanceof Error) {
    console.error("Telegram: сообщение не отправлено", sent);
  }
}

/** A thrown value as an `Error`, keeping the original one when it is an `Error`. */
function toError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error("Сбой без объекта ошибки", { cause: value });
}
