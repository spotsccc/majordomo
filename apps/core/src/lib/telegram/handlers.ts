/**
 * Handlers of the Telegram bot (`./bot.ts`): the owner's messages and slash
 * commands. A handler never throws: Chat SDK would only log the error, and
 * the owner would get no answer. A failure is logged, marked on the turn when
 * the turn has started, and answered with a short message.
 */
import { isLoginRequired } from "@repo/openai-subscription";
import type { UIMessage } from "ai";
import type {
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

/** What the bot says to the owner besides the agent's answers. */
const REPLY = {
  failed: "Не получилось ответить, попробуйте ещё раз.",
  cutOff: "⚠️ Ответ оборвался, попробуйте ещё раз.",
  loginRequired: "Нужно войти в ChatGPT: войдите в веб-версии Majordomo.",
  textOnly: "Пока понимаю только текст.",
  newConversation: "Начали новый диалог.",
  greeting:
    "Привет! Я Majordomo. Пишите, что нужно; /new начинает новый диалог.",
  unknownCommand: "Не знаю такой команды. /new начинает новый диалог.",
};

/**
 * Answers a series of the owner's messages: one message, or the messages
 * that queued up while the previous turn ran, oldest first. The text messages
 * become one turn of the agent. Anything else (voice, photos, files,
 * stickers) gets one short reply and stays out of the history.
 */
export async function handleOwnerMessages(
  thread: Thread,
  series: Message[],
): Promise<void> {
  const texts = series.filter(
    (message) => message.attachments.length === 0 && message.text.trim() !== "",
  );
  if (texts.length < series.length) await post(thread, REPLY.textOnly);
  const [first, ...rest] = texts.map(toUIMessage);
  if (!first) return;

  const conversationId = await openTelegramConversation(thread.id);
  if (conversationId instanceof Error) return fail(thread, conversationId);
  const turnId = await beginTurn(conversationId, [first, ...rest]);
  if (turnId instanceof Error) return fail(thread, turnId);

  await answerTurn(thread, conversationId, turnId);
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
 * The event carries the channel but no thread, while conversations are keyed
 * by the thread id of the owner's messages. In a private chat without topics
 * both are `telegram:<chat_id>`. The bot answers only private chats, and
 * topics stay off in @BotFather: with them `/new` would find no conversation
 * and do nothing.
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
 * The owner's text message for the history. Telegram's message id goes to
 * the metadata for reference only: the history is ordered by `seq`.
 */
function toUIMessage(message: Message): UIMessage {
  return {
    id: crypto.randomUUID(),
    role: "user",
    metadata: { telegramMessageId: message.id },
    parts: [{ type: "text", text: message.text }],
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
