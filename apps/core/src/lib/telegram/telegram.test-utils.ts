/**
 * Telegram for tests: a fake Bot API behind `vi.stubGlobal("fetch", ...)`,
 * webhook updates of the owner and of strangers, their delivery to a bot,
 * and the conversations the bot saved. Shared by the webhook route, handler
 * and bot tests.
 */
import type { TelegramMessage, TelegramUpdate } from "@chat-adapter/telegram";
import { conversations, messages, turns } from "@repo/db";
import type { WebhookOptions } from "chat";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { vi } from "vitest";
import { z } from "zod";
import { urlOf } from "../chatgpt.test-utils";
import { config } from "../config";
import { db } from "../db";

/** Where the adapter sends the Bot API requests of the test bot. */
const BOT_API = `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/`;

/** Where the adapter downloads the files that `getFile` points to. */
const FILE_API = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/`;

/** The content of every file the fake serves: the start of an OGG stream, as in a voice message. */
export const VOICE_BYTES = new Uint8Array([
  0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00,
]);

/** The owner's Telegram user id, `TELEGRAM_OWNER_ID` of the test environment. */
export const OWNER_ID = Number(config.TELEGRAM_OWNER_ID);

/** A Telegram user the bot must not answer. */
export const STRANGER_ID = 777;

const BOT_USER = {
  id: 4242,
  is_bot: true,
  first_name: "Majordomo",
  username: config.TELEGRAM_BOT_USERNAME,
};

/** The fields of a Bot API request that the fake reads. */
const BotApiParams = z.object({
  chat_id: z.coerce.number().optional(),
  file_id: z.string().optional(),
  message_id: z.number().optional(),
  text: z.string().optional(),
  parse_mode: z.string().optional(),
  rich_message: z.object({ markdown: z.string() }).optional(),
});

/** What the owner sees of a request's text: rich markdown as is, MarkdownV2 unescaped. */
function visibleText(params: z.infer<typeof BotApiParams>): string {
  if (params.rich_message) return params.rich_message.markdown;
  const text = params.text ?? "";
  return params.parse_mode === "MarkdownV2"
    ? text.replace(/\\(.)/g, "$1")
    : text;
}

function ok(result: unknown): Response {
  return Response.json({ ok: true, result });
}

/**
 * The Bot API of the test bot, at the protocol level: it keeps the bot's
 * messages in each chat with their final text after edits, which is what the
 * owner sees. Every file it serves holds `VOICE_BYTES`; `downloads` counts
 * them. Methods it does not implement are recorded in `unhandled` and
 * answered 404, so a test can fail on them instead of the adapter logging
 * them away.
 */
export class FakeTelegram {
  readonly unhandled: string[] = [];
  downloads = 0;
  private readonly chats = new Map<number, { id: number; text: string }[]>();
  private nextMessageId = 1;

  /** Whether `url` is a Bot API request or a file download of the test bot. */
  handles(url: string): boolean {
    return url.startsWith(BOT_API) || url.startsWith(FILE_API);
  }

  /** The Bot API response to a request of the adapter. */
  answer(url: string, init?: RequestInit): Response {
    if (url.startsWith(FILE_API)) {
      this.downloads += 1;
      return new Response(VOICE_BYTES);
    }
    const method = url.slice(BOT_API.length);
    const params = BotApiParams.parse(
      typeof init?.body === "string" ? JSON.parse(init.body) : {},
    );
    const chat = this.messagesIn(params.chat_id ?? 0);
    switch (method) {
      case "getMe":
        return ok(BOT_USER);
      case "sendChatAction":
        return ok(true);
      case "getFile":
        return ok({
          file_id: params.file_id,
          file_unique_id: `unique-${params.file_id}`,
          file_size: VOICE_BYTES.length,
          file_path: `voice/${params.file_id}.oga`,
        });
      case "sendMessage":
      case "sendRichMessage": {
        const sent = { id: this.nextMessageId++, text: visibleText(params) };
        chat.push(sent);
        return ok(this.raw(params.chat_id ?? 0, sent));
      }
      case "editMessageText": {
        const edited = chat.find((message) => message.id === params.message_id);
        if (!edited) {
          return Response.json(
            {
              ok: false,
              error_code: 400,
              description: "Bad Request: message to edit not found",
            },
            { status: 400 },
          );
        }
        edited.text = visibleText(params);
        return ok(this.raw(params.chat_id ?? 0, edited));
      }
      default:
        this.unhandled.push(method);
        return Response.json(
          { ok: false, error_code: 404, description: "Not Found" },
          { status: 404 },
        );
    }
  }

  /** The bot's messages in chat `chatId` as the owner sees them, oldest first. */
  textsIn(chatId: number): string[] {
    return this.messagesIn(chatId).map((message) => message.text);
  }

  private messagesIn(chatId: number): { id: number; text: string }[] {
    const chat = this.chats.get(chatId) ?? [];
    this.chats.set(chatId, chat);
    return chat;
  }

  private raw(
    chatId: number,
    message: { id: number; text: string },
  ): TelegramMessage {
    return {
      message_id: message.id,
      date: 0,
      chat: { id: chatId, type: "private" },
      from: BOT_USER,
      text: message.text,
    };
  }
}

/**
 * Stubs `fetch`: requests to the Bot API of the test bot go to `telegram`,
 * every other request (Codex, auth.openai.com, xAI) to `other`.
 */
export function stubNetwork(
  telegram: FakeTelegram,
  other: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      return telegram.handles(url)
        ? telegram.answer(url, init)
        : other(url, init);
    },
  );
}

let nextUpdateId = 1;

/** A private message to the bot in chat `chatId`, from the owner unless `from` says otherwise. */
function update(
  chatId: number,
  content: Partial<TelegramMessage>,
  from = OWNER_ID,
): TelegramUpdate {
  const id = nextUpdateId++;
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: chatId, type: "private", first_name: "Owner" },
      from: { id: from, is_bot: false, first_name: "Owner" },
      ...content,
    },
  };
}

/** A text message in chat `chatId`. */
export function textMessage(
  chatId: number,
  text: string,
  from = OWNER_ID,
): TelegramUpdate {
  return update(chatId, { text }, from);
}

/** A slash command such as `/new`, marked as one the way Telegram marks it. */
export function commandMessage(
  chatId: number,
  command: string,
): TelegramUpdate {
  return update(chatId, {
    text: command,
    entities: [{ type: "bot_command", offset: 0, length: command.length }],
  });
}

/** A photo, with `caption` when it is given. */
export function photoMessage(chatId: number, caption?: string): TelegramUpdate {
  return update(chatId, {
    photo: [
      { file_id: "photo-1", file_unique_id: "p1", width: 90, height: 90 },
    ],
    caption,
  });
}

/**
 * A voice message of `size` bytes (the size of `VOICE_BYTES` by default),
 * with `caption` when it is given.
 */
export function voiceMessage(
  chatId: number,
  {
    caption,
    size = VOICE_BYTES.length,
  }: { caption?: string; size?: number } = {},
): TelegramUpdate {
  return update(chatId, {
    voice: {
      file_id: "voice-1",
      file_unique_id: "v1",
      duration: 3,
      mime_type: "audio/ogg",
      file_size: size,
    },
    caption,
  });
}

/**
 * The webhook request Telegram sends with `body`, signed with the configured
 * secret token unless `secret` gives another one or `null` for none.
 */
export function webhookRequest(
  body: TelegramUpdate | string,
  secret: string | null = config.TELEGRAM_WEBHOOK_SECRET ?? null,
): Request {
  return new Request("https://example.test/api/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret === null ? {} : { "x-telegram-bot-api-secret-token": secret }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A bot as tests use it: its webhook entry point. */
type WebhookBot = {
  webhooks: {
    telegram: (request: Request, options?: WebhookOptions) => Promise<Response>;
  };
};

/**
 * Delivers `update` to `bot` and returns at once with the webhook response
 * and a promise that settles when the bot has handled the update, including
 * the work it schedules while handling it.
 */
export async function deliverInBackground(
  bot: WebhookBot,
  update: TelegramUpdate,
): Promise<{ response: Response; handled: Promise<void> }> {
  const tasks: Promise<unknown>[] = [];
  const response = await bot.webhooks.telegram(webhookRequest(update), {
    waitUntil: (task) => {
      tasks.push(task);
    },
  });
  const handled = (async () => {
    for (let index = 0; index < tasks.length; index += 1) await tasks[index];
  })();
  return { response, handled };
}

/** Delivers `update` to `bot` and waits until the bot has handled it. */
export async function deliver(
  bot: WebhookBot,
  update: TelegramUpdate,
): Promise<Response> {
  const { response, handled } = await deliverInBackground(bot, update);
  await handled;
  return response;
}

/**
 * Forgets everything the bots have seen: the Chat SDK state (dedupe keys,
 * locks, queues), which outlives a test file in the shared database, and the
 * conversations. The Chat SDK tables exist only once a bot has connected.
 */
export async function resetChats(): Promise<void> {
  await db.execute(sql`
    DO $$ BEGIN
      IF to_regclass('public.chat_state_cache') IS NOT NULL THEN
        TRUNCATE chat_state_subscriptions, chat_state_locks, chat_state_cache,
          chat_state_lists, chat_state_queues;
      END IF;
    END $$`);
  await db.delete(turns);
  await db.delete(messages);
  await db.delete(conversations);
}

/** The status and error of each turn in chat `chatId`, oldest first. */
export async function turnsIn(
  chatId: number,
): Promise<{ status: string; error: string | null }[]> {
  return db
    .select({ status: turns.status, error: turns.error })
    .from(turns)
    .innerJoin(conversations, eq(turns.conversationId, conversations.id))
    .where(eq(conversations.externalId, `telegram:${chatId}`))
    .orderBy(asc(turns.startedAt));
}

/** The text of each message in the open conversation of chat `chatId`, oldest first. */
export async function historyIn(chatId: number): Promise<string[]> {
  const rows = await db
    .select({ uiMessage: messages.uiMessage })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.externalId, `telegram:${chatId}`),
        isNull(conversations.closedAt),
      ),
    )
    .orderBy(asc(messages.seq));
  return rows.map((row) =>
    row.uiMessage.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(""),
  );
}
